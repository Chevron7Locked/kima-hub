import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth, requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { rssParserService } from "../services/rss-parser";
import { podcastCacheService } from "../services/podcastCache";
import { parseRangeHeader } from "../utils/rangeParser";
import { safeError } from "../utils/errors";
import { validateUrlForFetch } from "../utils/ssrf";
import axios from "axios";
import fs from "fs";

const router = Router();

/**
 * POST /podcasts/sync-covers
 * Manually trigger podcast cover caching
 * Downloads and caches all podcast/episode covers locally
 */
router.post("/sync-covers", requireAuth, async (req, res) => {
    try {
        const { notificationService } = await import(
            "../services/notificationService"
        );
        logger.debug(" Starting podcast cover sync...");

        const podcastResult = await podcastCacheService.syncAllCovers();
        const episodeResult = await podcastCacheService.syncEpisodeCovers();

        // Send notification to user
        await notificationService.notifySystem(
            req.user!.id,
            "Podcast Covers Synced",
            `Synced ${podcastResult.synced || 0} podcast covers and ${
                episodeResult.synced || 0
            } episode covers`
        );

        res.json({
            success: true,
            podcasts: podcastResult,
            episodes: episodeResult,
        });
    } catch (error) {
        safeError(res, "Podcast cover sync failed", error);
    }
});

router.use(requireAuthOrToken);

/**
 * GET /podcasts
 * Get all podcasts the user is subscribed to
 */
router.get("/", requireAuth, async (req, res) => {
    try {
        const subscriptions = await prisma.podcastSubscription.findMany({
            where: { userId: req.user!.id },
            include: {
                podcast: {
                    include: {
                        episodes: {
                            orderBy: { publishedAt: "desc" },
                            take: 5, // Get latest 5 episodes per podcast
                            include: {
                                progress: {
                                    where: { userId: req.user!.id },
                                },
                            },
                        },
                    },
                },
            },
            orderBy: { subscribedAt: "desc" },
        });

        const podcasts = subscriptions.map((sub) => {
            const podcast = sub.podcast;
            return {
                id: podcast.id,
                title: podcast.title,
                author: podcast.author,
                description: podcast.description,
                coverUrl: podcast.localCoverPath
                    ? `/podcasts/${podcast.id}/cover`
                    : podcast.imageUrl, // Fallback to original URL if not cached
                episodeCount: podcast.episodeCount,
                autoDownloadEpisodes: false, // Per-podcast auto-download not yet implemented
                episodes: podcast.episodes.map((ep) => ({
                    id: ep.id,
                    title: ep.title,
                    description: ep.description,
                    duration: ep.duration,
                    publishedAt: ep.publishedAt,
                    coverUrl: ep.localCoverPath
                        ? `/podcasts/episodes/${ep.id}/cover`
                        : ep.imageUrl, // Fallback to original URL
                    progress: ep.progress[0]
                        ? {
                              currentTime: ep.progress[0].currentTime,
                              progress:
                                  ep.progress[0].duration > 0
                                      ? (ep.progress[0].currentTime /
                                            ep.progress[0].duration) *
                                        100
                                      : 0,
                              isFinished: ep.progress[0].isFinished,
                              lastPlayedAt: ep.progress[0].lastPlayedAt,
                          }
                        : null,
                })),
            };
        });

        res.json(podcasts);
    } catch (error) {
        safeError(res, "Error fetching podcasts", error);
    }
});

/**
 * GET /podcasts/discover/top
 * Get top podcasts - just search iTunes like the search bar does
 */
router.get("/discover/top", requireAuthOrToken, async (req, res) => {
    try {
        const { limit = "20" } = req.query;
        const podcastLimit = Math.min(parseInt(limit as string, 10), 50);

        logger.debug(`\n[TOP PODCASTS] Request (limit: ${podcastLimit})`);

        // Simple iTunes search - same as the working search bar!
        const itunesResponse = await axios.get(
            "https://itunes.apple.com/search",
            {
                params: {
                    term: "podcast",
                    media: "podcast",
                    entity: "podcast",
                    limit: podcastLimit,
                },
                timeout: 5000,
            }
        );

        const podcasts = itunesResponse.data.results.map((podcast: any) => ({
            id: podcast.collectionId.toString(),
            title: podcast.collectionName,
            author: podcast.artistName,
            coverUrl: podcast.artworkUrl600 || podcast.artworkUrl100,
            feedUrl: podcast.feedUrl,
            genres: podcast.genres || [],
            episodeCount: podcast.trackCount || 0,
            itunesId: podcast.collectionId,
            isExternal: true,
        }));

        logger.debug(`   Found ${podcasts.length} podcasts`);
        res.json(podcasts);
    } catch (error) {
        safeError(res, "Error fetching top podcasts", error);
    }
});

/**
 * GET /podcasts/discover/genres
 * Get podcasts by specific genres/topics - using simple iTunes search like the search bar
 */
router.get("/discover/genres", async (req, res) => {
    try {
        const { genres } = req.query; // Comma-separated genre IDs

        logger.debug(`\n[GENRE PODCASTS] Request (genres: ${genres})`);

        if (!genres || typeof genres !== "string") {
            return res.status(400).json({
                error: "genres parameter required (comma-separated genre IDs)",
            });
        }

        const genreIds = genres.split(",").map((id) => parseInt(id.trim(), 10));

        // Map genre IDs to search terms - same approach as the working search!
        const genreSearchTerms: { [key: number]: string } = {
            1303: "comedy podcast", // Comedy
            1324: "society culture podcast", // Society & Culture
            1489: "news podcast", // News
            1488: "true crime podcast", // True Crime
            1321: "business podcast", // Business
            1545: "sports podcast", // Sports
            1502: "gaming hobbies podcast", // Leisure (Gaming & Hobbies)
        };

        // Fetch podcasts for each genre using simple iTunes search - PARALLEL execution
        const genreFetchPromises = genreIds.map(async (genreId) => {
            const searchTerm = genreSearchTerms[genreId] || "podcast";
            logger.debug(`    Searching for "${searchTerm}"...`);

            try {
                // Simple iTunes search - same as the working search bar!
                const itunesResponse = await axios.get(
                    "https://itunes.apple.com/search",
                    {
                        params: {
                            term: searchTerm,
                            media: "podcast",
                            entity: "podcast",
                            limit: 10,
                        },
                        timeout: 5000,
                    }
                );

                const podcasts = itunesResponse.data.results.map(
                    (podcast: any) => ({
                        id: podcast.collectionId.toString(),
                        title: podcast.collectionName,
                        author: podcast.artistName,
                        coverUrl:
                            podcast.artworkUrl600 || podcast.artworkUrl100,
                        feedUrl: podcast.feedUrl,
                        genres: podcast.genres || [],
                        episodeCount: podcast.trackCount || 0,
                        itunesId: podcast.collectionId,
                        isExternal: true,
                    })
                );

                logger.debug(
                    `      Found ${podcasts.length} podcasts for genre ${genreId}`
                );
                return { genreId, podcasts };
            } catch (error: any) {
                logger.error(
                    `       Error searching for ${searchTerm}:`,
                    error.message
                );
                return { genreId, podcasts: [] };
            }
        });

        // Wait for all genre searches to complete in parallel
        const genreResults = await Promise.all(genreFetchPromises);

        // Convert array of results to object keyed by genreId
        const results: any = {};
        for (const { genreId, podcasts } of genreResults) {
            results[genreId] = podcasts;
        }

        logger.debug(
            `   Fetched podcasts for ${genreIds.length} genres (parallel)`
        );
        res.json(results);
    } catch (error) {
        safeError(res, "Error fetching genre podcasts", error);
    }
});

/**
 * GET /podcasts/discover/genre/:genreId
 * Get paginated podcasts for a specific genre with offset support
 */
router.get("/discover/genre/:genreId", async (req, res) => {
    try {
        const { genreId } = req.params;
        const { limit = "20", offset = "0" } = req.query;

        const podcastLimit = Math.min(parseInt(limit as string, 10), 50);
        const podcastOffset = parseInt(offset as string, 10);

        logger.debug(
            `\n[GENRE PAGINATED] Request (genre: ${genreId}, limit: ${podcastLimit}, offset: ${podcastOffset})`
        );

        // Map genre IDs to search terms
        const genreSearchTerms: { [key: string]: string } = {
            "1303": "comedy podcast",
            "1324": "society culture podcast",
            "1489": "news podcast",
            "1488": "true crime podcast",
            "1321": "business podcast",
            "1545": "sports podcast",
            "1502": "gaming hobbies podcast",
        };

        const searchTerm = genreSearchTerms[genreId] || "podcast";
        logger.debug(
            `    Searching for "${searchTerm}" (offset: ${podcastOffset})...`
        );

        // iTunes API doesn't support offset directly, so we request more and slice
        // This is a limitation but works for reasonable pagination
        const totalToFetch = podcastOffset + podcastLimit;

        const itunesResponse = await axios.get(
            "https://itunes.apple.com/search",
            {
                params: {
                    term: searchTerm,
                    media: "podcast",
                    entity: "podcast",
                    limit: Math.min(totalToFetch, 200), // iTunes max is 200
                },
                timeout: 5000,
            }
        );

        const allPodcasts = itunesResponse.data.results.map((podcast: any) => ({
            id: podcast.collectionId.toString(),
            title: podcast.collectionName,
            author: podcast.artistName,
            coverUrl: podcast.artworkUrl600 || podcast.artworkUrl100,
            feedUrl: podcast.feedUrl,
            genres: podcast.genres || [],
            episodeCount: podcast.trackCount || 0,
            itunesId: podcast.collectionId,
            isExternal: true,
        }));

        // Slice for pagination
        const podcasts = allPodcasts.slice(
            podcastOffset,
            podcastOffset + podcastLimit
        );

        logger.debug(
            `   Found ${podcasts.length} podcasts (total available: ${allPodcasts.length})`
        );
        res.json(podcasts);
    } catch (error) {
        safeError(res, "Error fetching paginated genre podcasts", error);
    }
});

/**
 * GET /podcasts/preview/:itunesId
 * Preview a podcast by iTunes ID (for discovery, before subscribing)
 * Returns basic podcast info without requiring a subscription
 */
router.get("/preview/:itunesId", requireAuth, async (req, res) => {
    try {
        const { itunesId } = req.params;

        logger.debug(`\n [PODCAST PREVIEW] iTunes ID: ${itunesId}`);

        // Try to fetch from iTunes API
        const itunesResponse = await axios.get(
            "https://itunes.apple.com/lookup",
            {
                params: {
                    id: itunesId,
                    entity: "podcast",
                },
                timeout: 5000,
            }
        );

        if (
            !itunesResponse.data.results ||
            itunesResponse.data.results.length === 0
        ) {
            return res.status(404).json({ error: "Podcast not found" });
        }

        const podcastData = itunesResponse.data.results[0];

        // Check if user is already subscribed
        const existingPodcast = await prisma.podcast.findFirst({
            where: {
                OR: [{ id: itunesId }, { feedUrl: podcastData.feedUrl }],
            },
        });

        let isSubscribed = false;
        if (existingPodcast) {
            const subscription = await prisma.podcastSubscription.findUnique({
                where: {
                    userId_podcastId: {
                        userId: req.user!.id,
                        podcastId: existingPodcast.id,
                    },
                },
            });
            isSubscribed = !!subscription;
        }

        // Fetch description and episodes from RSS feed (iTunes API doesn't provide them)
        let description = "";
        let previewEpisodes: any[] = [];
        if (podcastData.feedUrl) {
            try {
                const feedData = await rssParserService.parseFeed(
                    podcastData.feedUrl
                );
                description = feedData.podcast.description || "";

                // Get first 3 episodes for preview
                previewEpisodes = (feedData.episodes || [])
                    .slice(0, 3)
                    .map((episode: any) => ({
                        title: episode.title,
                        publishedAt: episode.publishedAt,
                        duration: episode.duration || 0,
                    }));

                logger.debug(
                    ` [PODCAST PREVIEW] Fetched description (${description.length} chars) and ${previewEpisodes.length} preview episodes`
                );
            } catch (error) {
                logger.warn(`  Failed to fetch RSS feed for preview:`, error);
                // Continue without description and episodes
            }
        }

        res.json({
            itunesId: podcastData.collectionId.toString(),
            title: podcastData.collectionName,
            author: podcastData.artistName,
            description: description,
            coverUrl: podcastData.artworkUrl600 || podcastData.artworkUrl100,
            feedUrl: podcastData.feedUrl,
            genres: podcastData.genres || [],
            episodeCount: podcastData.trackCount || 0,
            previewEpisodes: previewEpisodes,
            isSubscribed,
            subscribedPodcastId: isSubscribed ? existingPodcast!.id : null,
        });
    } catch (error) {
        safeError(res, "Error previewing podcast", error);
    }
});

/**
 * GET /podcasts/:id
 * Get a specific podcast with full details and episodes
 * Requires user to be subscribed
 */
router.get("/:id", requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        // Check if user is subscribed
        const subscription = await prisma.podcastSubscription.findUnique({
            where: {
                userId_podcastId: {
                    userId: req.user!.id,
                    podcastId: id,
                },
            },
        });

        if (!subscription) {
            return res
                .status(404)
                .json({ error: "Podcast not found or not subscribed" });
        }

        const podcast = await prisma.podcast.findUnique({
            where: { id },
            include: {
                episodes: {
                    orderBy: { publishedAt: "desc" },
                    include: {
                        progress: {
                            where: { userId: req.user!.id },
                        },
                        downloads: {
                            where: { userId: req.user!.id },
                        },
                    },
                },
            },
        });

        if (!podcast) {
            return res.status(404).json({ error: "Podcast not found" });
        }

        const episodesWithProgress = podcast.episodes.map((episode) => ({
            id: episode.id,
            title: episode.title,
            description: episode.description,
            duration: episode.duration,
            publishedAt: episode.publishedAt,
            episodeNumber: episode.episodeNumber,
            season: episode.season,
            imageUrl: episode.imageUrl,
            isDownloaded: episode.downloads.length > 0,
            progress: episode.progress[0]
                ? {
                      currentTime: episode.progress[0].currentTime,
                      progress:
                          episode.progress[0].duration > 0
                              ? (episode.progress[0].currentTime /
                                    episode.progress[0].duration) *
                                100
                              : 0,
                      isFinished: episode.progress[0].isFinished,
                      lastPlayedAt: episode.progress[0].lastPlayedAt,
                  }
                : null,
        }));

        res.json({
            id: podcast.id,
            title: podcast.title,
            author: podcast.author,
            description: podcast.description,
            coverUrl: podcast.imageUrl,
            feedUrl: podcast.feedUrl,
            genres: [], // Podcast genres not yet stored in database
            autoDownloadEpisodes: false,
            episodes: episodesWithProgress,
            isSubscribed: true,
        });
    } catch (error) {
        safeError(res, "Error fetching podcast", error);
    }
});

/**
 * POST /podcasts/subscribe
 * Subscribe to a podcast by RSS feed URL or iTunes ID
 */
router.post("/subscribe", requireAuth, async (req, res) => {
    try {
        const { feedUrl, itunesId } = req.body;

        if (!feedUrl && !itunesId) {
            return res
                .status(400)
                .json({ error: "feedUrl or itunesId is required" });
        }

        logger.debug(
            `\n [PODCAST] Subscribe request from ${req.user!.username}`
        );
        logger.debug(`   Feed URL: ${feedUrl || "N/A"}`);
        logger.debug(`   iTunes ID: ${itunesId || "N/A"}`);

        let finalFeedUrl = feedUrl;

        // If only iTunes ID provided, fetch feed URL from iTunes API
        if (!finalFeedUrl && itunesId) {
            logger.debug(`    Looking up feed URL from iTunes...`);
            const itunesResponse = await axios.get(
                "https://itunes.apple.com/lookup",
                {
                    params: { id: itunesId, entity: "podcast" },
                }
            );

            if (
                itunesResponse.data.resultCount === 0 ||
                !itunesResponse.data.results[0].feedUrl
            ) {
                return res
                    .status(404)
                    .json({ error: "Podcast not found in iTunes" });
            }

            finalFeedUrl = itunesResponse.data.results[0].feedUrl;
            logger.debug(`   Found feed URL: ${finalFeedUrl}`);
        }

        // Check if podcast already exists in database
        let podcast = await prisma.podcast.findUnique({
            where: { feedUrl: finalFeedUrl },
        });

        if (podcast) {
            logger.debug(`   Podcast exists in database: ${podcast.title}`);

            // Check if user is already subscribed
            const existingSubscription =
                await prisma.podcastSubscription.findUnique({
                    where: {
                        userId_podcastId: {
                            userId: req.user!.id,
                            podcastId: podcast.id,
                        },
                    },
                });

            if (existingSubscription) {
                logger.debug(`     User already subscribed`);
                return res.json({
                    success: true,
                    podcast: {
                        id: podcast.id,
                        title: podcast.title,
                    },
                    message: "Already subscribed",
                });
            }

            // Subscribe user to existing podcast
            await prisma.podcastSubscription.create({
                data: {
                    userId: req.user!.id,
                    podcastId: podcast.id,
                },
            });

            logger.debug(`   User subscribed to existing podcast`);
            return res.json({
                success: true,
                podcast: {
                    id: podcast.id,
                    title: podcast.title,
                },
                message: "Subscribed successfully",
            });
        }

        // Parse RSS feed to get podcast and episodes
        logger.debug(`   Parsing RSS feed...`);
        const { podcast: podcastData, episodes } =
            await rssParserService.parseFeed(finalFeedUrl);

        // Create podcast in database
        logger.debug(`    Saving podcast to database...`);
        const finalItunesId = itunesId || podcastData.itunesId;
        logger.debug(`   iTunes ID to save: ${finalItunesId || "NONE"}`);

        podcast = await prisma.podcast.create({
            data: {
                feedUrl: finalFeedUrl,
                title: podcastData.title,
                author: podcastData.author,
                description: podcastData.description,
                imageUrl: podcastData.imageUrl,
                itunesId: finalItunesId,
                language: podcastData.language,
                explicit: podcastData.explicit || false,
                episodeCount: episodes.length,
            },
        });

        logger.debug(`   Podcast created: ${podcast.id}`);
        logger.debug(`   iTunes ID saved: ${podcast.itunesId || "NONE"}`);

        // Save episodes
        logger.debug(`    Saving ${episodes.length} episodes...`);
        await prisma.podcastEpisode.createMany({
            data: episodes.map((ep) => ({
                podcastId: podcast!.id,
                guid: ep.guid,
                title: ep.title,
                description: ep.description,
                audioUrl: ep.audioUrl,
                duration: ep.duration,
                publishedAt: ep.publishedAt,
                episodeNumber: ep.episodeNumber,
                season: ep.season,
                imageUrl: ep.imageUrl,
                fileSize: ep.fileSize,
                mimeType: ep.mimeType,
            })),
            skipDuplicates: true,
        });

        logger.debug(`   Episodes saved`);

        // Subscribe user
        await prisma.podcastSubscription.create({
            data: {
                userId: req.user!.id,
                podcastId: podcast.id,
            },
        });

        logger.debug(`   User subscribed successfully`);

        res.json({
            success: true,
            podcast: {
                id: podcast.id,
                title: podcast.title,
            },
            message: "Subscribed successfully",
        });
    } catch (error) {
        safeError(res, "Error subscribing to podcast", error);
    }
});

/**
 * DELETE /podcasts/:id/unsubscribe
 * Unsubscribe from a podcast
 */
router.delete("/:id/unsubscribe", requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        logger.debug(`\n[PODCAST] Unsubscribe request`);
        logger.debug(`   User: ${req.user!.username}`);
        logger.debug(`   Podcast ID: ${id}`);

        // Delete subscription
        const deleted = await prisma.podcastSubscription.deleteMany({
            where: {
                userId: req.user!.id,
                podcastId: id,
            },
        });

        if (deleted.count === 0) {
            return res
                .status(404)
                .json({ error: "Not subscribed to this podcast" });
        }

        // Also delete user's progress for this podcast
        await prisma.podcastProgress.deleteMany({
            where: {
                userId: req.user!.id,
                episode: {
                    podcastId: id,
                },
            },
        });

        // Also delete any downloaded episodes
        await prisma.podcastDownload.deleteMany({
            where: {
                userId: req.user!.id,
                episode: {
                    podcastId: id,
                },
            },
        });

        logger.debug(`   Unsubscribed successfully`);

        res.json({
            success: true,
            message: "Unsubscribed successfully",
        });
    } catch (error) {
        safeError(res, "Error unsubscribing from podcast", error);
    }
});

/**
 * GET /podcasts/:id/refresh
 * Manually refresh podcast feed to check for new episodes
 */
router.get("/:id/refresh", requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        logger.debug(`\n [PODCAST] Refresh request`);
        logger.debug(`   Podcast ID: ${id}`);

        const result = await refreshPodcastFeed(id);

        logger.debug(
            `   Refresh complete. ${result.newEpisodesCount} new episodes added.`
        );

        res.json({
            success: true,
            newEpisodesCount: result.newEpisodesCount,
            totalEpisodes: result.totalEpisodes,
            message: `Found ${result.newEpisodesCount} new episodes`,
        });
    } catch (error) {
        if (error instanceof Error && error.message?.includes("not found")) {
            return res.status(404).json({ error: "Podcast not found" });
        }
        safeError(res, "Error refreshing podcast", error);
    }
});

/**
 * GET /podcasts/:podcastId/episodes/:episodeId/cache-status
 * Check if a podcast episode is cached locally
 * Used by frontend to know when it's safe to reload for seeking
 * Also returns download progress if downloading
 */
router.get("/:podcastId/episodes/:episodeId/cache-status", async (req, res) => {
    try {
        const { episodeId } = req.params;

        const { getCachedFilePath, isDownloading, getDownloadProgress } =
            await import("../services/podcastDownload");

        const cachedPath = await getCachedFilePath(episodeId);
        const downloading = isDownloading(episodeId);
        const progress = getDownloadProgress(episodeId);

        res.json({
            episodeId,
            cached: !!cachedPath,
            downloading,
            downloadProgress: progress?.progress ?? null, // 0-100 or null
            path: cachedPath ? true : false, // Don't expose actual path
        });
    } catch (error: any) {
        logger.error("[PODCAST] Cache status check failed:", error);
        res.status(500).json({ error: "Failed to check cache status" });
    }
});

/**
 * GET /podcasts/:podcastId/episodes/:episodeId/stream
 * Stream a podcast episode (from local cache or RSS URL)
 * Auto-caches episodes in background for better seeking support
 */
router.get("/:podcastId/episodes/:episodeId/stream", requireAuthOrToken, async (req, res) => {
    try {
        const { podcastId, episodeId } = req.params;
        const userId = req.user?.id;
        const podcastDebug = process.env.PODCAST_DEBUG === "1";

        logger.debug(`\n [PODCAST STREAM] Request:`);
        logger.debug(`   Podcast ID: ${podcastId}`);
        logger.debug(`   Episode ID: ${episodeId}`);
        if (podcastDebug) {
            logger.debug(`   Range: ${req.headers.range || "none"}`);
            logger.debug(`   UA: ${req.headers["user-agent"] || "unknown"}`);
        }

        const episode = await prisma.podcastEpisode.findUnique({
            where: { id: episodeId },
        });

        if (!episode) {
            return res.status(404).json({ error: "Episode not found" });
        }

        if (podcastDebug) {
            logger.debug(`   Episode DB: title="${episode.title}"`);
            logger.debug(`   Episode DB: guid="${episode.guid}"`);
            logger.debug(`   Episode DB: audioUrl="${episode.audioUrl}"`);
            logger.debug(
                `   Episode DB: mimeType="${
                    episode.mimeType || "unknown"
                }" fileSize=${episode.fileSize || 0}`
            );
        }

        const range = req.headers.range;

        // Import podcast download service
        const { getCachedFilePath, downloadInBackground, isDownloading } =
            await import("../services/podcastDownload");

        // Check if episode is cached locally (with full range support)
        const cachedPath = await getCachedFilePath(episodeId);

        if (cachedPath) {
            logger.debug(`   Streaming from cache: ${cachedPath}`);
            try {
                const stats = await fs.promises.stat(cachedPath);
                const fileSize = stats.size;
                if (podcastDebug) {
                    logger.debug(`   Cache file size: ${fileSize}`);
                }

                if (fileSize === 0) {
                    throw new Error("Cached file is empty");
                }

                if (range) {
                    const parsed = parseRangeHeader(range, fileSize);

                    let start: number;
                    let end: number;

                    if (!parsed.ok) {
                        // Clamp to 1MB window near EOF instead of 416 (prevents client stalls during seeking)
                        const clampWindowBytes = 1024 * 1024;
                        start = Math.max(0, fileSize - clampWindowBytes);
                        end = fileSize - 1;
                        logger.debug(
                            `    Invalid range, clamping to last ${fileSize - start} bytes`
                        );
                    } else {
                        start = parsed.start;
                        end = parsed.end;
                    }

                    const chunkSize = end - start + 1;

                    logger.debug(
                        `    Serving range: bytes ${start}-${end}/${fileSize}`
                    );

                    res.writeHead(206, {
                        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                        "Accept-Ranges": "bytes",
                        "Content-Length": chunkSize,
                        "Content-Type": episode.mimeType || "audio/mpeg",
                        "Cache-Control": "public, max-age=3600",
                        "Access-Control-Allow-Origin":
                            req.headers.origin || "*",
                        "Access-Control-Allow-Credentials": "true",
                    });

                    const fileStream = fs.createReadStream(cachedPath, {
                        start,
                        end: end,
                    });
                    // Clean up file stream when client disconnects
                    res.on("close", () => {
                        if (!fileStream.destroyed) {
                            fileStream.destroy();
                        }
                    });
                    fileStream.pipe(res);
                    fileStream.on("error", (err) => {
                        logger.error("    Cache stream error:", err);
                        if (!res.headersSent) {
                            res.status(500).json({
                                error: "Failed to stream episode",
                            });
                        } else {
                            res.end();
                        }
                    });
                    return; // CRITICAL: Exit after starting cache stream
                }

                // No range - serve entire file
                logger.debug(`    Serving full file: ${fileSize} bytes`);
                res.writeHead(200, {
                    "Content-Type": episode.mimeType || "audio/mpeg",
                    "Content-Length": fileSize,
                    "Accept-Ranges": "bytes",
                    "Cache-Control": "public, max-age=3600",
                    "Access-Control-Allow-Origin": req.headers.origin || "*",
                    "Access-Control-Allow-Credentials": "true",
                });

                const fileStream = fs.createReadStream(cachedPath);
                // Clean up file stream when client disconnects
                res.on("close", () => {
                    if (!fileStream.destroyed) {
                        fileStream.destroy();
                    }
                });
                fileStream.pipe(res);
                fileStream.on("error", (err) => {
                    logger.error("    Cache stream error:", err);
                    if (!res.headersSent) {
                        res.status(500).json({
                            error: "Failed to stream episode",
                        });
                    } else {
                        res.end();
                    }
                });
                return; // CRITICAL: Exit after starting cache stream
            } catch (err: any) {
                logger.error(
                    "    Failed to stream from cache, falling back to RSS:",
                    err.message
                );
                // Fall through to RSS streaming only if cache fails
            }
        }

        // Not cached yet - trigger background download while streaming from RSS
        if (userId && !isDownloading(episodeId)) {
            logger.debug(`   Triggering background download for caching`);
            downloadInBackground(episodeId, episode.audioUrl, userId);
        }

        // SSRF protection: validate audio URL before fetching
        const ssrfError = await validateUrlForFetch(episode.audioUrl);
        if (ssrfError) {
            logger.warn(`[PODCAST STREAM] SSRF blocked: ${ssrfError} for ${episode.audioUrl}`);
            return res.status(400).json({ error: "Invalid audio URL" });
        }

        // Stream from RSS URL
        logger.debug(`   Streaming from RSS: ${episode.audioUrl}`);

        // Get file size first for proper range handling
        let fileSize = episode.fileSize;
        if (!fileSize) {
            try {
                const headResponse = await axios.head(episode.audioUrl);
                fileSize = parseInt(
                    headResponse.headers["content-length"] || "0"
                );
                if (Number.isFinite(fileSize) && fileSize > 0) {
                    await prisma.podcastEpisode.update({
                        where: { id: episode.id },
                        data: { fileSize },
                    });
                }
            } catch (err) {
                logger.warn("    Could not get file size via HEAD request");
            }
        }

        if (range && fileSize) {
            const parsed = parseRangeHeader(range, fileSize);
            if (!parsed.ok) {
                res.status(416).set({
                    "Content-Range": `bytes */${fileSize}`,
                });
                res.end();
                return;
            }
            const { start, end } = parsed;
            const chunkSize = end - start + 1;

            logger.debug(
                `    Range request: bytes=${start}-${end}/${fileSize}`
            );

            const controller = new AbortController();

            // Handle client disconnect BEFORE starting the request
            res.on("close", () => {
                controller.abort();
            });

            try {
                // Try range request first
                const response = await axios.get(episode.audioUrl, {
                    headers: { Range: `bytes=${start}-${end}` },
                    responseType: "stream",
                    validateStatus: (status) =>
                        status === 206 || status === 200,
                    timeout: 30000,
                    signal: controller.signal,
                });

                // If upstream returned 200 OK instead of 206 Partial Content, it ignored our Range header.
                // In this case, we must stream the whole response as 200 OK, or the browser will be confused
                // if we try to wrap it in a 206.
                if (response.status === 200) {
                    logger.debug(
                        `    Upstream returned 200 OK (ignored Range), streaming full response`
                    );
                    res.writeHead(200, {
                        "Content-Type": episode.mimeType || "audio/mpeg",
                        "Accept-Ranges": "bytes",
                        "Content-Length":
                            response.headers["content-length"] || fileSize,
                        "Cache-Control": "public, max-age=3600",
                        "Access-Control-Allow-Origin":
                            req.headers.origin || "*",
                        "Access-Control-Allow-Credentials": "true",
                    });
                } else {
                    // Send 206 Partial Content with proper range
                    res.writeHead(206, {
                        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                        "Accept-Ranges": "bytes",
                        "Content-Length": chunkSize,
                        "Content-Type": episode.mimeType || "audio/mpeg",
                        "Cache-Control": "public, max-age=3600",
                        "Access-Control-Allow-Origin":
                            req.headers.origin || "*",
                        "Access-Control-Allow-Credentials": "true",
                    });
                }

                // Handle stream errors to prevent process crash
                response.data.on("error", (err: Error) => {
                    // Client disconnect errors are expected during seeking
                    if ((err as any).code !== "ERR_STREAM_PREMATURE_CLOSE") {
                        logger.debug(`    RSS stream error: ${err.message}`);
                    }
                    if (!res.writableEnded) {
                        res.end();
                    }
                });

                // Clean up axios stream when client disconnects
                res.on("close", () => {
                    if (response.data && !response.data.destroyed) {
                        response.data.destroy();
                    }
                });
                response.data.pipe(res);
                return;
            } catch (rangeError: any) {
                if (axios.isCancel(rangeError)) {
                    logger.debug("    Request aborted by client");
                    return;
                }
                // 416 = Range Not Satisfiable - many podcast CDNs don't support range requests
                // Fall back to streaming the full file and let the browser handle seeking
                logger.debug(
                    `    Range request failed (${
                        rangeError.response?.status || rangeError.message
                    }), falling back to full stream`
                );

                // Stream full file instead - browser will handle seeking locally
                const response = await axios.get(episode.audioUrl, {
                    responseType: "stream",
                    timeout: 60000,
                    signal: controller.signal,
                });

                const contentLength = response.headers["content-length"];

                res.writeHead(200, {
                    "Content-Type": episode.mimeType || "audio/mpeg",
                    "Accept-Ranges": "bytes",
                    ...(contentLength && { "Content-Length": contentLength }),
                    "Cache-Control": "public, max-age=3600",
                    "Access-Control-Allow-Origin": req.headers.origin || "*",
                    "Access-Control-Allow-Credentials": "true",
                });

                // Handle stream errors to prevent process crash
                response.data.on("error", (err: Error) => {
                    // Client disconnect errors are expected during seeking
                    if ((err as any).code !== "ERR_STREAM_PREMATURE_CLOSE") {
                        logger.debug(
                            `    RSS fallback stream error: ${err.message}`
                        );
                    }
                    if (!res.writableEnded) {
                        res.end();
                    }
                });

                // Clean up axios stream when client disconnects
                res.on("close", () => {
                    if (response.data && !response.data.destroyed) {
                        response.data.destroy();
                    }
                });
                response.data.pipe(res);
                return;
            }
        } else {
            // No range request - stream entire file
            logger.debug(`    Streaming full file`);

            const controller = new AbortController();
            res.on("close", () => {
                controller.abort();
            });

            try {
                const response = await axios.get(episode.audioUrl, {
                    responseType: "stream",
                    signal: controller.signal,
                });

                const contentLength = response.headers["content-length"];

                res.writeHead(200, {
                    "Content-Type": episode.mimeType || "audio/mpeg",
                    "Accept-Ranges": "bytes",
                    ...(contentLength && { "Content-Length": contentLength }),
                    "Cache-Control": "public, max-age=3600",
                    "Access-Control-Allow-Origin": req.headers.origin || "*",
                    "Access-Control-Allow-Credentials": "true",
                });

                // Handle stream errors to prevent process crash
                response.data.on("error", (err: Error) => {
                    // Client disconnect errors are expected during seeking
                    if ((err as any).code !== "ERR_STREAM_PREMATURE_CLOSE") {
                        logger.debug(
                            `    RSS full stream error: ${err.message}`
                        );
                    }
                    if (!res.writableEnded) {
                        res.end();
                    }
                });

                // Clean up axios stream when client disconnects
                res.on("close", () => {
                    if (response.data && !response.data.destroyed) {
                        response.data.destroy();
                    }
                });
                response.data.pipe(res);
            } catch (error: any) {
                if (axios.isCancel(error)) {
                    logger.debug("    Request aborted by client");
                    return;
                }
                throw error;
            }
        }
    } catch (error) {
        if (!res.headersSent) {
            safeError(res, "Podcast stream error", error);
        } else {
            logger.error("Podcast stream error (headers already sent):", error);
        }
    }
});

/**
 * POST /podcasts/:podcastId/episodes/:episodeId/progress
 * Update playback progress for a podcast episode
 */
router.post("/:podcastId/episodes/:episodeId/progress", requireAuth, async (req, res) => {
    try {
        const { podcastId, episodeId } = req.params;
        const { currentTime, duration, isFinished } = req.body;

        logger.debug(`\n [PODCAST PROGRESS] Update:`);
        logger.debug(`   User: ${req.user!.username}`);
        logger.debug(`   Episode ID: ${episodeId}`);
        logger.debug(`   Current Time: ${currentTime}s`);
        logger.debug(`   Duration: ${duration}s`);
        logger.debug(`   Finished: ${isFinished}`);

        const progress = await prisma.podcastProgress.upsert({
            where: {
                userId_episodeId: {
                    userId: req.user!.id,
                    episodeId: episodeId,
                },
            },
            create: {
                userId: req.user!.id,
                episodeId: episodeId,
                currentTime,
                duration,
                isFinished: isFinished || false,
            },
            update: {
                currentTime,
                duration,
                isFinished: isFinished || false,
                lastPlayedAt: new Date(),
            },
        });

        logger.debug(`   Progress saved`);

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
        safeError(res, "Error updating progress", error);
    }
});

/**
 * DELETE /podcasts/:podcastId/episodes/:episodeId/progress
 * Remove/reset progress for a podcast episode
 */
router.delete("/:podcastId/episodes/:episodeId/progress", requireAuth, async (req, res) => {
    try {
        const { episodeId } = req.params;

        logger.debug(`\n[PODCAST PROGRESS] Delete:`);
        logger.debug(`   User: ${req.user!.username}`);
        logger.debug(`   Episode ID: ${episodeId}`);

        await prisma.podcastProgress.deleteMany({
            where: {
                userId: req.user!.id,
                episodeId: episodeId,
            },
        });

        logger.debug(`   Progress removed`);

        res.json({
            success: true,
            message: "Progress removed",
        });
    } catch (error) {
        safeError(res, "Error removing progress", error);
    }
});

/**
 * GET /podcasts/:id/similar
 * Get similar podcasts using iTunes Search API (free, no auth required)
 */
router.get("/:id/similar", async (req, res) => {
    try {
        const { id } = req.params;

        const podcast = await prisma.podcast.findUnique({
            where: { id },
        });

        if (!podcast) {
            return res.status(404).json({ error: "Podcast not found" });
        }

        logger.debug(`\n [SIMILAR PODCASTS] Request for: ${podcast.title}`);

        try {
            // Check cache first
            const cachedRecommendations =
                await prisma.podcastRecommendation.findMany({
                    where: {
                        podcastId: id,
                        expiresAt: { gt: new Date() },
                    },
                    orderBy: { score: "desc" },
                    take: 10,
                });

            if (cachedRecommendations.length > 0) {
                logger.debug(
                    `   Using ${cachedRecommendations.length} cached recommendations`
                );
                return res.json(
                    cachedRecommendations.map((rec) => ({
                        id: rec.recommendedId,
                        title: rec.title,
                        author: rec.author,
                        description: rec.description,
                        coverUrl: rec.coverUrl,
                        episodeCount: rec.episodeCount,
                        feedUrl: rec.feedUrl,
                        itunesId: rec.itunesId,
                        isExternal: true,
                        score: rec.score,
                    }))
                );
            }

            // Fetch from iTunes Search API
            logger.debug(`    Fetching from iTunes Search API...`);
            const { itunesService } = await import("../services/itunes");
            const recommendations = await itunesService.getSimilarPodcasts(
                podcast.title,
                podcast.description ?? undefined,
                podcast.author ?? undefined
            );

            logger.debug(`   Found ${recommendations.length} similar podcasts`);

            if (recommendations.length > 0) {
                // Cache recommendations
                const expiresAt = new Date();
                expiresAt.setDate(expiresAt.getDate() + 30); // 30 days cache

                await prisma.podcastRecommendation.deleteMany({
                    where: { podcastId: id },
                });

                await prisma.podcastRecommendation.createMany({
                    data: recommendations.map((rec, index) => ({
                        podcastId: id,
                        recommendedId: rec.collectionId.toString(),
                        title: rec.collectionName,
                        author: rec.artistName,
                        description: "",
                        coverUrl: rec.artworkUrl600 || rec.artworkUrl100,
                        episodeCount: rec.trackCount || 0,
                        feedUrl: rec.feedUrl,
                        itunesId: rec.collectionId.toString(),
                        score: recommendations.length - index,
                        cachedAt: new Date(),
                        expiresAt,
                    })),
                });

                logger.debug(
                    `   Cached ${recommendations.length} recommendations`
                );

                return res.json(
                    recommendations.map((rec, index) => ({
                        id: rec.collectionId.toString(),
                        title: rec.collectionName,
                        author: rec.artistName,
                        description: "",
                        coverUrl: rec.artworkUrl600 || rec.artworkUrl100,
                        episodeCount: rec.trackCount || 0,
                        feedUrl: rec.feedUrl,
                        itunesId: rec.collectionId,
                        isExternal: true,
                        score: recommendations.length - index,
                    }))
                );
            }
        } catch (error: any) {
            logger.warn("    iTunes search failed:", error.message);
        }

        // No recommendations available
        logger.debug(`    No recommendations found`);
        res.json([]);
    } catch (error) {
        safeError(res, "Error fetching similar podcasts", error);
    }
});

/**
 * OPTIONS /podcasts/:id/cover
 * Handle CORS preflight request for podcast cover images
 */
router.options("/:id/cover", (req, res) => {
    const origin = req.headers.origin || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
    res.status(204).end();
});

/**
 * GET /podcasts/:id/cover
 * Serve cached podcast cover from local disk
 */
router.get("/:id/cover", async (req, res) => {
    try {
        const { id } = req.params;

        const podcast = await prisma.podcast.findUnique({
            where: { id },
            select: { localCoverPath: true, imageUrl: true },
        });

        if (!podcast) {
            return res.status(404).json({ error: "Podcast not found" });
        }

        // Serve from local disk if cached
        if (podcast.localCoverPath) {
            res.setHeader(
                "Cache-Control",
                "public, max-age=31536000, immutable"
            );
            res.setHeader(
                "Access-Control-Allow-Origin",
                req.headers.origin || "*"
            );
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            return res.sendFile(podcast.localCoverPath);
        }

        // Fallback: redirect to original URL
        if (podcast.imageUrl) {
            return res.redirect(podcast.imageUrl);
        }

        res.status(404).json({ error: "Cover not found" });
    } catch (error) {
        safeError(res, "Error serving podcast cover", error);
    }
});

/**
 * OPTIONS /podcasts/episodes/:episodeId/cover
 * Handle CORS preflight request for episode cover images
 */
router.options("/episodes/:episodeId/cover", (req, res) => {
    const origin = req.headers.origin || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
    res.status(204).end();
});

/**
 * GET /podcasts/episodes/:episodeId/cover
 * Serve cached episode cover from local disk
 */
router.get("/episodes/:episodeId/cover", async (req, res) => {
    try {
        const { episodeId } = req.params;

        const episode = await prisma.podcastEpisode.findUnique({
            where: { id: episodeId },
            select: { localCoverPath: true, imageUrl: true },
        });

        if (!episode) {
            return res.status(404).json({ error: "Episode not found" });
        }

        // Serve from local disk if cached
        if (episode.localCoverPath) {
            res.setHeader(
                "Cache-Control",
                "public, max-age=31536000, immutable"
            );
            res.setHeader(
                "Access-Control-Allow-Origin",
                req.headers.origin || "*"
            );
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            return res.sendFile(episode.localCoverPath);
        }

        // Fallback: redirect to original URL
        if (episode.imageUrl) {
            return res.redirect(episode.imageUrl);
        }

        res.status(404).json({ error: "Cover not found" });
    } catch (error) {
        safeError(res, "Error serving episode cover", error);
    }
});

/**
 * Refresh a single podcast feed -- shared logic used by both the route handler
 * and the enrichment worker's automatic refresh phase.
 */
export async function refreshPodcastFeed(podcastId: string): Promise<{ newEpisodesCount: number; totalEpisodes: number }> {
    const podcast = await prisma.podcast.findUnique({ where: { id: podcastId } });
    if (!podcast) throw new Error(`Podcast ${podcastId} not found`);

    const { podcast: podcastData, episodes } = await rssParserService.parseFeed(podcast.feedUrl);

    await prisma.podcast.update({
        where: { id: podcastId },
        data: {
            title: podcastData.title,
            author: podcastData.author,
            description: podcastData.description,
            imageUrl: podcastData.imageUrl,
            language: podcastData.language,
            explicit: podcastData.explicit || false,
            episodeCount: episodes.length,
            lastRefreshed: new Date(),
        },
    });

    // Batch fetch all existing GUIDs to avoid N+1 queries
    const feedGuids = episodes.map(e => e.guid).filter(Boolean);
    const existingGuids = new Set(
        (await prisma.podcastEpisode.findMany({
            where: { podcastId, guid: { in: feedGuids } },
            select: { guid: true },
        })).map(e => e.guid)
    );

    let newEpisodesCount = 0;
    for (const ep of episodes) {
        if (existingGuids.has(ep.guid)) continue;

        await prisma.podcastEpisode.create({
            data: {
                podcastId,
                guid: ep.guid,
                title: ep.title,
                description: ep.description,
                audioUrl: ep.audioUrl,
                duration: ep.duration,
                publishedAt: ep.publishedAt,
                episodeNumber: ep.episodeNumber,
                season: ep.season,
                imageUrl: ep.imageUrl,
                fileSize: ep.fileSize,
                mimeType: ep.mimeType,
            },
        });
        newEpisodesCount++;
    }

    return { newEpisodesCount, totalEpisodes: episodes.length };
}

export default router;
