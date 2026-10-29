import { Router } from "express";
import * as fs from "fs";
import { logger } from "../utils/logger";
import { safeError, UserFacingError } from "../utils/errors";
import { audiobookCacheService } from "../services/audiobookCache";
import { audiobookshelfService } from "../services/audiobookshelf";
import { prisma } from "../utils/db";
import { requireAuthOrToken } from "../middleware/auth";
import { apiLimiter } from "../middleware/rateLimiter";
import { getSystemSettings } from "../utils/systemSettings";
import { config } from "../config";
import { resolveWithinMusicRoot } from "./library/trackPath";
import { artistSortName } from "../services/artistIdentity";
import { upstreamHeader } from "../utils/upstreamHeaders";
import type { Audiobook, AudiobookProgress } from "@prisma/client";

/**
 * Access-Control-Allow-Origin for a cover or stream response, using the same
 * allowlist as the global CORS middleware instead of reflecting Origin.
 * Returns `fallback` with no Origin header, null for a disallowed origin (omit
 * the CORS headers then). Shared with routes/podcasts.ts.
 */
export function resolveCorsOrigin(
    reqOrigin: string | undefined,
    fallback: string = "*"
): string | null {
    if (!reqOrigin) return fallback;
    if (config.allowedOrigins === true || config.nodeEnv === "development") {
        return reqOrigin;
    }
    if (Array.isArray(config.allowedOrigins)) {
        if (config.allowedOrigins.length === 0) {
            // No restriction configured - self-hosted default (matches global CORS)
            return reqOrigin;
        }
        return config.allowedOrigins.includes(reqOrigin) ? reqOrigin : null;
    }
    return null;
}

const router = Router();

// The id goes into requests made with Audiobookshelf's key, and Express has already decoded any %2F in it: only
// what an Audiobookshelf id can be (letters, digits, "_", "-") is let through.
router.param("id", (_req, res, next, id: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        return res.status(404).json({ error: "Audiobook not found" });
    }
    next();
});

/** The progress sub-object every audiobook response carries, in one shape. */
function progressDto(progress: AudiobookProgress) {
    return {
        currentTime: progress.currentTime,
        progress:
            progress.duration > 0
                ? (progress.currentTime / progress.duration) * 100
                : 0,
        isFinished: progress.isFinished,
        lastPlayedAt: progress.lastPlayedAt,
    };
}

/** One audiobook row as the clients read it; the series sub-object rides along. */
function toAudiobookDto(book: Audiobook, progress: AudiobookProgress | null) {
    return {
        id: book.id,
        title: book.title,
        author: book.author || "Unknown Author",
        narrator: book.narrator,
        description: book.description,
        // The /audiobooks/:id/cover endpoint finds the file on disk even when
        // localCoverPath is not set.
        coverUrl:
            book.localCoverPath || book.coverUrl
                ? `/audiobooks/${book.id}/cover`
                : null,
        duration: book.duration || 0,
        libraryId: book.libraryId,
        series: book.series
            ? {
                  name: book.series,
                  // Article-stripped series name for client-side series sorting;
                  // computed per response because nothing sorts by it in SQL.
                  sortName: artistSortName(book.series),
                  sequence: book.seriesSequence || "1",
              }
            : null,
        genres: book.genres || [],
        ...(book.tracksJson != null && { tracks: book.tracksJson }),
        ...(book.numTracks != null && { trackCount: book.numTracks }),
        progress: progress ? progressDto(progress) : null,
    };
}

/**
 * GET /audiobooks/continue-listening
 * Get audiobooks the user is currently listening to (for "Continue Listening" section)
 * NOTE: This must come BEFORE the /:id route to avoid matching "continue-listening" as an ID
 */
router.get(
    "/continue-listening",
    requireAuthOrToken,
    apiLimiter,
    async (req, res) => {
        try {
            const settings = await getSystemSettings();

            if (!settings?.audiobookshelfEnabled) {
                return res.status(200).json([]);
            }

            const recentProgress = await prisma.audiobookProgress.findMany({
                where: {
                    userId: req.user!.id,
                    isFinished: false,
                    currentTime: {
                        gt: 0,
                    },
                },
                orderBy: {
                    lastPlayedAt: "desc",
                },
                take: 10,
            });

            // Transform the cover URLs to use the audiobook__ prefix for the proxy
            const transformed = recentProgress.map((progress: any) => {
                const coverUrl =
                    progress.coverUrl && !progress.coverUrl.startsWith("http")
                        ? `audiobook__${progress.coverUrl}`
                        : progress.coverUrl;

                return {
                    ...progress,
                    coverUrl,
                };
            });

            res.json(transformed);
        } catch (error) {
            safeError(res, "Failed to fetch continue listening", error);
        }
    }
);

/**
 * POST /audiobooks/sync
 * Manually trigger audiobook sync from Audiobookshelf
 * Fetches all audiobooks and caches metadata + cover images locally
 */
router.post("/sync", requireAuthOrToken, apiLimiter, async (_req, res) => {
    try {
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled) {
            return res
                .status(400)
                .json({ error: "Audiobookshelf not enabled" });
        }

        logger.debug("[Audiobooks] Starting manual audiobook sync...");
        const result = await audiobookCacheService.syncAll();

        res.json({
            success: true,
            result,
        });
    } catch (error: unknown) {
        const errMsg =
            error && typeof error === "object" && "message" in error
                ? String((error as { message: unknown }).message)
                : String(error);
        logger.error("[AUDIOBOOK] Sync failed:", errMsg);

        // Precondition failures the service throws on purpose (not configured,
        // disabled in settings) carry their own status -- they are caller
        // problems, not server bugs, and must not land in the 500 bucket.
        if (error instanceof UserFacingError) {
            return res.status(error.statusCode).json({
                success: false,
                error: errMsg,
            });
        }
        // Distinguish upstream failures (bad credentials, network) from internal bugs.
        // An axios error from Audiobookshelf carries the remote status in error.response.status.
        const upstreamStatus =
            error && typeof error === "object" && "response" in error
                ? (error as { response?: { status?: number } }).response?.status
                : undefined;
        if (upstreamStatus === 401 || upstreamStatus === 403) {
            return res.status(400).json({
                success: false,
                error: "Audiobookshelf rejected the stored credentials — check the API key or token expiry",
            });
        }
        if (upstreamStatus != null) {
            return res.status(502).json({
                success: false,
                error: `Audiobookshelf returned status ${upstreamStatus}`,
            });
        }
        // Internal details (file paths, SQL) stay in the server log.
        res.status(500).json({
            success: false,
            error: "Audiobook sync failed",
        });
    }
});

/**
 * GET /audiobooks/search
 * Search audiobooks
 */
router.get("/search", requireAuthOrToken, apiLimiter, async (req, res) => {
    try {
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled) {
            return res.status(200).json([]);
        }

        const { q } = req.query;

        if (!q || typeof q !== "string") {
            return res.status(400).json({ error: "Query parameter required" });
        }

        const results = await audiobookshelfService.searchAudiobooks(q);
        res.json(results);
    } catch (error) {
        safeError(res, "Failed to search audiobooks", error);
    }
});

/**
 * GET /audiobooks
 * Get all audiobooks from cached database (instant, no API calls)
 */
router.get("/", requireAuthOrToken, apiLimiter, async (req, res) => {
    logger.debug("[Audiobooks] GET / - fetching audiobooks list");
    try {
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled) {
            return res.status(200).json({
                configured: false,
                enabled: false,
                audiobooks: [],
            });
        }

        // Read from cached database instead of hitting Audiobookshelf API.
        // sortName, not title -- kept in sync at write time in both
        // audiobookCache.ts and audiobookshelf.ts -- so "The Hobbit" files
        // under H, not T.
        const audiobooks = await prisma.audiobook.findMany({
            orderBy: { sortName: "asc" },
        });

        const audiobookIds = audiobooks.map((book) => book.id);
        const progressEntries =
            audiobookIds.length > 0
                ? await prisma.audiobookProgress.findMany({
                      where: {
                          userId: req.user!.id,
                          audiobookshelfId: { in: audiobookIds },
                      },
                  })
                : [];
        const progressMap = new Map(
            progressEntries.map((entry) => [entry.audiobookshelfId, entry])
        );

        // Get user's progress for each audiobook. sortName is list-only: the
        // client re-sorts some views and cannot derive it — the article rules
        // live in Postgres and in artistSortName.
        const audiobooksWithProgress = audiobooks.map((book) => ({
            ...toAudiobookDto(book, progressMap.get(book.id) ?? null),
            sortName: book.sortName,
        }));

        res.json(audiobooksWithProgress);
    } catch (error) {
        safeError(res, "Failed to fetch audiobooks", error);
    }
});

/**
 * GET /audiobooks/series/:seriesName
 * Get all books in a series (from cached database)
 */
router.get(
    "/series/:seriesName",
    requireAuthOrToken,
    apiLimiter,
    async (req, res) => {
        try {
            const settings = await getSystemSettings();

            if (!settings?.audiobookshelfEnabled) {
                return res.status(200).json([]);
            }

            const { seriesName } = req.params;

            // Read from cached database
            const audiobooks = await prisma.audiobook.findMany({
                where: {
                    series: seriesName,
                },
                orderBy: {
                    seriesSequence: "asc",
                },
            });

            const seriesIds = audiobooks.map((book) => book.id);
            const seriesProgressEntries =
                seriesIds.length > 0
                    ? await prisma.audiobookProgress.findMany({
                          where: {
                              userId: req.user!.id,
                              audiobookshelfId: { in: seriesIds },
                          },
                      })
                    : [];
            const seriesProgressMap = new Map(
                seriesProgressEntries.map((entry) => [
                    entry.audiobookshelfId,
                    entry,
                ])
            );

            const seriesBooks = audiobooks.map((book) =>
                toAudiobookDto(book, seriesProgressMap.get(book.id) ?? null)
            );

            res.json(seriesBooks);
        } catch (error) {
            safeError(res, "Failed to fetch series", error);
        }
    }
);

/**
 * OPTIONS /audiobooks/:id/cover
 * Handle CORS preflight request for cover images
 */
router.options("/:id/cover", (req, res) => {
    const origin = resolveCorsOrigin(req.headers.origin, "http://localhost:3030");
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
    res.status(204).end();
});

/**
 * GET /audiobooks/:id/cover
 * Serve cached cover image from local disk, or proxy from Audiobookshelf if not cached
 * NO RATE LIMITING - These are static files served from disk with aggressive caching
 */
router.get("/:id/cover", async (req, res) => {
    try {
        const { id } = req.params;
        // This route is unauthenticated and `id` names a file below, so it must be a plain id.
        if (!/^[A-Za-z0-9_-]+$/.test(id)) {
            return res.status(404).json({ error: "Cover not found" });
        }

        const audiobook = await prisma.audiobook.findUnique({
            where: { id },
            select: { localCoverPath: true, coverUrl: true },
        });

        let coverPath = audiobook?.localCoverPath;

        // Fallback: check if cover exists on disk even if DB path is empty
        if (!coverPath) {
            const fallbackPath = resolveWithinMusicRoot(
                "cover-cache",
                "audiobooks",
                `${id}.jpg`
            );
            if (fallbackPath && fs.existsSync(fallbackPath)) {
                coverPath = fallbackPath;
                // Update database with the correct path
                await prisma.audiobook
                    .update({
                        where: { id },
                        data: { localCoverPath: fallbackPath },
                    })
                    .catch(() => {}); // Ignore errors if audiobook doesn't exist
            }
        }

        // The stored localCoverPath is resolved too: it is a database value and could
        // point outside the music root.
        const resolvedCover = coverPath
            ? resolveWithinMusicRoot(coverPath)
            : null;
        if (resolvedCover && fs.existsSync(resolvedCover)) {
            const origin = resolveCorsOrigin(req.headers.origin, "http://localhost:3030");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            if (origin) {
                res.setHeader("Access-Control-Allow-Origin", origin);
                res.setHeader("Access-Control-Allow-Credentials", "true");
            }
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            return res.sendFile(resolvedCover);
        }

        // Fallback: proxy from Audiobookshelf if coverUrl is available
        if (audiobook?.coverUrl) {
            const settings = await getSystemSettings();

            if (settings?.audiobookshelfUrl && settings?.audiobookshelfApiKey) {
                const baseUrl = settings.audiobookshelfUrl.replace(/\/$/, "");
                const coverApiUrl = `${baseUrl}/api/${audiobook.coverUrl}`;
                
                try {
                    const response = await fetch(coverApiUrl, {
                        headers: {
                            Authorization: `Bearer ${settings.audiobookshelfApiKey}`,
                        },
                    });
                    
                    if (response.ok) {
                        const origin = resolveCorsOrigin(req.headers.origin, "http://localhost:3030");
                        res.setHeader("Content-Type", response.headers.get("content-type") || "image/jpeg");
                        res.setHeader("Cache-Control", "public, max-age=86400"); // 24 hours for proxied
                        if (origin) {
                            res.setHeader("Access-Control-Allow-Origin", origin);
                            res.setHeader("Access-Control-Allow-Credentials", "true");
                        }
                        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
                        
                        // Stream the response body to client
                        const buffer = await response.arrayBuffer();
                        return res.send(Buffer.from(buffer));
                    }
                } catch (proxyError: any) {
                    logger.error(`[Audiobook Cover] Proxy error for ${id}:`, proxyError.message);
                }
            }
        }

        // No cover available
        return res.status(404).json({ error: "Cover not found" });
    } catch (error) {
        safeError(res, "Failed to serve cover", error);
    }
});

/**
 * GET /audiobooks/:id
 * Get a specific audiobook with full details (cache-only; syncs when missing/stale/no sections).
 */
router.get("/:id", requireAuthOrToken, apiLimiter, async (req, res) => {
    try {
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled) {
            return res.status(200).json({ configured: false, enabled: false });
        }

        const { id } = req.params;

        let audiobook = await prisma.audiobook.findUnique({ where: { id } });

        if (
            !audiobook ||
            audiobook.lastSyncedAt < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) ||
            audiobook.sectionsJson === null
        ) {
            logger.debug(`[AUDIOBOOK] Audiobook ${id} not cached, stale, or missing sections; syncing...`);
            audiobook = await audiobookCacheService.getAudiobook(id);
        }

        if (!audiobook) {
            return res.status(404).json({ error: "Audiobook not found" });
        }

        const progress = await prisma.audiobookProgress.findUnique({
            where: {
                userId_audiobookshelfId: {
                    userId: req.user!.id,
                    audiobookshelfId: id,
                },
            },
        });

        const tracks =
            (audiobook.tracksJson as
                | { index: number; startOffset: number; duration: number }[]
                | null) ?? [];
        const sections =
            (audiobook.sectionsJson as
                | { index: number; title: string; start: number }[]
                | null) ?? [];

        res.json({
            id: audiobook.id,
            title: audiobook.title,
            author: audiobook.author || "Unknown Author",
            narrator: audiobook.narrator,
            description: audiobook.description,
            coverUrl:
                audiobook.localCoverPath || audiobook.coverUrl
                    ? `/audiobooks/${audiobook.id}/cover`
                    : null,
            duration: audiobook.duration || 0,
            tracks,
            sections,
            libraryId: audiobook.libraryId,
            ...(audiobook.numTracks != null && { trackCount: audiobook.numTracks }),
            progress: progress ? progressDto(progress) : null,
        });
    } catch (error) {
        safeError(res, "Failed to fetch audiobook", error);
    }
});

/**
 * GET /audiobooks/:id/stream
 * Proxy the audiobook stream with authentication
 */
router.get("/:id/stream", requireAuthOrToken, async (req, res) => {
    try {
        logger.debug(
            `[Audiobook Stream] Request for audiobook: ${req.params.id}`
        );
        logger.debug(`[Audiobook Stream] User: ${req.user?.id || "unknown"}`);

        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled) {
            logger.debug("[Audiobook Stream] Audiobookshelf not enabled");
            return res
                .status(503)
                .json({ error: "Audiobookshelf is not configured" });
        }

        const { id } = req.params;
        const rawTrackIndex = req.query.trackIndex as string | undefined;
        const trackIndex =
            rawTrackIndex !== undefined && rawTrackIndex !== ""
                ? parseInt(rawTrackIndex, 10) || 1
                : undefined;
        const rangeHeader = req.headers.range as string | undefined;

        logger.debug(
            `[Audiobook Stream] Fetching stream for ${id}, track: ${trackIndex ?? "first"}, range: ${
                rangeHeader || "none"
            }`
        );

        const { stream, headers, status } =
            await audiobookshelfService.streamAudiobook(id, rangeHeader, trackIndex);

        logger.debug(
            `[Audiobook Stream] Got stream, status: ${status}, content-type: ${headers["content-type"]}`
        );

        // Upstream 416 (a seek past the end, e.g. a wrong stored size): send a clean
        // 416 with Content-Range so the client can correct, never the error body as audio.
        if (status === 416) {
            stream.destroy();
            res.status(416);
            res.setHeader("Accept-Ranges", "bytes");
            if (headers["content-range"]) {
                res.setHeader("Content-Range", headers["content-range"]);
            }
            res.end();
            return;
        }

        const responseStatus = status || (rangeHeader ? 206 : 200);
        res.status(responseStatus);

        // Set content type - ensure it's audio
        const contentType = upstreamHeader(headers["content-type"]) || "audio/mpeg";
        res.setHeader("Content-Type", contentType);

        // Set other headers
        const upstreamContentLength = upstreamHeader(headers["content-length"]);
        const upstreamAcceptRanges = upstreamHeader(headers["accept-ranges"]);
        if (upstreamContentLength) {
            res.setHeader("Content-Length", upstreamContentLength);
        }
        if (upstreamAcceptRanges) {
            res.setHeader("Accept-Ranges", upstreamAcceptRanges);
        } else {
            res.setHeader("Accept-Ranges", "bytes");
        }
        if (headers["content-range"]) {
            res.setHeader("Content-Range", headers["content-range"]);
        }

        res.setHeader("Cache-Control", "public, max-age=0");

        // Clean up upstream stream when client disconnects (e.g., skips track, closes browser)
        res.on("close", () => {
            if (!stream.destroyed) {
                stream.destroy();
            }
        });

        stream.pipe(res);

        stream.on("error", (error: unknown) => {
            logger.error("[Audiobook Stream] Stream error:", error);
            if (!res.headersSent) {
                safeError(res, "Audiobook stream error", error);
            } else {
                res.end();
            }
        });
    } catch (error) {
        const errMsg =
            error && typeof error === "object" && "message" in error
                ? String((error as { message: unknown }).message)
                : String(error);
        // Distinguish upstream failures (track/file gone from ABS) from internal bugs.
        // An axios error from Audiobookshelf carries the remote status in error.response.status.
        const upstreamStatus =
            error && typeof error === "object" && "response" in error
                ? (error as { response?: { status?: number } }).response?.status
                : undefined;
        if (upstreamStatus === 404) {
            return res.status(404).json({ success: false, error: `Audiobookshelf returned 404: ${errMsg}` });
        }
        if (upstreamStatus != null) {
            return res.status(502).json({ success: false, error: `Audiobookshelf returned status ${upstreamStatus}: ${errMsg}` });
        }
        safeError(res, "Failed to stream audiobook", error);
    }
});

/**
 * POST /audiobooks/:id/progress
 * Update playback progress for an audiobook
 */
router.post(
    "/:id/progress",
    requireAuthOrToken,
    apiLimiter,
    async (req, res) => {
        try {
            const settings = await getSystemSettings();

            if (!settings?.audiobookshelfEnabled) {
                return res.status(200).json({
                    success: false,
                    message: "Audiobookshelf is not configured",
                });
            }

            const { id } = req.params;
            const {
                currentTime: rawCurrentTime,
                duration: rawDuration,
                isFinished,
            } = req.body;

            const currentTime =
                typeof rawCurrentTime === "number" &&
                Number.isFinite(rawCurrentTime)
                    ? Math.max(0, rawCurrentTime)
                    : 0;
            const durationValue =
                typeof rawDuration === "number" && Number.isFinite(rawDuration)
                    ? Math.max(rawDuration, 0)
                    : 0;

            logger.debug(
                `[Audiobook Progress] update from ${req.user!.username} for ${id}: ` +
                    `${currentTime}s of ${durationValue}s${isFinished ? ", finished" : ""}`
            );

            // Pull cached metadata to avoid hitting Audiobookshelf for every update
            const [cachedAudiobook, existingProgress] = await Promise.all([
                prisma.audiobook.findUnique({
                    where: { id },
                    select: {
                        title: true,
                        author: true,
                        coverUrl: true,
                        duration: true,
                        libraryId: true,
                        localCoverPath: true,
                    },
                }),
                prisma.audiobookProgress.findUnique({
                    where: {
                        userId_audiobookshelfId: {
                            userId: req.user!.id,
                            audiobookshelfId: id,
                        },
                    },
                }),
            ]);

            const fallbackDuration =
                durationValue ||
                cachedAudiobook?.duration ||
                existingProgress?.duration ||
                0;

            const metadataTitle =
                cachedAudiobook?.title ||
                existingProgress?.title ||
                "Unknown Title";
            const metadataAuthor =
                cachedAudiobook?.author ||
                existingProgress?.author ||
                "Unknown Author";
            const metadataCover =
                cachedAudiobook?.coverUrl || existingProgress?.coverUrl || null;

            // Update progress in our database
            const progress = await prisma.audiobookProgress.upsert({
                where: {
                    userId_audiobookshelfId: {
                        userId: req.user!.id,
                        audiobookshelfId: id,
                    },
                },
                create: {
                    userId: req.user!.id,
                    audiobookshelfId: id,
                    title: metadataTitle,
                    author: metadataAuthor,
                    coverUrl: metadataCover,
                    currentTime,
                    duration: fallbackDuration,
                    isFinished: !!isFinished,
                    lastPlayedAt: new Date(),
                },
                update: {
                    title: metadataTitle,
                    author: metadataAuthor,
                    coverUrl: metadataCover,
                    currentTime,
                    duration: fallbackDuration,
                    isFinished: !!isFinished,
                    lastPlayedAt: new Date(),
                },
            });

            // Also update progress in Audiobookshelf
            try {
                await audiobookshelfService.updateProgress(
                    id,
                    currentTime,
                    fallbackDuration,
                    isFinished
                );
                logger.debug(`[Audiobook Progress] synced to Audiobookshelf`);
            } catch (error) {
                logger.error(
                    "Failed to sync progress to Audiobookshelf:",
                    error
                );
                // Continue anyway - local progress is saved
            }

            res.json({
                success: true,
                progress: {
                    currentTime: progress.currentTime,
                    progress:
                        progress.duration > 0
                            ? (progress.currentTime / progress.duration) * 100
                            : 0,
                    isFinished: progress.isFinished,
                },
            });
        } catch (error) {
            safeError(res, "Failed to update progress", error);
        }
    }
);

/**
 * DELETE /audiobooks/:id/progress
 * Remove/reset progress for an audiobook
 */
router.delete(
    "/:id/progress",
    requireAuthOrToken,
    apiLimiter,
    async (req, res) => {
        try {
            const settings = await getSystemSettings();

            if (!settings?.audiobookshelfEnabled) {
                return res.status(200).json({
                    success: false,
                    message: "Audiobookshelf is not configured",
                });
            }

            const { id } = req.params;

            logger.debug(
                `[Audiobook Progress] removing progress for ${id} (${req.user!.username})`
            );

            // Delete progress from our database
            await prisma.audiobookProgress.deleteMany({
                where: {
                    userId: req.user!.id,
                    audiobookshelfId: id,
                },
            });

            logger.debug(`   Progress removed from database`);

            // Also remove progress from Audiobookshelf
            try {
                await audiobookshelfService.updateProgress(id, 0, 0, false);
                logger.debug(`   Progress reset in Audiobookshelf`);
            } catch (error) {
                logger.error(
                    "Failed to reset progress in Audiobookshelf:",
                    error
                );
                // Continue anyway - local progress is deleted
            }

            res.json({
                success: true,
                message: "Progress removed",
            });
        } catch (error) {
            safeError(res, "Failed to remove progress", error);
        }
    }
);

export default router;
