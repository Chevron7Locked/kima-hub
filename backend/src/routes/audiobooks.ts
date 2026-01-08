import { Router } from "express";
import { logger } from "../utils/logger";
import { audiobookshelfService } from "../services/audiobookshelf";
import { audiobookCacheService } from "../services/audiobookCache";
import { prisma } from "../utils/db";
import { requireAuthOrToken } from "../middleware/auth";
import { imageLimiter, apiLimiter } from "../middleware/rateLimiter";

const router = Router();

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
            // Check if Audiobookshelf is enabled
            const { getSystemSettings } = await import(
                "../utils/systemSettings"
            );
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
        } catch (error: any) {
            logger.error("Error fetching continue listening:", error);
            res.status(500).json({
                error: "Failed to fetch continue listening",
                message: error.message,
            });
        }
    }
);

/**
 * POST /audiobooks/sync
 * Manually trigger audiobook sync from Audiobookshelf
 * Fetches all audiobooks and caches metadata + cover images locally
 */
router.post("/sync", requireAuthOrToken, apiLimiter, async (req, res) => {
    try {
        const { getSystemSettings } = await import("../utils/systemSettings");
        const { notificationService } = await import("../services/notificationService");
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled) {
            return res
                .status(400)
                .json({ error: "Audiobookshelf not enabled" });
        }

        logger.debug("[Audiobooks] Starting manual audiobook sync...");
        const result = await audiobookCacheService.syncAll();

        // Check how many have series after sync
        const seriesCount = await prisma.audiobook.count({
            where: { series: { not: null } },
        });
        logger.debug(
            `[Audiobooks] Sync complete. Books with series: ${seriesCount}`
        );

        // Send notification to user
        if (req.user?.id) {
            await notificationService.notifySystem(
                req.user.id,
                "Audiobook Sync Complete",
                `Synced ${result.synced || 0} audiobooks (${seriesCount} with series)`
            );
        }

        res.json({
            success: true,
            result,
        });
    } catch (error: any) {
        logger.error("Audiobook sync failed:", error);
        res.status(500).json({
            error: "Sync failed",
            message: error.message,
        });
    }
});

/**
 * GET /audiobooks/debug-series
 * Debug endpoint to see raw series data from Audiobookshelf
 */
// Debug endpoint for series data
router.get("/debug-series", requireAuthOrToken, async (req, res) => {
    logger.debug("[Audiobooks] Debug series endpoint called");
    try {
        const { getSystemSettings } = await import("../utils/systemSettings");
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled) {
            return res
                .status(400)
                .json({ error: "Audiobookshelf not enabled" });
        }

        // Get raw data from Audiobookshelf
        const rawBooks = await audiobookshelfService.getAllAudiobooks();
        logger.debug(
            `[Audiobooks] Got ${rawBooks.length} books from Audiobookshelf`
        );

        // Find books with series data
        const booksWithSeries = rawBooks.filter((book: any) => {
            const metadata = book.media?.metadata || book;
            return metadata.series || metadata.seriesName;
        });

        logger.debug(
            `[Audiobooks] Books with series data: ${booksWithSeries.length}`
        );

        // Extract series info from all books (first 20)
        const allSeriesInfo = rawBooks.slice(0, 20).map((book: any) => {
            const metadata = book.media?.metadata || book;
            return {
                title: metadata.title || book.title,
                rawSeries: metadata.series,
                seriesName: metadata.seriesName,
                seriesSequence: metadata.seriesSequence,
                // Also check if there's series in the top-level book object
                bookSeries: book.series,
            };
        });

        // Get a full sample of one book with series (if any)
        let fullSample = null;
        if (booksWithSeries.length > 0) {
            const sampleBook = booksWithSeries[0];
            fullSample = {
                id: sampleBook.id,
                media: sampleBook.media,
            };
        }

        res.json({
            totalBooks: rawBooks.length,
            booksWithSeriesCount: booksWithSeries.length,
            sampleSeriesData: allSeriesInfo,
            fullSampleWithSeries: fullSample,
        });
    } catch (error: any) {
        logger.error("[Audiobooks] Debug series error:", error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /audiobooks/search
 * Search audiobooks
 */
router.get("/search", requireAuthOrToken, apiLimiter, async (req, res) => {
    try {
        // Check if Audiobookshelf is enabled
        const { getSystemSettings } = await import("../utils/systemSettings");
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
    } catch (error: any) {
        logger.error("Error searching audiobooks:", error);
        res.status(500).json({
            error: "Failed to search audiobooks",
            message: error.message,
        });
    }
});

/**
 * GET /audiobooks
 * Get all audiobooks from cached database (instant, no API calls)
 */
router.get("/", requireAuthOrToken, apiLimiter, async (req, res) => {
    logger.debug("[Audiobooks] GET / - fetching audiobooks list");
    try {
        // Check if Audiobookshelf is enabled first
        const { getSystemSettings } = await import("../utils/systemSettings");
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled) {
            return res.status(200).json({
                configured: false,
                enabled: false,
                audiobooks: [],
            });
        }

        // Read from cached database instead of hitting Audiobookshelf API
        const audiobooks = await prisma.audiobook.findMany({
            orderBy: { title: "asc" },
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

        // Get user's progress for each audiobook
        const audiobooksWithProgress = audiobooks.map((book) => {
            const progress = progressMap.get(book.id);

            // Cover URL: if we have localCoverPath or coverUrl from Audiobookshelf, serve from our endpoint
            // The /audiobooks/:id/cover endpoint will find the file on disk even if localCoverPath isn't set
            const hasCover = book.localCoverPath || book.coverUrl;

            return {
                id: book.id,
                title: book.title,
                author: book.author || "Unknown Author",
                narrator: book.narrator,
                description: book.description,
                coverUrl: hasCover
                    ? `/audiobooks/${book.id}/cover` // Serve from local disk
                    : null,
                duration: book.duration || 0,
                libraryId: book.libraryId,
                series: book.series
                    ? {
                          name: book.series,
                          sequence: book.seriesSequence || "1",
                      }
                    : null,
                genres: book.genres || [],
                progress: progress
                    ? {
                          currentTime: progress.currentTime,
                          progress:
                              progress.duration > 0
                                  ? (progress.currentTime / progress.duration) *
                                    100
                                  : 0,
                          isFinished: progress.isFinished,
                          lastPlayedAt: progress.lastPlayedAt,
                      }
                    : null,
            };
        });

        res.json(audiobooksWithProgress);
    } catch (error: any) {
        logger.error("Error fetching audiobooks:", error);
        res.status(500).json({
            error: "Failed to fetch audiobooks",
            message: error.message,
        });
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
            // Check if Audiobookshelf is enabled
            const { getSystemSettings } = await import(
                "../utils/systemSettings"
            );
            const settings = await getSystemSettings();

            if (!settings?.audiobookshelfEnabled) {
                return res.status(200).json([]);
            }

            const { seriesName } = req.params;
            const decodedSeriesName = decodeURIComponent(seriesName);

            // Read from cached database
            const audiobooks = await prisma.audiobook.findMany({
                where: {
                    series: decodedSeriesName,
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

            const seriesBooks = audiobooks.map((book) => {
                const progress = seriesProgressMap.get(book.id);

                return {
                    id: book.id,
                    title: book.title,
                    author: book.author || "Unknown Author",
                    narrator: book.narrator,
                    description: book.description,
                    coverUrl:
                        book.localCoverPath || book.coverUrl
                            ? `/audiobooks/${book.id}/cover`
                            : null,
                    duration: book.duration || 0,
                    libraryId: book.libraryId,
                    series: book.series
                        ? {
                              name: book.series,
                              sequence: book.seriesSequence || "1",
                          }
                        : null,
                    genres: book.genres || [],
                    progress: progress
                        ? {
                              currentTime: progress.currentTime,
                              progress:
                                  progress.duration > 0
                                      ? (progress.currentTime /
                                            progress.duration) *
                                        100
                                      : 0,
                              isFinished: progress.isFinished,
                              lastPlayedAt: progress.lastPlayedAt,
                          }
                        : null,
                };
            });

            res.json(seriesBooks);
        } catch (error: any) {
            logger.error("Error fetching series:", error);
            res.status(500).json({
                error: "Failed to fetch series",
                message: error.message,
            });
        }
    }
);

/**
 * OPTIONS /audiobooks/:id/cover
 * Handle CORS preflight request for cover images
 */
router.options("/:id/cover", (req, res) => {
    const origin = req.headers.origin || "http://localhost:3030";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
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
        const fs = await import("fs");
        const path = await import("path");
        const { config } = await import("../config");

        const audiobook = await prisma.audiobook.findUnique({
            where: { id },
            select: { localCoverPath: true, coverUrl: true },
        });

        let coverPath = audiobook?.localCoverPath;

        // Fallback: check if cover exists on disk even if DB path is empty
        if (!coverPath) {
            const fallbackPath = path.join(
                config.music.musicPath,
                "cover-cache",
                "audiobooks",
                `${id}.jpg`
            );
            if (fs.existsSync(fallbackPath)) {
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

        // If local cover exists, serve it
        if (coverPath && fs.existsSync(coverPath)) {
            const origin = req.headers.origin || "http://localhost:3030";
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            return res.sendFile(coverPath);
        }

        // Fallback: proxy from Audiobookshelf if coverUrl is available
        if (audiobook?.coverUrl) {
            const { getSystemSettings } = await import("../utils/systemSettings");
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
                        const origin = req.headers.origin || "http://localhost:3030";
                        res.setHeader("Content-Type", response.headers.get("content-type") || "image/jpeg");
                        res.setHeader("Cache-Control", "public, max-age=86400"); // 24 hours for proxied
                        res.setHeader("Access-Control-Allow-Origin", origin);
                        res.setHeader("Access-Control-Allow-Credentials", "true");
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
    } catch (error: any) {
        logger.error("Error serving cover:", error);
        res.status(500).json({
            error: "Failed to serve cover",
            message: error.message,
        });
    }
});

/**
 * GET /audiobooks/:id
 * Get a specific audiobook with full details (from cache, fallback to API)
 */
router.get("/:id", requireAuthOrToken, apiLimiter, async (req, res) => {
    try {
        // Check if Audiobookshelf is enabled
        const { getSystemSettings } = await import("../utils/systemSettings");
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled) {
            return res.status(200).json({ configured: false, enabled: false });
        }

        const { id } = req.params;

        // Try to get from cache first
        let audiobook = await prisma.audiobook.findUnique({
            where: { id },
        });

        // If not cached or stale, fetch from API and cache it
        if (
            !audiobook ||
            audiobook.lastSyncedAt <
                new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        ) {
            logger.debug(
                `[AUDIOBOOK] Audiobook ${id} not cached or stale, fetching...`
            );
            audiobook = await audiobookCacheService.getAudiobook(id);
        }

        if (!audiobook) {
            return res.status(404).json({ error: "Audiobook not found" });
        }

        // Get chapters and audio files from API (these change less frequently)
        let absBook;
        try {
            absBook = await audiobookshelfService.getAudiobook(id);
        } catch (apiError: any) {
            logger.warn(
                `  Failed to fetch live data from Audiobookshelf for ${id}, using cached data only:`,
                apiError.message
            );
            // Continue with cached data only if API call fails
            absBook = { media: { chapters: [], audioFiles: [] } };
        }

        // Get user's progress
        const progress = await prisma.audiobookProgress.findUnique({
            where: {
                userId_audiobookshelfId: {
                    userId: req.user!.id,
                    audiobookshelfId: id,
                },
            },
        });

        const response = {
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
            chapters: absBook.media?.chapters || [],
            audioFiles: absBook.media?.audioFiles || [],
            libraryId: audiobook.libraryId,
            progress: progress
                ? {
                      currentTime: progress.currentTime,
                      progress:
                          progress.duration > 0
                              ? (progress.currentTime / progress.duration) * 100
                              : 0,
                      isFinished: progress.isFinished,
                      lastPlayedAt: progress.lastPlayedAt,
                  }
                : null,
        };

        res.json(response);
    } catch (error: any) {
        logger.error("Error fetching audiobook__", error);
        res.status(500).json({
            error: "Failed to fetch audiobook",
            message: error.message,
        });
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

        // Check if Audiobookshelf is enabled
        const { getSystemSettings } = await import("../utils/systemSettings");
        const settings = await getSystemSettings();

        if (!settings?.audiobookshelfEnabled) {
            logger.debug("[Audiobook Stream] Audiobookshelf not enabled");
            return res
                .status(503)
                .json({ error: "Audiobookshelf is not configured" });
        }

        const { id } = req.params;
        const rangeHeader = req.headers.range as string | undefined;

        logger.debug(
            `[Audiobook Stream] Fetching stream for ${id}, range: ${
                rangeHeader || "none"
            }`
        );

        const { stream, headers, status } =
            await audiobookshelfService.streamAudiobook(id, rangeHeader);

        logger.debug(
            `[Audiobook Stream] Got stream, status: ${status}, content-type: ${headers["content-type"]}`
        );

        const responseStatus = status || (rangeHeader ? 206 : 200);
        res.status(responseStatus);

        // Set content type - ensure it's audio
        const contentType = headers["content-type"] || "audio/mpeg";
        res.setHeader("Content-Type", contentType);

        // Set other headers
        if (headers["content-length"]) {
            res.setHeader("Content-Length", headers["content-length"]);
        }
        if (headers["accept-ranges"]) {
            res.setHeader("Accept-Ranges", headers["accept-ranges"]);
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

        stream.on("error", (error: any) => {
            logger.error("[Audiobook Stream] Stream error:", error);
            if (!res.headersSent) {
                res.status(500).json({
                    error: "Failed to stream audiobook",
                    message: error.message,
                });
            } else {
                res.end();
            }
        });
    } catch (error: any) {
        logger.error("[Audiobook Stream] Error:", error.message);
        res.status(500).json({
            error: "Failed to stream audiobook",
            message: error.message,
        });
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
            // Check if Audiobookshelf is enabled
            const { getSystemSettings } = await import(
                "../utils/systemSettings"
            );
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

            logger.debug(`\n [AUDIOBOOK PROGRESS] Received update:`);
            logger.debug(`   User: ${req.user!.username}`);
            logger.debug(`   Audiobook ID: ${id}`);
            logger.debug(
                `   Current Time: ${currentTime}s (${Math.floor(
                    currentTime / 60
                )} mins)`
            );
            logger.debug(
                `   Duration: ${durationValue}s (${Math.floor(
                    durationValue / 60
                )} mins)`
            );
            if (durationValue > 0) {
                logger.debug(
                    `   Progress: ${(
                        (currentTime / durationValue) *
                        100
                    ).toFixed(1)}%`
                );
            } else {
                logger.debug("   Progress: duration unknown");
            }
            logger.debug(`   Finished: ${!!isFinished}`);

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

            logger.debug(`   Progress saved to database`);

            // Also update progress in Audiobookshelf
            try {
                await audiobookshelfService.updateProgress(
                    id,
                    currentTime,
                    fallbackDuration,
                    isFinished
                );
                logger.debug(`   Progress synced to Audiobookshelf`);
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
        } catch (error: any) {
            logger.error("Error updating progress:", error);
            res.status(500).json({
                error: "Failed to update progress",
                message: error.message,
            });
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
            // Check if Audiobookshelf is enabled
            const { getSystemSettings } = await import(
                "../utils/systemSettings"
            );
            const settings = await getSystemSettings();

            if (!settings?.audiobookshelfEnabled) {
                return res.status(200).json({
                    success: false,
                    message: "Audiobookshelf is not configured",
                });
            }

            const { id } = req.params;

            logger.debug(`\n[AUDIOBOOK PROGRESS] Removing progress:`);
            logger.debug(`   User: ${req.user!.username}`);
            logger.debug(`   Audiobook ID: ${id}`);

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
        } catch (error: any) {
            logger.error("Error removing progress:", error);
            res.status(500).json({
                error: "Failed to remove progress",
                message: error.message,
            });
        }
    }
);

export default router;
