import { Router } from "express";
import multer from "multer";
import path from "path";
import { createRateLimiter } from "../middleware/rateLimiter";
import { withRetry } from "../utils/async";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { ACQUIRE_REFUSED, mayAcquire } from "../utils/acquirePermission";
import { safeError } from "../utils/errors";
import { z } from "zod";
import { spotifyService } from "../services/spotify";
import { spotifyImportService, getImportJob } from "../services/spotifyImport";
import { deezerService } from "../services/deezer";
import { parseM3U } from "../services/m3uParser";

const router = Router();

const m3uUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if ([".m3u", ".m3u8"].includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error("Only .m3u and .m3u8 files are accepted"));
        }
    },
});

// All routes require authentication
router.use(requireAuthOrToken);

// Validation schemas
const parseUrlSchema = z.object({
    url: z.string().url(),
});

const importSchema = z.object({
    spotifyPlaylistId: z.string(),
    url: z.string().url().optional(),
    playlistName: z.string().min(1).max(200),
    albumMbidsToDownload: z.array(z.string()),
    previewJobId: z.string().optional(),
});

const quickImportSchema = z.object({
    url: z.string().url(),
    playlistName: z.string().min(1).max(200).optional(),
});

// Every supported playlist source, with the URL shape the quick import accepts;
// the preview check only needs the domain half of each pair.
const PLAYLIST_URL_PREFIXES: Array<[string, string]> = [
    ["spotify.com", "/playlist/"],
    ["deezer.com", "/playlist/"],
    ["deezer.com", "/playlist:"],
    ["youtube.com", "/playlist"],
    ["music.youtube.com", "/playlist"],
    ["youtube.com", "/watch"],
    ["youtu.be", "/"],
    ["soundcloud.com", "/"],
    ["bandcamp.com", "/"],
    ["mixcloud.com", "/"],
];

/**
 * POST /api/spotify/parse
 * Parse a Spotify URL and return basic info
 */
router.post("/parse", async (req, res) => {
    try {
        const { url } = parseUrlSchema.parse(req.body);

        const parsed = spotifyService.parseUrl(url);
        if (!parsed) {
            return res.status(400).json({
                error: "Invalid Spotify URL. Please provide a valid playlist URL.",
            });
        }

        // Only playlists can be imported
        if (parsed.type !== "playlist") {
            return res.status(400).json({
                error: `Only playlist imports are supported. Got: ${parsed.type}`,
            });
        }

        res.json({
            type: parsed.type,
            id: parsed.id,
            url: `https://open.spotify.com/playlist/${parsed.id}`,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request body" });
        }
        safeError(res, "Spotify parse", error);
    }
});

/**
 * POST /api/spotify/preview/start
 * Start a background preview job and return a job ID immediately.
 * Progress is streamed via SSE (preview:progress / preview:complete).
 */
router.post("/preview/start", async (req, res) => {
    try {
        const { url } = parseUrlSchema.parse(req.body);

        if (!PLAYLIST_URL_PREFIXES.some(([domain]) => url.includes(domain))) {
            return res.status(400).json({
                error: "Invalid URL. Supported: Spotify, Deezer, YouTube, SoundCloud, Bandcamp, Mixcloud.",
            });
        }

        logger.debug(`[Playlist Import] Starting preview job for: ${url}`);
        const { jobId } = await spotifyImportService.startPreviewJob(url, req.user!.id);
        res.json({ jobId });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request body" });
        }
        safeError(res, "Playlist preview start", error);
    }
});

/**
 * GET /api/spotify/preview/:jobId
 * Poll for a completed preview result stored in Redis.
 * Returns { status: "pending" } while the background job is still running.
 */
router.get("/preview/:jobId", async (req, res) => {
    try {
        const { jobId } = req.params;
        const result = await spotifyImportService.getPreviewResult(jobId);
        if (!result) {
            return res.json({ status: "pending" });
        }
        if (result.userId && result.userId !== req.user!.id) {
            return res.status(403).json({ error: "Not authorized to view this preview" });
        }
        res.json(result);
    } catch (error) {
        safeError(res, "Playlist preview fetch", error);
    }
});

/**
 * POST /api/spotify/import/quick
 * Fire-and-forget import: skip preview, fetch + match + download all in background
 */
router.post("/import/quick", async (req, res) => {
    try {
        const { url, playlistName } = quickImportSchema.parse(req.body);

        if (!PLAYLIST_URL_PREFIXES.some(([domain, path]) => url.includes(domain + path))) {
            return res.status(400).json({
                error: "Invalid URL. Supported: Spotify, Deezer, YouTube, SoundCloud, Bandcamp, Mixcloud.",
            });
        }

        const { jobId } = await spotifyImportService.quickImport(url, req.user!.id, playlistName);

        res.json({ jobId });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request body" });
        }
        safeError(res, "Quick import", error);
    }
});

/**
 * POST /api/spotify/import
 * Start importing a Spotify playlist
 */
router.post("/import", async (req, res) => {
    try {
        const { spotifyPlaylistId, url, playlistName, albumMbidsToDownload, previewJobId } =
            importSchema.parse(req.body);
        const userId = req.user!.id;
        // Matching the playlist to the library is open to everyone; downloading its missing albums is not.
        if (albumMbidsToDownload.length > 0 && !(await mayAcquire(req.user!))) {
            return res.status(403).json({ error: ACQUIRE_REFUSED });
        }

        let preview;
        if (previewJobId) {
            const stored = await spotifyImportService.getPreviewResult(previewJobId);
            if (!stored || stored.status !== "completed" || !stored.preview) {
                return res.status(400).json({
                    error: "Preview not ready or expired. Please generate a new preview.",
                });
            }
            if (stored.userId && stored.userId !== userId) {
                return res.status(403).json({ error: "Not authorized to use this preview" });
            }
            preview = stored.preview;
        } else {
            // No preview job: build the preview now
            const effectiveUrl =
                url?.trim() ||
                `https://open.spotify.com/playlist/${spotifyPlaylistId}`;

            if (effectiveUrl.includes("deezer.com")) {
                const deezerMatch = effectiveUrl.match(/playlist[\/:](\d+)/);
                if (!deezerMatch) {
                    return res
                        .status(400)
                        .json({ error: "Invalid Deezer playlist URL" });
                }
                const playlistId = deezerMatch[1];
                const deezerPlaylist = await withRetry(() => deezerService.getPlaylist(playlistId));
                if (!deezerPlaylist) {
                    return res
                        .status(404)
                        .json({ error: "Deezer playlist not found" });
                }
                preview = await spotifyImportService.generatePreviewFromDeezer(deezerPlaylist);
            } else if (spotifyImportService.isExternalPlatformUrl(effectiveUrl)) {
                preview = await spotifyImportService.generatePreviewFromExternalPlatform(effectiveUrl);
            } else {
                preview = await spotifyImportService.generatePreview(effectiveUrl);
            }
        }

        logger.debug(
            `[Spotify Import] Starting import for user ${userId}: ${playlistName}`
        );
        logger.debug(
            `[Spotify Import] Downloading ${albumMbidsToDownload.length} albums`
        );

        const job = await spotifyImportService.startImport(
            userId,
            spotifyPlaylistId,
            playlistName,
            albumMbidsToDownload,
            preview
        );

        res.json({
            jobId: job.id,
            status: job.status,
            message: "Import started",
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request body" });
        }
        safeError(res, "Spotify import", error);
    }
});

/**
 * GET /api/spotify/import/:jobId/status
 * Get the status of an import job
 */
router.get("/import/:jobId/status", async (req, res) => {
    try {
        const { jobId } = req.params;
        const userId = req.user!.id;

        const job = await getImportJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to view this job" });
        }

        res.json(job);
    } catch (error) {
        safeError(res, "Spotify job status", error);
    }
});

/**
 * GET /api/spotify/imports
 * Get all import jobs for the current user
 */
router.get("/imports", async (req, res) => {
    try {
        const userId = req.user!.id;
        const jobs = await spotifyImportService.getUserJobs(userId);
        res.json(jobs);
    } catch (error) {
        safeError(res, "Spotify imports", error);
    }
});

/**
 * POST /api/spotify/import/:jobId/refresh
 * Re-match pending tracks and add newly downloaded ones to the playlist
 */
router.post("/import/:jobId/refresh", async (req, res) => {
    try {
        const { jobId } = req.params;
        const userId = req.user!.id;

        const job = await getImportJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to refresh this job" });
        }

        const result = await spotifyImportService.refreshJobMatches(jobId);

        res.json({
            message:
                result.added > 0
                    ? `Added ${result.added} newly downloaded track(s)`
                    : "No new tracks found yet. Albums may still be downloading.",
            added: result.added,
            total: result.total,
        });
    } catch (error) {
        safeError(res, "Spotify refresh", error);
    }
});

/**
 * POST /api/spotify/import/:jobId/cancel
 * Cancel an import job and clean up all artifacts
 */
router.post("/import/:jobId/cancel", async (req, res) => {
    try {
        const { jobId } = req.params;
        const userId = req.user!.id;

        const job = await getImportJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to cancel this job" });
        }

        const result = await spotifyImportService.cancelJob(jobId);

        res.json({
            message: result.playlistCreated
                ? `Import cancelled. Playlist created with ${result.tracksMatched} track(s).`
                : "Import cancelled.",
            playlistId: result.playlistId,
            tracksMatched: result.tracksMatched,
        });
    } catch (error) {
        safeError(res, "Spotify cancel", error);
    }
});

const m3uImportLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: "Too many M3U imports, please wait a minute" },
});

/**
 * POST /api/spotify/import/m3u
 * Upload an M3U file, parse it, match tracks against library, create playlist.
 */
router.post("/import/m3u", m3uImportLimiter, (req, res, next) => {
    m3uUpload.single("file")(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const playlistName = req.body.playlistName?.trim();
        if (!playlistName || playlistName.length > 200) {
            return res.status(400).json({ error: "playlistName is required (1-200 chars)" });
        }

        const content = req.file.buffer.toString("utf-8");
        const entries = parseM3U(content);

        if (entries.length === 0) {
            return res.status(400).json({ error: "M3U file contains no entries" });
        }

        const result = await spotifyImportService.importFromM3U(
            req.user!.id,
            playlistName,
            entries,
        );

        res.json(result);
    } catch (error: any) {
        if (error.message?.includes("exceeds maximum") || error.message?.includes("null bytes")) {
            return res.status(400).json({ error: error.message });
        }
        safeError(res, "M3U import", error);
    }
});

export default router;
