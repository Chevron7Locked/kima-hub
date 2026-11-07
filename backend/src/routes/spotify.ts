import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import { createRateLimiter } from "../middleware/rateLimiter";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { ACQUIRE_REFUSED, mayAcquire } from "../utils/acquirePermission";
import { safeError } from "../utils/errors";
import { z } from "zod";
import { spotifyImportService, getImportJob } from "../services/spotifyImport";
import { parseM3U } from "../services/m3uParser";
import { recogniseMusicLink, MusicLink, MusicPlatform } from "../services/musicLink";

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

const parseUrlSchema = z.object({
    url: z.string().url(),
});

const importSchema = z.object({
    spotifyPlaylistId: z.string(),
    playlistName: z.string().min(1).max(200),
    albumMbidsToDownload: z.array(z.string()),
    // The web and the app both make a preview first; the import is built from it.
    previewJobId: z.string(),
});

const quickImportSchema = z.object({
    url: z.string().url(),
    playlistName: z.string().min(1).max(200).optional(),
});

// The sites a playlist can be imported from.
const IMPORT_PLATFORMS: ReadonlySet<MusicPlatform> = new Set([
    "spotify",
    "deezer",
    "youtube",
    "youtubeMusic",
    "soundcloud",
    "mixcloud",
]);

// What a quick import also needs of the address: the start of its path, per site. A site missing here takes any path.
const QUICK_IMPORT_PATHS: Partial<Record<MusicPlatform, string[]>> = {
    spotify: ["/playlist/"],
    deezer: ["/playlist/", "/playlist:"],
    youtube: ["/playlist", "/watch"],
    youtubeMusic: ["/playlist", "/watch"],
};

const INVALID_URL = "Invalid URL. Supported: Spotify, Deezer, YouTube, SoundCloud, Mixcloud.";

/** The address as a music link on a site playlists can be imported from, or null. */
function importableLink(raw: string): MusicLink | null {
    const link = recogniseMusicLink(raw);
    return link && IMPORT_PLATFORMS.has(link.platform) ? link : null;
}

/** The address as a music link that a quick import can start from, or null. */
function quickImportableLink(raw: string): MusicLink | null {
    const link = importableLink(raw);
    if (!link || link.domain === "youtu.be") return link;
    const paths = QUICK_IMPORT_PATHS[link.platform];
    const { pathname } = new URL(link.url);
    return !paths || paths.some((start) => pathname.startsWith(start)) ? link : null;
}

/** A bad body is the request's (400); anything else is the server's. */
function answerFailure(res: Response, context: string, error: unknown) {
    if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid request body" });
    }
    safeError(res, context, error);
}

/** The caller's import job named by `:jobId`, or null once 404 (gone) or 403 (someone else's) is sent. */
async function ownImportJob(req: Request, res: Response, action: string) {
    const job = await getImportJob(req.params.jobId);
    if (!job) {
        res.status(404).json({ error: "Import job not found" });
        return null;
    }
    if (job.userId !== req.user!.id) {
        res.status(403).json({ error: `Not authorized to ${action} this job` });
        return null;
    }
    return job;
}

/**
 * POST /api/spotify/preview/start
 * Start a background preview job and return a job ID immediately.
 * Progress is streamed via SSE (preview:progress / preview:complete).
 */
router.post("/preview/start", async (req, res) => {
    try {
        const { url } = parseUrlSchema.parse(req.body);

        const link = importableLink(url);
        if (!link) {
            return res.status(400).json({ error: INVALID_URL });
        }

        logger.debug(`[Playlist Import] Starting preview job for: ${link.url}`);
        const { jobId } = await spotifyImportService.startPreviewJob(link.url, req.user!.id);
        res.json({ jobId });
    } catch (error) {
        answerFailure(res, "Playlist preview start", error);
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

        const link = quickImportableLink(url);
        if (!link) {
            return res.status(400).json({ error: INVALID_URL });
        }

        const { jobId } = await spotifyImportService.quickImport(link.url, req.user!.id, playlistName);

        res.json({ jobId });
    } catch (error) {
        answerFailure(res, "Quick import", error);
    }
});

/**
 * POST /api/spotify/import
 * Start importing a Spotify playlist
 */
router.post("/import", async (req, res) => {
    try {
        const { spotifyPlaylistId, playlistName, albumMbidsToDownload, previewJobId } =
            importSchema.parse(req.body);
        const userId = req.user!.id;
        // Matching the playlist to the library is open to everyone; downloading its missing albums is not.
        if (albumMbidsToDownload.length > 0 && !(await mayAcquire(req.user!))) {
            return res.status(403).json({ error: ACQUIRE_REFUSED });
        }

        const stored = await spotifyImportService.getPreviewResult(previewJobId);
        if (!stored || stored.status !== "completed" || !stored.preview) {
            return res.status(400).json({
                error: "Preview not ready or expired. Please generate a new preview.",
            });
        }
        if (stored.userId && stored.userId !== userId) {
            return res.status(403).json({ error: "Not authorized to use this preview" });
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
            stored.preview
        );

        res.json({
            jobId: job.id,
            status: job.status,
            message: "Import started",
        });
    } catch (error) {
        answerFailure(res, "Spotify import", error);
    }
});

/**
 * GET /api/spotify/import/:jobId/status
 * Get the status of an import job
 */
router.get("/import/:jobId/status", async (req, res) => {
    try {
        const job = await ownImportJob(req, res, "view");
        if (!job) return;

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
        const job = await ownImportJob(req, res, "refresh");
        if (!job) return;

        const result = await spotifyImportService.refreshJobMatches(job.id);

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
        const job = await ownImportJob(req, res, "cancel");
        if (!job) return;

        const result = await spotifyImportService.cancelJob(job.id);

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
