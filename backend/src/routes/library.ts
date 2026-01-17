import { Router, Response } from "express";
import { requireAuth, requireAuthOrToken } from "../middleware/auth";
import { imageLimiter, apiLimiter } from "../middleware/rateLimiter";
import { lastFmService } from "../services/lastfm";
import { prisma, Prisma } from "../utils/db";
import { getEnrichmentProgress } from "../workers/enrichment";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import crypto from "crypto";
import path from "path";
import fs from "fs";

// Static imports for performance (avoid dynamic imports in hot paths)
import { config } from "../config";
import { fanartService } from "../services/fanart";
import { deezerService } from "../services/deezer";
import { musicBrainzService } from "../services/musicbrainz";
import { coverArtService } from "../services/coverArt";
import { getSystemSettings } from "../utils/systemSettings";
import { AudioStreamingService } from "../services/audioStreaming";
import { scanQueue } from "../workers/queues";
import { organizeSingles } from "../workers/organizeSingles";
import { enrichSimilarArtist } from "../workers/artistEnrichment";
import { extractColorsFromImage } from "../utils/colorExtractor";
import { dataCacheService } from "../services/dataCache";
import {
    getMergedGenres,
    getArtistDisplaySummary,
} from "../utils/metadataOverrides";
import {
    getEffectiveYear,
    getDecadeWhereClause,
    getDecadeFromYear,
} from "../utils/dateFilters";

const router = Router();

// Maximum items per request to prevent DoS attacks while supporting large libraries
const MAX_LIMIT = 10000;

const applyCoverArtCorsHeaders = (res: Response, origin?: string) => {
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
    } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
};

// All routes require auth (session or API key)
router.use(requireAuthOrToken);

// Apply API rate limiter to routes that need it
// Skip rate limiting for high-traffic endpoints (cover-art, streaming)
router.use((req, res, next) => {
    // Skip rate limiting for cover-art endpoint (handled by imageLimiter separately)
    if (req.path.startsWith("/cover-art")) {
        return next();
    }
    // Skip rate limiting for streaming endpoints - audio must not be interrupted
    if (req.path.includes("/stream")) {
        return next();
    }
    // Apply API rate limiter to all other routes
    return apiLimiter(req, res, next);
});

/**
 * @openapi
 * /library/scan:
 *   post:
 *     summary: Start a library scan job
 *     description: Initiates a background job to scan the music directory and index all audio files
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Library scan started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Library scan started"
 *                 jobId:
 *                   type: string
 *                   description: Job ID to track progress
 *                   example: "123"
 *                 musicPath:
 *                   type: string
 *                   example: "/path/to/music"
 *       500:
 *         description: Failed to start scan
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/scan", async (req, res) => {
    try {
        if (!config.music.musicPath) {
            return res.status(500).json({
                error: "Music path not configured. Please set MUSIC_PATH environment variable.",
            });
        }

        // First, organize any SLSKD downloads from Docker container to music library
        // This ensures files are moved before the scan finds them
        try {
            const { organizeSingles } = await import(
                "../workers/organizeSingles"
            );
            logger.info("[Scan] Organizing SLSKD downloads before scan...");
            await organizeSingles();
            logger.info("[Scan] SLSKD organization complete");
        } catch (err: any) {
            // Not a fatal error - SLSKD might not be running or have no files
            logger.info("[Scan] SLSKD organization skipped:", err.message);
        }

        const userId = req.user?.id || "system";

        // Add scan job to queue
        const job = await scanQueue.add("scan", {
            userId,
            musicPath: config.music.musicPath,
        });

        res.json({
            message: "Library scan started",
            jobId: job.id,
            musicPath: config.music.musicPath,
        });
    } catch (error) {
        logger.error("Scan trigger error:", error);
        res.status(500).json({ error: "Failed to start scan" });
    }
});

// GET /library/scan/status/:jobId - Check scan job status
router.get("/scan/status/:jobId", async (req, res) => {
    try {
        const job = await scanQueue.getJob(req.params.jobId);

        if (!job) {
            return res.status(404).json({ error: "Job not found" });
        }

        const state = await job.getState();
        const progress = job.progress();
        const result = job.returnvalue;

        res.json({
            status: state,
            progress,
            result,
        });
    } catch (error) {
        logger.error("Get scan status error:", error);
        res.status(500).json({ error: "Failed to get job status" });
    }
});

// POST /library/organize - Manually trigger organization script
router.post("/organize", async (req, res) => {
    try {
        // Run in background
        organizeSingles().catch((err) => {
            logger.error("Manual organization failed:", err);
        });

        res.json({ message: "Organization started in background" });
    } catch (error) {
        logger.error("Organization trigger error:", error);
        res.status(500).json({ error: "Failed to start organization" });
    }
});

// POST /library/artists/:id/enrich - Manually enrich artist metadata
router.post("/artists/:id/enrich", async (req, res) => {
    try {
        const artist = await prisma.artist.findUnique({
            where: { id: req.params.id },
        });

        if (!artist) {
            return res.status(404).json({ error: "Artist not found" });
        }

        // Use enrichment functions

        // Run enrichment in background
        enrichSimilarArtist(artist).catch((err) => {
            logger.error(`Failed to enrich artist ${artist.name}:`, err);
        });

        res.json({ message: "Artist enrichment started in background" });
    } catch (error) {
        logger.error("Enrich artist error:", error);
        res.status(500).json({ error: "Failed to enrich artist" });
    }
});

// GET /library/enrichment-progress - Get enrichment worker progress
router.get("/enrichment-progress", async (req, res) => {
    try {
        const progress = await getEnrichmentProgress();
        res.json(progress);
    } catch (error) {
        logger.error("Failed to get enrichment progress:", error);
        res.status(500).json({ error: "Failed to get enrichment progress" });
    }
});

// POST /library/re-enrich-all - Re-enrich all artists with missing images (no auth required for convenience)
router.post("/re-enrich-all", async (req, res) => {
    try {
        // Reset all artists that have no heroUrl to "pending"
        const result = await prisma.artist.updateMany({
            where: {
                OR: [{ heroUrl: null }, { heroUrl: "" }],
            },
            data: {
                enrichmentStatus: "pending",
                lastEnriched: null,
            },
        });

        logger.debug(
            ` Reset ${result.count} artists with missing images to pending`
        );

        res.json({
            message: `Reset ${result.count} artists for re-enrichment`,
            count: result.count,
        });
    } catch (error) {
        logger.error("Failed to reset artists:", error);
        res.status(500).json({ error: "Failed to reset artists" });
    }
});

// GET /library/recently-listened?limit=10
router.get("/recently-listened", async (req, res) => {
    try {
        const { limit = "10" } = req.query;
        const userId = req.user!.id;
        const limitNum = parseInt(limit as string, 10);

        const [recentPlays, inProgressAudiobooks, inProgressPodcasts] =
            await Promise.all([
                prisma.play.findMany({
                    where: {
                        userId,
                        // Exclude pure discovery plays (only show library and kept discovery)
                        source: { in: ["LIBRARY", "DISCOVERY_KEPT"] },
                        // Also filter by album location to exclude discovery albums
                        track: {
                            album: {
                                location: "LIBRARY",
                            },
                        },
                    },
                    orderBy: { playedAt: "desc" },
                    take: limitNum * 3, // Get more than needed to account for duplicates
                    include: {
                        track: {
                            include: {
                                album: {
                                    include: {
                                        artist: {
                                            select: {
                                                id: true,
                                                mbid: true,
                                                name: true,
                                                heroUrl: true,
                                                userHeroUrl: true,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                }),
                prisma.audiobookProgress.findMany({
                    where: {
                        userId,
                        isFinished: false,
                        currentTime: { gt: 0 }, // Only show if actually started
                    },
                    orderBy: { lastPlayedAt: Prisma.SortOrder.desc },
                    take: Math.ceil(limitNum / 3), // Get up to 1/3 for audiobooks
                }),
                prisma.podcastProgress.findMany({
                    where: {
                        userId,
                        isFinished: false,
                        currentTime: { gt: 0 }, // Only show if actually started
                    },
                    orderBy: { lastPlayedAt: Prisma.SortOrder.desc },
                    take: limitNum * 2, // Get extra to account for deduplication
                    include: {
                        episode: {
                            include: {
                                podcast: {
                                    select: {
                                        id: true,
                                        title: true,
                                        author: true,
                                        imageUrl: true,
                                    },
                                },
                            },
                        },
                    },
                }),
            ]);

        // Deduplicate podcasts - keep only the most recently played episode per podcast
        const seenPodcasts = new Set();
        const uniquePodcasts = inProgressPodcasts
            .filter((pp) => {
                const podcastId = pp.episode.podcast.id;
                if (seenPodcasts.has(podcastId)) {
                    return false;
                }
                seenPodcasts.add(podcastId);
                return true;
            })
            .slice(0, Math.ceil(limitNum / 3)); // Limit to 1/3 after deduplication

        // Extract unique artists and audiobooks
        const items: any[] = [];
        const artistsMap = new Map();

        // Add music artists
        for (const play of recentPlays) {
            const artist = play.track.album.artist;
            if (!artistsMap.has(artist.id)) {
                artistsMap.set(artist.id, {
                    ...artist,
                    type: "artist",
                    lastPlayedAt: play.playedAt,
                });
            }
            if (items.length >= limitNum) break;
        }

        // Combine artists, audiobooks, and podcasts
        const combined = [
            ...Array.from(artistsMap.values()),
            ...inProgressAudiobooks.map((ab: any) => {
                // For audiobooks, prefix the path with 'audiobook__' so the frontend knows to use the audiobook endpoint
                const coverArt =
                    ab.coverUrl && !ab.coverUrl.startsWith("http")
                        ? `audiobook__${ab.coverUrl}`
                        : ab.coverUrl;

                return {
                    id: ab.audiobookshelfId,
                    name: ab.title,
                    coverArt,
                    type: "audiobook",
                    author: ab.author,
                    progress:
                        ab.duration > 0
                            ? Math.round((ab.currentTime / ab.duration) * 100)
                            : 0,
                    lastPlayedAt: ab.lastPlayedAt,
                };
            }),
            ...uniquePodcasts.map((pp: any) => ({
                id: pp.episode.podcast.id,
                episodeId: pp.episodeId,
                name: pp.episode.podcast.title,
                coverArt: pp.episode.podcast.imageUrl,
                type: "podcast",
                author: pp.episode.podcast.author,
                progress:
                    pp.duration > 0
                        ? Math.round((pp.currentTime / pp.duration) * 100)
                        : 0,
                lastPlayedAt: pp.lastPlayedAt,
            })),
        ];

        // Sort by lastPlayedAt and limit
        combined.sort(
            (a, b) =>
                new Date(b.lastPlayedAt).getTime() -
                new Date(a.lastPlayedAt).getTime()
        );
        const limitedItems = combined.slice(0, limitNum);

        // Get album counts for artists
        const artistIds = limitedItems
            .filter((item) => item.type === "artist")
            .map((item) => item.id);
        const albumCounts = await prisma.ownedAlbum.groupBy({
            by: ["artistId"],
            where: { artistId: { in: artistIds } },
            _count: { rgMbid: true },
        });
        const albumCountMap = new Map(
            albumCounts.map((ac) => [ac.artistId, ac._count.rgMbid])
        );

        // Map results - no on-demand image fetching for performance
        // Artists without images will show placeholders until enrichment completes
        const results = limitedItems.map((item) => {
            if (item.type === "audiobook" || item.type === "podcast") {
                return item;
            } else {
                // Use override pattern: userHeroUrl ?? heroUrl
                const coverArt = item.userHeroUrl ?? item.heroUrl ?? null;
                return {
                    ...item,
                    coverArt,
                    albumCount: albumCountMap.get(item.id) || 0,
                };
            }
        });

        res.json({ items: results });
    } catch (error) {
        logger.error("Get recently listened error:", error);
        res.status(500).json({ error: "Failed to fetch recently listened" });
    }
});

// GET /library/recently-added?limit=10
router.get("/recently-added", async (req, res) => {
    try {
        const { limit = "10" } = req.query;
        const limitNum = parseInt(limit as string, 10);

        // Get the 20 most recently added LIBRARY albums (by lastSynced timestamp)
        // This limits "Recently Added" to actual recent additions, not the entire library
        const recentAlbums = await prisma.album.findMany({
            where: {
                location: "LIBRARY",
                tracks: { some: {} }, // Only albums with actual tracks
            },
            orderBy: { lastSynced: "desc" },
            take: 20, // Hard limit to last 20 albums
            include: {
                artist: {
                    select: {
                        id: true,
                        mbid: true,
                        name: true,
                        heroUrl: true,
                        userHeroUrl: true,
                    },
                },
            },
        });

        // Extract unique artists from recent albums (preserving order of most recent)
        const artistsMap = new Map();
        for (const album of recentAlbums) {
            if (!artistsMap.has(album.artist.id)) {
                artistsMap.set(album.artist.id, album.artist);
            }
            if (artistsMap.size >= limitNum) break;
        }

        // Get album counts for each artist (only LIBRARY albums)
        const artistIds = Array.from(artistsMap.keys());
        const albumCounts = await prisma.album.groupBy({
            by: ["artistId"],
            where: {
                artistId: { in: artistIds },
                location: "LIBRARY",
                tracks: { some: {} },
            },
            _count: { id: true },
        });
        const albumCountMap = new Map(
            albumCounts.map((ac) => [ac.artistId, ac._count.id])
        );

        // Map results - no on-demand image fetching for performance
        // Artists without images will show placeholders until enrichment completes
        const artistsWithImages = Array.from(artistsMap.values()).map((artist) => {
            // Use override pattern: userHeroUrl ?? heroUrl
            const coverArt = artist.userHeroUrl ?? artist.heroUrl ?? null;
            return {
                ...artist,
                coverArt,
                albumCount: albumCountMap.get(artist.id) || 0,
            };
        });

        res.json({ artists: artistsWithImages });
    } catch (error) {
        logger.error("Get recently added error:", error);
        res.status(500).json({ error: "Failed to fetch recently added" });
    }
});

// GET /library/artists?query=&limit=&offset=&filter=owned|discovery|all
router.get("/artists", async (req, res) => {
    try {
        const {
            query = "",
            limit: limitParam = "500",
            offset: offsetParam = "0",
            filter = "owned", // owned (default), discovery, all
        } = req.query;
        const limit = Math.min(
            parseInt(limitParam as string, 10) || 500,
            MAX_LIMIT
        );
        const offset = parseInt(offsetParam as string, 10) || 0;

        // Build where clause based on filter
        let where: any = {
            albums: {
                some: {
                    tracks: { some: {} }, // Only artists with albums that have actual tracks
                },
            },
        };

        if (filter === "owned") {
            // Artists with at least 1 LIBRARY album OR an OwnedAlbum record (liked discovery)
            where.OR = [
                {
                    albums: {
                        some: {
                            location: "LIBRARY",
                            tracks: { some: {} },
                        },
                    },
                },
                {
                    // Include artists with OwnedAlbum records (includes liked discovery albums)
                    ownedAlbums: {
                        some: {},
                    },
                    albums: {
                        some: {
                            tracks: { some: {} },
                        },
                    },
                },
            ];
        } else if (filter === "discovery") {
            // Artists with ONLY DISCOVERY albums (no LIBRARY albums)
            where = {
                AND: [
                    {
                        albums: {
                            some: {
                                location: "DISCOVER",
                                tracks: { some: {} },
                            },
                        },
                    },
                    {
                        albums: {
                            none: {
                                location: "LIBRARY",
                            },
                        },
                    },
                ],
            };
        }
        // filter === "all" uses the default (any albums with tracks)

        if (query) {
            if (where.AND) {
                where.AND.push({
                    name: { contains: query as string, mode: "insensitive" },
                });
            } else {
                where.name = { contains: query as string, mode: "insensitive" };
            }
        }

        // Determine which album location to count based on filter
        const albumLocationFilter =
            filter === "discovery"
                ? "DISCOVER"
                : filter === "all"
                ? undefined
                : "LIBRARY";

        const [artistsWithAlbums, total] = await Promise.all([
            prisma.artist.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy: { name: "asc" },
                select: {
                    id: true,
                    mbid: true,
                    name: true,
                    heroUrl: true,
                    userHeroUrl: true,
                    albums: {
                        where: {
                            ...(albumLocationFilter
                                ? { location: albumLocationFilter }
                                : {}),
                            tracks: { some: {} },
                        },
                        select: {
                            id: true,
                            _count: {
                                select: { tracks: true },
                            },
                        },
                    },
                },
            }),
            prisma.artist.count({ where }),
        ]);

        // Use DataCacheService for batch image lookup (DB + Redis, no API calls for lists)
        // NOTE: On-demand image fetching removed for performance - rely on enrichment worker
        // Artists without images will show placeholders until enrichment completes
        const imageMap = await dataCacheService.getArtistImagesBatch(
            artistsWithAlbums.map((a) => ({
                id: a.id,
                heroUrl: a.heroUrl,
                userHeroUrl: a.userHeroUrl,
            }))
        );

        const artistsWithImages = artistsWithAlbums.map((artist) => {
            const coverArt =
                imageMap.get(artist.id) ||
                artist.heroUrl ||
                null;
            // Sum up track counts from all albums
            const trackCount = artist.albums.reduce(
                (sum, album) => sum + (album._count?.tracks || 0),
                0
            );
            return {
                id: artist.id,
                mbid: artist.mbid,
                name: artist.name,
                heroUrl: coverArt,
                coverArt, // Alias for frontend consistency
                albumCount: artist.albums.length,
                trackCount,
            };
        });

        res.json({
            artists: artistsWithImages,
            total,
            offset,
            limit,
        });
    } catch (error: any) {
        logger.error("[Library] Get artists error:", error?.message || error);
        logger.error("[Library] Stack:", error?.stack);
        res.status(500).json({
            error: "Failed to fetch artists",
            details: error?.message,
        });
    }
});

// GET /library/enrichment-diagnostics - Debug why artist images aren't populating
router.get("/enrichment-diagnostics", async (req, res) => {
    try {
        // Get enrichment status breakdown
        const statusCounts = await prisma.artist.groupBy({
            by: ["enrichmentStatus"],
            _count: true,
        });

        // Get artists that completed enrichment but have no heroUrl
        const completedNoImage = await prisma.artist.count({
            where: {
                enrichmentStatus: "completed",
                OR: [{ heroUrl: null }, { heroUrl: "" }],
            },
        });

        // Get artists with temp MBIDs (can't use Fanart.tv)
        const tempMbidCount = await prisma.artist.count({
            where: {
                mbid: { startsWith: "temp-" },
            },
        });

        // Sample of artists with issues
        const problemArtists = await prisma.artist.findMany({
            where: {
                enrichmentStatus: "completed",
                OR: [{ heroUrl: null }, { heroUrl: "" }],
            },
            select: {
                id: true,
                name: true,
                mbid: true,
                enrichmentStatus: true,
                lastEnriched: true,
            },
            take: 10,
        });

        // Sample of failed artists
        const failedArtists = await prisma.artist.findMany({
            where: {
                enrichmentStatus: "failed",
            },
            select: {
                id: true,
                name: true,
                mbid: true,
                lastEnriched: true,
            },
            take: 10,
        });

        res.json({
            summary: {
                statusBreakdown: statusCounts.reduce((acc, s) => {
                    acc[s.enrichmentStatus || "unknown"] = s._count;
                    return acc;
                }, {} as Record<string, number>),
                completedWithoutImage: completedNoImage,
                tempMbidArtists: tempMbidCount,
            },
            problemArtists,
            failedArtists,
            suggestions: [
                completedNoImage > 0
                    ? `${completedNoImage} artists completed enrichment but have no image - external APIs may be failing or rate limited`
                    : null,
                tempMbidCount > 0
                    ? `${tempMbidCount} artists have temp MBIDs - Fanart.tv won't work for them, relies on Deezer/Last.fm`
                    : null,
                statusCounts.find((s) => s.enrichmentStatus === "pending")
                    ?._count
                    ? "Enrichment still in progress - check logs"
                    : null,
                statusCounts.find((s) => s.enrichmentStatus === "failed")
                    ?._count
                    ? "Some artists failed enrichment - may need retry"
                    : null,
            ].filter(Boolean),
        });
    } catch (error: any) {
        logger.error("[Library] Enrichment diagnostics error:", error?.message);
        res.status(500).json({ error: "Failed to get diagnostics" });
    }
});

// POST /library/retry-enrichment - Retry failed enrichments
router.post("/retry-enrichment", async (req, res) => {
    try {
        // Reset failed artists to pending so worker picks them up
        const result = await prisma.artist.updateMany({
            where: { enrichmentStatus: "failed" },
            data: { enrichmentStatus: "pending" },
        });

        res.json({
            message: `Reset ${result.count} failed artists to pending`,
            count: result.count,
        });
    } catch (error: any) {
        logger.error("[Library] Retry enrichment error:", error?.message);
        res.status(500).json({ error: "Failed to retry enrichment" });
    }
});

// POST /library/backfill-genres - Backfill genres for artists missing them
router.post("/backfill-genres", async (req, res) => {
    try {
        // Find artists that have been enriched but have no genres
        const artistsToBackfill = await prisma.artist.findMany({
            where: {
                enrichmentStatus: "completed",
                OR: [
                    { genres: { equals: Prisma.DbNull } },
                    { genres: { equals: [] } },
                ],
            },
            select: { id: true, name: true, mbid: true },
            take: 50, // Process in batches
        });

        if (artistsToBackfill.length === 0) {
            return res.json({
                message: "No artists need genre backfill",
                count: 0,
            });
        }

        // Reset these artists to pending so enrichment worker re-processes them
        const result = await prisma.artist.updateMany({
            where: {
                id: { in: artistsToBackfill.map((a) => a.id) },
            },
            data: {
                enrichmentStatus: "pending",
                lastEnriched: null,
            },
        });

        logger.info(
            `[Backfill] Reset ${result.count} artists for genre enrichment`
        );

        res.json({
            message: `Reset ${result.count} artists for genre enrichment`,
            count: result.count,
            artists: artistsToBackfill.map((a) => a.name).slice(0, 10),
        });
    } catch (error: any) {
        logger.error("[Backfill] Genre backfill error:", error?.message);
        res.status(500).json({ error: "Failed to backfill genres" });
    }
});

// GET /library/artists/:id
router.get("/artists/:id", async (req, res) => {
    try {
        const idParam = req.params.id;

        const artistInclude = {
            albums: {
                orderBy: { year: Prisma.SortOrder.desc },
                include: {
                    tracks: {
                        orderBy: { trackNo: Prisma.SortOrder.asc },
                        take: 10, // Top tracks
                        include: {
                            album: {
                                select: {
                                    id: true,
                                    title: true,
                                    coverUrl: true,
                                },
                            },
                        },
                    },
                },
            },
            ownedAlbums: true,
            // Note: similarFrom (FK-based) is no longer used for display
            // We now use similarArtistsJson which is fetched by default
        };

        // Try finding by ID first
        let artist = await prisma.artist.findUnique({
            where: { id: idParam },
            include: artistInclude,
        });

        // If not found by ID, try by name (for URL-encoded names)
        if (!artist) {
            const decodedName = decodeURIComponent(idParam);
            artist = await prisma.artist.findFirst({
                where: {
                    name: {
                        equals: decodedName,
                        mode: "insensitive",
                    },
                },
                include: artistInclude,
            });
        }

        // If not found and param looks like an MBID, try looking up by MBID
        if (
            !artist &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                idParam
            )
        ) {
            artist = await prisma.artist.findFirst({
                where: { mbid: idParam },
                include: artistInclude,
            });
        }

        if (!artist) {
            return res.status(404).json({ error: "Artist not found" });
        }

        // ========== DISCOGRAPHY HANDLING ==========
        // For enriched artists with ownedAlbums, skip expensive MusicBrainz calls
        // Only fetch from MusicBrainz if the artist hasn't been enriched yet
        let albumsWithOwnership = [];
        const ownedRgMbids = new Set(artist.ownedAlbums.map((o) => o.rgMbid));
        const isEnriched =
            artist.ownedAlbums.length > 0 || artist.heroUrl !== null;

        // If artist has temp MBID, try to find real MBID by searching MusicBrainz
        let effectiveMbid = artist.mbid;
        if (!effectiveMbid || effectiveMbid.startsWith("temp-")) {
            logger.debug(
                ` Artist has temp/no MBID, searching MusicBrainz for ${artist.name}...`
            );
            try {
                const searchResults = await musicBrainzService.searchArtist(
                    artist.name,
                    1
                );
                if (searchResults.length > 0) {
                    effectiveMbid = searchResults[0].id;
                    logger.debug(`  Found MBID: ${effectiveMbid}`);

                    // Update database with real MBID for future use (skip if duplicate)
                    try {
                        await prisma.artist.update({
                            where: { id: artist.id },
                            data: { mbid: effectiveMbid },
                        });
                    } catch (mbidError: any) {
                        // If MBID already exists for another artist, just log and continue
                        if (mbidError.code === "P2002") {
                            logger.debug(
                                `MBID ${effectiveMbid} already exists for another artist, skipping update`
                            );
                        } else {
                            logger.error(
                                `  ✗ Failed to update MBID:`,
                                mbidError
                            );
                        }
                    }
                } else {
                    logger.debug(
                        `  ✗ No MusicBrainz match found for ${artist.name}`
                    );
                }
            } catch (error) {
                logger.error(` MusicBrainz search failed:`, error);
            }
        }

        // ========== ALWAYS include albums from database (actual owned files) ==========
        // These are albums with actual tracks on disk - they MUST show as owned
        const dbAlbums = artist.albums.map((album) => ({
            ...album,
            owned: true, // If it's in the database with tracks, user owns it!
            coverArt: album.coverUrl,
            source: "database" as const,
        }));

        logger.debug(
            `[Artist] Found ${dbAlbums.length} albums from database (actual owned files)`
        );

        // ========== Supplement with MusicBrainz discography for "available to download" ==========
        // Always fetch discography if we have a valid MBID - users need to see what's available
        const hasDbAlbums = dbAlbums.length > 0;
        const shouldFetchDiscography =
            effectiveMbid && !effectiveMbid.startsWith("temp-");

        if (shouldFetchDiscography) {
            try {
                // Check Redis cache first (cache for 24 hours)
                const discoCacheKey = `discography:${effectiveMbid}`;
                let releaseGroups: any[] = [];

                const cachedDisco = await redisClient.get(discoCacheKey);
                if (cachedDisco && cachedDisco !== "NOT_FOUND") {
                    releaseGroups = JSON.parse(cachedDisco);
                    logger.debug(
                        `[Artist] Using cached discography (${releaseGroups.length} albums)`
                    );
                } else {
                    logger.debug(
                        `[Artist] Fetching discography from MusicBrainz...`
                    );
                    releaseGroups = await musicBrainzService.getReleaseGroups(
                        effectiveMbid,
                        ["album", "ep"],
                        100
                    );
                    // Cache for 24 hours
                    await redisClient.setEx(
                        discoCacheKey,
                        24 * 60 * 60,
                        JSON.stringify(releaseGroups)
                    );
                }

                logger.debug(
                    `  Got ${releaseGroups.length} albums from MusicBrainz (before filtering)`
                );

                // Filter out live albums, compilations, soundtracks, remixes, etc.
                const excludedSecondaryTypes = [
                    "Live",
                    "Compilation",
                    "Soundtrack",
                    "Remix",
                    "DJ-mix",
                    "Mixtape/Street",
                    "Demo",
                    "Interview",
                    "Audio drama",
                    "Audiobook",
                    "Spokenword",
                ];

                const filteredReleaseGroups = releaseGroups.filter(
                    (rg: any) => {
                        // Keep if no secondary types (pure studio album/EP)
                        if (
                            !rg["secondary-types"] ||
                            rg["secondary-types"].length === 0
                        ) {
                            return true;
                        }
                        // Exclude if any secondary type matches our exclusion list
                        return !rg["secondary-types"].some((type: string) =>
                            excludedSecondaryTypes.includes(type)
                        );
                    }
                );

                logger.debug(
                    `  Filtered to ${filteredReleaseGroups.length} studio albums/EPs`
                );

                // Transform MusicBrainz release groups to album format
                // PERFORMANCE: Only check Redis cache for covers, don't make API calls
                // This makes artist pages load instantly after the first visit
                const mbAlbums = await Promise.all(
                    filteredReleaseGroups.map(async (rg: any) => {
                        let coverUrl = null;

                        // Only check Redis cache - don't make external API calls
                        // Covers will be fetched lazily by the frontend or during enrichment
                        const cacheKey = `caa:${rg.id}`;
                        try {
                            const cached = await redisClient.get(cacheKey);
                            if (cached && cached !== "NOT_FOUND") {
                                coverUrl = cached;
                            }
                        } catch (err) {
                            // Redis error, continue without cover
                        }

                        return {
                            id: rg.id,
                            rgMbid: rg.id,
                            title: rg.title,
                            year: rg["first-release-date"]
                                ? parseInt(
                                      rg["first-release-date"].substring(0, 4)
                                  )
                                : null,
                            type: rg["primary-type"],
                            coverUrl,
                            coverArt: coverUrl,
                            artistId: artist.id,
                            owned: ownedRgMbids.has(rg.id),
                            trackCount: 0,
                            tracks: [],
                            source: "musicbrainz" as const,
                        };
                    })
                );

                // Merge database albums with MusicBrainz albums
                // Database albums take precedence (they have actual files!)
                const dbAlbumTitles = new Set(
                    dbAlbums.map((a) => a.title.toLowerCase())
                );
                const mbAlbumsFiltered = mbAlbums.filter(
                    (a) => !dbAlbumTitles.has(a.title.toLowerCase())
                );

                albumsWithOwnership = [...dbAlbums, ...mbAlbumsFiltered];

                logger.debug(
                    `  Total albums: ${albumsWithOwnership.length} (${dbAlbums.length} owned from database, ${mbAlbumsFiltered.length} from MusicBrainz)`
                );
                logger.debug(
                    `  Owned: ${
                        albumsWithOwnership.filter((a) => a.owned).length
                    }, Available: ${
                        albumsWithOwnership.filter((a) => !a.owned).length
                    }`
                );
            } catch (error) {
                logger.error(`Failed to fetch MusicBrainz discography:`, error);
                // Just use database albums
                albumsWithOwnership = dbAlbums;
            }
        } else {
            // No valid MBID - just use database albums
            logger.debug(
                `[Artist] No valid MBID, using ${dbAlbums.length} albums from database`
            );
            albumsWithOwnership = dbAlbums;
        }

        // Extract top tracks from library first
        const allTracks = artist.albums.flatMap((a) => a.tracks);
        let topTracks = allTracks.slice(0, 10);

        // Get user play counts for all tracks
        const userId = req.user!.id;
        const trackIds = allTracks.map((t) => t.id);
        const userPlays = await prisma.play.groupBy({
            by: ["trackId"],
            where: {
                userId,
                trackId: { in: trackIds },
            },
            _count: {
                id: true,
            },
        });
        const userPlayCounts = new Map(
            userPlays.map((p) => [p.trackId, p._count.id])
        );

        // Fetch Last.fm top tracks (cached for 24 hours)
        const topTracksCacheKey = `top-tracks:${artist.id}`;
        try {
            // Check cache first
            const cachedTopTracks = await redisClient.get(topTracksCacheKey);
            let lastfmTopTracks: any[] = [];

            if (cachedTopTracks && cachedTopTracks !== "NOT_FOUND") {
                lastfmTopTracks = JSON.parse(cachedTopTracks);
                logger.debug(
                    `[Artist] Using cached top tracks (${lastfmTopTracks.length})`
                );
            } else {
                // Cache miss - fetch from Last.fm
                const validMbid =
                    effectiveMbid && !effectiveMbid.startsWith("temp-")
                        ? effectiveMbid
                        : "";
                lastfmTopTracks = await lastFmService.getArtistTopTracks(
                    validMbid,
                    artist.name,
                    10
                );
                // Cache for 24 hours
                await redisClient.setEx(
                    topTracksCacheKey,
                    24 * 60 * 60,
                    JSON.stringify(lastfmTopTracks)
                );
                logger.debug(
                    `[Artist] Cached ${lastfmTopTracks.length} top tracks`
                );
            }

            // For each Last.fm track, try to match with library track or add as unowned
            const combinedTracks: any[] = [];

            for (const lfmTrack of lastfmTopTracks) {
                // Try to find matching track in library
                const matchedTrack = allTracks.find(
                    (t) => t.title.toLowerCase() === lfmTrack.name.toLowerCase()
                );

                if (matchedTrack) {
                    // Track exists in library - include user play count
                    combinedTracks.push({
                        ...matchedTrack,
                        playCount: lfmTrack.playcount
                            ? parseInt(lfmTrack.playcount)
                            : 0,
                        listeners: lfmTrack.listeners
                            ? parseInt(lfmTrack.listeners)
                            : 0,
                        userPlayCount: userPlayCounts.get(matchedTrack.id) || 0,
                        album: {
                            ...matchedTrack.album,
                            coverArt: matchedTrack.album.coverUrl,
                        },
                    });
                } else {
                    // Track NOT in library - add as preview-only track
                    combinedTracks.push({
                        id: `lastfm-${artist.mbid || artist.name}-${
                            lfmTrack.name
                        }`,
                        title: lfmTrack.name,
                        playCount: lfmTrack.playcount
                            ? parseInt(lfmTrack.playcount)
                            : 0,
                        listeners: lfmTrack.listeners
                            ? parseInt(lfmTrack.listeners)
                            : 0,
                        duration: lfmTrack.duration
                            ? Math.floor(parseInt(lfmTrack.duration) / 1000)
                            : 0,
                        url: lfmTrack.url,
                        album: {
                            title: lfmTrack.album?.["#text"] || "Unknown Album",
                        },
                        userPlayCount: 0,
                        // NO album.id - this indicates track is not in library
                    });
                }
            }

            topTracks = combinedTracks.slice(0, 10);
        } catch (error) {
            logger.error(
                `Failed to get Last.fm top tracks for ${artist.name}:`,
                error
            );
            // If Last.fm fails, add user play counts to library tracks
            topTracks = topTracks.map((t) => ({
                ...t,
                userPlayCount: userPlayCounts.get(t.id) || 0,
                album: {
                    ...t.album,
                    coverArt: t.album.coverUrl,
                },
            }));
        }

        // ========== HERO IMAGE FETCHING ==========
        // Use DataCacheService: DB -> Redis -> API -> save to both
        const heroUrl = await dataCacheService.getArtistImage(
            artist.id,
            artist.name,
            effectiveMbid
        );

        // ========== SIMILAR ARTISTS (from enriched JSON or Last.fm API) ==========
        let similarArtists: any[] = [];
        const similarCacheKey = `similar-artists:${artist.id}`;

        // Check if artist has pre-enriched similar artists JSON (full Last.fm data)
        const enrichedSimilar = artist.similarArtistsJson as Array<{
            name: string;
            mbid: string | null;
            match: number;
        }> | null;

        if (enrichedSimilar && enrichedSimilar.length > 0) {
            // Use pre-enriched data from database (fast path)
            logger.debug(
                `[Artist] Using ${enrichedSimilar.length} similar artists from enriched JSON`
            );

            // First, batch lookup which similar artists exist in our library
            const similarNames = enrichedSimilar
                .slice(0, 10)
                .map((s) => s.name.toLowerCase());
            const similarMbids = enrichedSimilar
                .slice(0, 10)
                .map((s) => s.mbid)
                .filter(Boolean) as string[];

            // Find library artists matching by name or mbid
            const libraryMatches = await prisma.artist.findMany({
                where: {
                    OR: [
                        { normalizedName: { in: similarNames } },
                        ...(similarMbids.length > 0
                            ? [{ mbid: { in: similarMbids } }]
                            : []),
                    ],
                },
                select: {
                    id: true,
                    name: true,
                    normalizedName: true,
                    mbid: true,
                    heroUrl: true,
                    _count: {
                        select: {
                            albums: {
                                where: {
                                    location: "LIBRARY",
                                    tracks: { some: {} },
                                },
                            },
                        },
                    },
                },
            });

            // Create lookup maps for quick matching
            const libraryByName = new Map(
                libraryMatches.map((a) => [
                    a.normalizedName?.toLowerCase() || a.name.toLowerCase(),
                    a,
                ])
            );
            const libraryByMbid = new Map(
                libraryMatches.filter((a) => a.mbid).map((a) => [a.mbid!, a])
            );

            // Fetch images in parallel from Deezer (cached in Redis)
            const similarWithImages = await Promise.all(
                enrichedSimilar.slice(0, 10).map(async (s) => {
                    // Check if this artist is in our library
                    const libraryArtist =
                        (s.mbid && libraryByMbid.get(s.mbid)) ||
                        libraryByName.get(s.name.toLowerCase());

                    let image = libraryArtist?.heroUrl || null;

                    // If no library image, try Deezer
                    if (!image) {
                        try {
                            // Check Redis cache first
                            const cacheKey = `deezer-artist-image:${s.name}`;
                            const cached = await redisClient.get(cacheKey);
                            if (cached && cached !== "NOT_FOUND") {
                                image = cached;
                            } else {
                                image = await deezerService.getArtistImage(
                                    s.name
                                );
                                if (image) {
                                    await redisClient.setEx(
                                        cacheKey,
                                        24 * 60 * 60,
                                        image
                                    );
                                }
                            }
                        } catch (err) {
                            // Deezer failed, leave null
                        }
                    }

                    return {
                        id: libraryArtist?.id || s.name,
                        name: s.name,
                        mbid: s.mbid || null,
                        coverArt: image,
                        albumCount: 0, // Would require MusicBrainz lookup - skip for performance
                        ownedAlbumCount: libraryArtist?._count?.albums || 0,
                        weight: s.match,
                        inLibrary: !!libraryArtist,
                    };
                })
            );

            similarArtists = similarWithImages;
        } else {
            // No enriched data - fetch from Last.fm API with Redis cache
            const cachedSimilar = await redisClient.get(similarCacheKey);
            if (cachedSimilar && cachedSimilar !== "NOT_FOUND") {
                similarArtists = JSON.parse(cachedSimilar);
                logger.debug(
                    `[Artist] Using cached similar artists (${similarArtists.length})`
                );
            } else {
                // Cache miss - fetch from Last.fm
                logger.debug(
                    `[Artist] Fetching similar artists from Last.fm...`
                );

                try {
                    const validMbid =
                        effectiveMbid && !effectiveMbid.startsWith("temp-")
                            ? effectiveMbid
                            : "";
                    const lastfmSimilar = await lastFmService.getSimilarArtists(
                        validMbid,
                        artist.name,
                        10
                    );

                    // Batch lookup which similar artists exist in our library
                    const similarNames = lastfmSimilar.map((s: any) =>
                        s.name.toLowerCase()
                    );
                    const similarMbids = lastfmSimilar
                        .map((s: any) => s.mbid)
                        .filter(Boolean) as string[];

                    const libraryMatches = await prisma.artist.findMany({
                        where: {
                            OR: [
                                { normalizedName: { in: similarNames } },
                                ...(similarMbids.length > 0
                                    ? [{ mbid: { in: similarMbids } }]
                                    : []),
                            ],
                        },
                        select: {
                            id: true,
                            name: true,
                            normalizedName: true,
                            mbid: true,
                            heroUrl: true,
                            _count: {
                                select: {
                                    albums: {
                                        where: {
                                            location: "LIBRARY",
                                            tracks: { some: {} },
                                        },
                                    },
                                },
                            },
                        },
                    });

                    const libraryByName = new Map(
                        libraryMatches.map((a) => [
                            a.normalizedName?.toLowerCase() ||
                                a.name.toLowerCase(),
                            a,
                        ])
                    );
                    const libraryByMbid = new Map(
                        libraryMatches
                            .filter((a) => a.mbid)
                            .map((a) => [a.mbid!, a])
                    );

                    // Fetch images in parallel (Deezer only - fastest source)
                    const similarWithImages = await Promise.all(
                        lastfmSimilar.map(async (s: any) => {
                            const libraryArtist =
                                (s.mbid && libraryByMbid.get(s.mbid)) ||
                                libraryByName.get(s.name.toLowerCase());

                            let image = libraryArtist?.heroUrl || null;

                            if (!image) {
                                try {
                                    image = await deezerService.getArtistImage(
                                        s.name
                                    );
                                } catch (err) {
                                    // Deezer failed, leave null
                                }
                            }

                            return {
                                id: libraryArtist?.id || s.name,
                                name: s.name,
                                mbid: s.mbid || null,
                                coverArt: image,
                                albumCount: 0,
                                ownedAlbumCount:
                                    libraryArtist?._count?.albums || 0,
                                weight: s.match,
                                inLibrary: !!libraryArtist,
                            };
                        })
                    );

                    similarArtists = similarWithImages;

                    // Cache for 24 hours
                    await redisClient.setEx(
                        similarCacheKey,
                        24 * 60 * 60,
                        JSON.stringify(similarArtists)
                    );
                    logger.debug(
                        `[Artist] Cached ${similarArtists.length} similar artists`
                    );
                } catch (error) {
                    logger.error(
                        `[Artist] Failed to fetch similar artists:`,
                        error
                    );
                    similarArtists = [];
                }
            }
        }

        res.json({
            ...artist,
            coverArt: heroUrl, // Use fetched hero image (falls back to artist.heroUrl)
            bio: getArtistDisplaySummary(artist),
            genres: getMergedGenres(artist),
            albums: albumsWithOwnership,
            topTracks,
            similarArtists,
        });
    } catch (error) {
        logger.error("Get artist error:", error);
        res.status(500).json({ error: "Failed to fetch artist" });
    }
});

// GET /library/albums?artistId=&limit=&offset=&filter=owned|discovery|all
router.get("/albums", async (req, res) => {
    try {
        const {
            artistId,
            limit: limitParam = "500",
            offset: offsetParam = "0",
            filter = "owned", // owned (default), discovery, all
        } = req.query;
        const limit = Math.min(
            parseInt(limitParam as string, 10) || 500,
            MAX_LIMIT
        );
        const offset = parseInt(offsetParam as string, 10) || 0;

        let where: any = {
            tracks: { some: {} }, // Only albums with tracks
        };

        // Apply location filter
        if (filter === "owned") {
            // Get all owned album rgMbids (includes liked discovery albums)
            const ownedAlbumMbids = await prisma.ownedAlbum.findMany({
                select: { rgMbid: true },
            });
            const ownedMbids = ownedAlbumMbids.map((oa) => oa.rgMbid);

            // Albums with LIBRARY location OR rgMbid in OwnedAlbum
            where.OR = [
                { location: "LIBRARY", tracks: { some: {} } },
                { rgMbid: { in: ownedMbids }, tracks: { some: {} } },
            ];
        } else if (filter === "discovery") {
            where.location = "DISCOVER";
        }
        // filter === "all" shows all locations

        // If artistId is provided, filter by artist
        if (artistId) {
            if (where.OR) {
                // If we have OR conditions, wrap with AND
                where = {
                    AND: [{ OR: where.OR }, { artistId: artistId as string }],
                };
            } else {
                where.artistId = artistId as string;
            }
        }

        const [albumsData, total] = await Promise.all([
            prisma.album.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy: { year: "desc" },
                include: {
                    artist: {
                        select: {
                            id: true,
                            mbid: true,
                            name: true,
                        },
                    },
                },
            }),
            prisma.album.count({ where }),
        ]);

        // Normalize coverArt field for frontend
        const albums = albumsData.map((album) => ({
            ...album,
            coverArt: album.coverUrl,
        }));

        res.json({
            albums,
            total,
            offset,
            limit,
        });
    } catch (error: any) {
        logger.error("[Library] Get albums error:", error?.message || error);
        logger.error("[Library] Stack:", error?.stack);
        res.status(500).json({
            error: "Failed to fetch albums",
            details: error?.message,
        });
    }
});

// GET /library/albums/:id
router.get("/albums/:id", async (req, res) => {
    try {
        const idParam = req.params.id;

        // Try finding by ID first
        let album = await prisma.album.findUnique({
            where: { id: idParam },
            include: {
                artist: {
                    select: {
                        id: true,
                        mbid: true,
                        name: true,
                    },
                },
                tracks: {
                    orderBy: { trackNo: Prisma.SortOrder.asc },
                },
            },
        });

        // If not found by ID, try by rgMbid (for discovery albums)
        if (!album) {
            album = await prisma.album.findFirst({
                where: { rgMbid: idParam },
                include: {
                    artist: {
                        select: {
                            id: true,
                            mbid: true,
                            name: true,
                        },
                    },
                    tracks: {
                        orderBy: { trackNo: Prisma.SortOrder.asc },
                    },
                },
            });
        }

        if (!album) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Check ownership
        const owned = await prisma.ownedAlbum.findUnique({
            where: {
                artistId_rgMbid: {
                    artistId: album.artistId,
                    rgMbid: album.rgMbid,
                },
            },
        });

        res.json({
            ...album,
            owned: !!owned,
            coverArt: album.coverUrl,
        });
    } catch (error) {
        logger.error("Get album error:", error);
        res.status(500).json({ error: "Failed to fetch album" });
    }
});

// GET /library/tracks?albumId=&limit=100&offset=0
router.get("/tracks", async (req, res) => {
    try {
        const {
            albumId,
            limit: limitParam = "100",
            offset: offsetParam = "0",
        } = req.query;
        const limit = Math.min(
            parseInt(limitParam as string, 10) || 100,
            MAX_LIMIT
        );
        const offset = parseInt(offsetParam as string, 10) || 0;

        const where: any = {};
        if (albumId) {
            where.albumId = albumId as string;
        }

        const [tracksData, total] = await Promise.all([
            prisma.track.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy: albumId ? { trackNo: "asc" } : { id: "desc" },
                include: {
                    album: {
                        include: {
                            artist: {
                                select: {
                                    id: true,
                                    name: true,
                                },
                            },
                        },
                    },
                },
            }),
            prisma.track.count({ where }),
        ]);

        // Add coverArt field to albums
        const tracks = tracksData.map((track) => ({
            ...track,
            album: {
                ...track.album,
                coverArt: track.album.coverUrl,
            },
        }));

        res.json({ tracks, total, offset, limit });
    } catch (error) {
        logger.error("Get tracks error:", error);
        res.status(500).json({ error: "Failed to fetch tracks" });
    }
});

// GET /library/tracks/shuffle?limit=100 - Get random tracks for shuffle play
router.get("/tracks/shuffle", async (req, res) => {
    try {
        const { limit: limitParam = "100" } = req.query;
        const limit = Math.min(
            parseInt(limitParam as string, 10) || 100,
            MAX_LIMIT
        );

        // Get total count of tracks
        const totalTracks = await prisma.track.count();

        if (totalTracks === 0) {
            return res.json({ tracks: [], total: 0 });
        }

        // For small libraries, fetch all and shuffle in memory
        // For large libraries, use database-level randomization for memory efficiency
        let tracksData;
        if (totalTracks <= limit) {
            // Fetch all tracks and shuffle
            tracksData = await prisma.track.findMany({
                include: {
                    album: {
                        include: {
                            artist: {
                                select: {
                                    id: true,
                                    name: true,
                                },
                            },
                        },
                    },
                },
            });
            // Fisher-Yates shuffle
            for (let i = tracksData.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [tracksData[i], tracksData[j]] = [tracksData[j], tracksData[i]];
            }
        } else {
            // For large libraries, use database-level randomization
            // Get random track IDs first (efficient, O(limit) memory)
            const randomIds = await prisma.$queryRaw<{ id: string }[]>`
                SELECT id FROM "Track"
                ORDER BY RANDOM()
                LIMIT ${limit}
            `;

            // Then fetch full track data for selected IDs
            tracksData = await prisma.track.findMany({
                where: {
                    id: { in: randomIds.map((r) => r.id) },
                },
                include: {
                    album: {
                        include: {
                            artist: {
                                select: {
                                    id: true,
                                    name: true,
                                },
                            },
                        },
                    },
                },
            });

            // Shuffle the result to maintain randomness (findMany doesn't preserve order)
            for (let i = tracksData.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [tracksData[i], tracksData[j]] = [tracksData[j], tracksData[i]];
            }
        }

        // Add coverArt field to albums
        const tracks = tracksData.slice(0, limit).map((track) => ({
            ...track,
            album: {
                ...track.album,
                coverArt: track.album.coverUrl,
            },
        }));

        res.json({ tracks, total: totalTracks });
    } catch (error) {
        logger.error("Shuffle tracks error:", error);
        res.status(500).json({ error: "Failed to shuffle tracks" });
    }
});

// GET /library/cover-art/:id?size= or GET /library/cover-art?url=&size=
// Apply lenient image limiter (500 req/min) instead of general API limiter (100 req/15min)
router.get("/cover-art/:id?", imageLimiter, async (req, res) => {
    try {
        const { size, url } = req.query;
        let coverUrl: string;
        let isAudiobook = false;

        // Check if a full URL was provided as a query parameter
        if (url) {
            const decodedUrl = decodeURIComponent(url as string);

            // Check if this is an audiobook cover (prefixed with "audiobook__")
            if (decodedUrl.startsWith("audiobook__")) {
                isAudiobook = true;
                const audiobookPath = decodedUrl.replace("audiobook__", "");

                // Get Audiobookshelf settings
                const settings = await getSystemSettings();
                const audiobookshelfUrl =
                    settings?.audiobookshelfUrl ||
                    process.env.AUDIOBOOKSHELF_URL ||
                    "";
                const audiobookshelfApiKey =
                    settings?.audiobookshelfApiKey ||
                    process.env.AUDIOBOOKSHELF_API_KEY ||
                    "";
                const audiobookshelfBaseUrl = audiobookshelfUrl.replace(
                    /\/$/,
                    ""
                );

                coverUrl = `${audiobookshelfBaseUrl}/api/${audiobookPath}`;

                // Fetch with authentication
                logger.debug(
                    `[COVER-ART] Fetching audiobook cover: ${coverUrl.substring(
                        0,
                        100
                    )}...`
                );
                const imageResponse = await fetch(coverUrl, {
                    headers: {
                        Authorization: `Bearer ${audiobookshelfApiKey}`,
                        "User-Agent":
                            "Lidify/1.0.0 (https://github.com/Chevron7Locked/lidify)",
                    },
                });

                if (!imageResponse.ok) {
                    logger.error(
                        `[COVER-ART] Failed to fetch audiobook cover: ${coverUrl} (${imageResponse.status} ${imageResponse.statusText})`
                    );
                    return res
                        .status(404)
                        .json({ error: "Audiobook cover art not found" });
                }

                const buffer = await imageResponse.arrayBuffer();
                const imageBuffer = Buffer.from(buffer);
                const contentType = imageResponse.headers.get("content-type");

                if (contentType) {
                    res.setHeader("Content-Type", contentType);
                }
                applyCoverArtCorsHeaders(
                    res,
                    req.headers.origin as string | undefined
                );
                res.setHeader(
                    "Cache-Control",
                    "public, max-age=31536000, immutable"
                );

                return res.send(imageBuffer);
            }

            // Check if this is a native cover (prefixed with "native:")
            if (decodedUrl.startsWith("native:")) {
                const nativePath = decodedUrl.replace("native:", "");

                const coverCachePath = path.join(
                    config.music.transcodeCachePath,
                    "../covers",
                    nativePath
                );

                logger.debug(
                    `[COVER-ART] Serving native cover: ${coverCachePath}`
                );

                // Check if file exists
                if (!fs.existsSync(coverCachePath)) {
                    logger.error(
                        `[COVER-ART] Native cover not found: ${coverCachePath}`
                    );
                    return res
                        .status(404)
                        .json({ error: "Cover art not found" });
                }

                // Serve the file directly
                const requestOrigin = req.headers.origin;
                const headers: Record<string, string> = {
                    "Content-Type": "image/jpeg", // Assume JPEG for now
                    "Cache-Control": "public, max-age=31536000, immutable",
                    "Cross-Origin-Resource-Policy": "cross-origin",
                };
                if (requestOrigin) {
                    headers["Access-Control-Allow-Origin"] = requestOrigin;
                    headers["Access-Control-Allow-Credentials"] = "true";
                } else {
                    headers["Access-Control-Allow-Origin"] = "*";
                }

                return res.sendFile(coverCachePath, {
                    headers,
                });
            }

            coverUrl = decodedUrl;
        } else {
            // Otherwise use the ID from the path parameter
            const coverId = req.params.id;
            if (!coverId) {
                return res
                    .status(400)
                    .json({ error: "No cover ID or URL provided" });
            }

            const decodedId = decodeURIComponent(coverId);

            // Check if this is a native cover (prefixed with "native:")
            if (decodedId.startsWith("native:")) {
                const nativePath = decodedId.replace("native:", "");

                const coverCachePath = path.join(
                    config.music.transcodeCachePath,
                    "../covers",
                    nativePath
                );

                // Check if file exists
                if (fs.existsSync(coverCachePath)) {
                    // Serve the file directly
                    const requestOrigin = req.headers.origin;
                    const headers: Record<string, string> = {
                        "Content-Type": "image/jpeg",
                        "Cache-Control": "public, max-age=31536000, immutable",
                        "Cross-Origin-Resource-Policy": "cross-origin",
                    };
                    if (requestOrigin) {
                        headers["Access-Control-Allow-Origin"] = requestOrigin;
                        headers["Access-Control-Allow-Credentials"] = "true";
                    } else {
                        headers["Access-Control-Allow-Origin"] = "*";
                    }

                    return res.sendFile(coverCachePath, {
                        headers,
                    });
                }

                // Native cover file missing - try to find album and fetch from Deezer
                logger.warn(
                    `[COVER-ART] Native cover not found: ${coverCachePath}, trying Deezer fallback`
                );

                // Extract album ID from the path (format: albumId.jpg)
                const albumId = nativePath.replace(".jpg", "");
                try {
                    const album = await prisma.album.findUnique({
                        where: { id: albumId },
                        include: { artist: true },
                    });

                    if (album && album.artist) {
                        const deezerCover = await deezerService.getAlbumCover(
                            album.artist.name,
                            album.title
                        );

                        if (deezerCover) {
                            // Update album with Deezer cover
                            await prisma.album.update({
                                where: { id: albumId },
                                data: { coverUrl: deezerCover },
                            });

                            // Redirect to the Deezer cover
                            return res.redirect(deezerCover);
                        }
                    }
                } catch (error) {
                    logger.error(
                        `[COVER-ART] Failed to fetch Deezer fallback for ${albumId}:`,
                        error
                    );
                }

                return res.status(404).json({ error: "Cover art not found" });
            }

            // Check if this is an audiobook cover (prefixed with "audiobook__")
            if (decodedId.startsWith("audiobook__")) {
                isAudiobook = true;
                const audiobookPath = decodedId.replace("audiobook__", "");

                // Get Audiobookshelf settings
                const settings = await getSystemSettings();
                const audiobookshelfUrl =
                    settings?.audiobookshelfUrl ||
                    process.env.AUDIOBOOKSHELF_URL ||
                    "";
                const audiobookshelfApiKey =
                    settings?.audiobookshelfApiKey ||
                    process.env.AUDIOBOOKSHELF_API_KEY ||
                    "";
                const audiobookshelfBaseUrl = audiobookshelfUrl.replace(
                    /\/$/,
                    ""
                );

                coverUrl = `${audiobookshelfBaseUrl}/api/${audiobookPath}`;

                // Fetch with authentication
                logger.debug(
                    `[COVER-ART] Fetching audiobook cover: ${coverUrl.substring(
                        0,
                        100
                    )}...`
                );
                const imageResponse = await fetch(coverUrl, {
                    headers: {
                        Authorization: `Bearer ${audiobookshelfApiKey}`,
                        "User-Agent":
                            "Lidify/1.0.0 (https://github.com/Chevron7Locked/lidify)",
                    },
                });

                if (!imageResponse.ok) {
                    logger.error(
                        `[COVER-ART] Failed to fetch audiobook cover: ${coverUrl} (${imageResponse.status} ${imageResponse.statusText})`
                    );
                    return res
                        .status(404)
                        .json({ error: "Audiobook cover art not found" });
                }

                const buffer = await imageResponse.arrayBuffer();
                const imageBuffer = Buffer.from(buffer);
                const contentType = imageResponse.headers.get("content-type");

                if (contentType) {
                    res.setHeader("Content-Type", contentType);
                }
                applyCoverArtCorsHeaders(
                    res,
                    req.headers.origin as string | undefined
                );
                res.setHeader(
                    "Cache-Control",
                    "public, max-age=31536000, immutable"
                );

                return res.send(imageBuffer);
            }
            // Check if coverId is already a full URL (from Cover Art Archive or elsewhere)
            else if (
                decodedId.startsWith("http://") ||
                decodedId.startsWith("https://")
            ) {
                coverUrl = decodedId;
            } else {
                // Invalid cover ID format
                return res
                    .status(400)
                    .json({ error: "Invalid cover ID format" });
            }
        }

        // Create cache key from URL + size
        const cacheKey = `cover-art:${crypto
            .createHash("md5")
            .update(`${coverUrl}-${size || "original"}`)
            .digest("hex")}`;

        // Try to get from Redis cache first
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                const cachedData = JSON.parse(cached);

                // Check if this is a cached 404
                if (cachedData.notFound) {
                    logger.debug(
                        `[COVER-ART] Cached 404 for ${coverUrl.substring(
                            0,
                            60
                        )}...`
                    );
                    return res
                        .status(404)
                        .json({ error: "Cover art not found" });
                }

                logger.debug(
                    `[COVER-ART] Cache HIT for ${coverUrl.substring(0, 60)}...`
                );
                const imageBuffer = Buffer.from(cachedData.data, "base64");

                // Check if client has cached version
                if (req.headers["if-none-match"] === cachedData.etag) {
                    logger.debug(`[COVER-ART] Client has cached version (304)`);
                    return res.status(304).end();
                }

                // Set headers and send cached image
                if (cachedData.contentType) {
                    res.setHeader("Content-Type", cachedData.contentType);
                }
                applyCoverArtCorsHeaders(
                    res,
                    req.headers.origin as string | undefined
                );
                res.setHeader(
                    "Cache-Control",
                    "public, max-age=31536000, immutable"
                );
                res.setHeader("ETag", cachedData.etag);
                return res.send(imageBuffer);
            } else {
                logger.debug(
                    `[COVER-ART] ✗ Cache MISS for ${coverUrl.substring(
                        0,
                        60
                    )}...`
                );
            }
        } catch (cacheError) {
            logger.warn("[COVER-ART] Redis cache read error:", cacheError);
        }

        // Fetch the image and proxy it to avoid CORS issues
        logger.debug(`[COVER-ART] Fetching: ${coverUrl.substring(0, 100)}...`);
        const imageResponse = await fetch(coverUrl, {
            headers: {
                "User-Agent":
                    "Lidify/1.0.0 (https://github.com/Chevron7Locked/lidify)",
            },
        });
        if (!imageResponse.ok) {
            logger.error(
                `[COVER-ART] Failed to fetch: ${coverUrl} (${imageResponse.status} ${imageResponse.statusText})`
            );

            // Cache 404s for 1 hour to avoid repeatedly trying to fetch missing images
            if (imageResponse.status === 404) {
                try {
                    await redisClient.setEx(
                        cacheKey,
                        60 * 60, // 1 hour
                        JSON.stringify({ notFound: true })
                    );
                    logger.debug(`[COVER-ART] Cached 404 response for 1 hour`);
                } catch (cacheError) {
                    logger.warn(
                        "[COVER-ART] Redis cache write error:",
                        cacheError
                    );
                }
            }

            return res.status(404).json({ error: "Cover art not found" });
        }
        logger.debug(`[COVER-ART] Successfully fetched, caching...`);

        const buffer = await imageResponse.arrayBuffer();
        const imageBuffer = Buffer.from(buffer);

        // Generate ETag from content
        const etag = crypto.createHash("md5").update(imageBuffer).digest("hex");

        // Cache in Redis for 7 days
        try {
            const contentType = imageResponse.headers.get("content-type");
            await redisClient.setEx(
                cacheKey,
                7 * 24 * 60 * 60, // 7 days
                JSON.stringify({
                    etag,
                    contentType,
                    data: imageBuffer.toString("base64"),
                })
            );
        } catch (cacheError) {
            logger.warn("Redis cache write error:", cacheError);
        }

        // Check if client has cached version
        if (req.headers["if-none-match"] === etag) {
            return res.status(304).end();
        }

        // Set appropriate headers
        const contentType = imageResponse.headers.get("content-type");
        if (contentType) {
            res.setHeader("Content-Type", contentType);
        }

        // Set aggressive caching headers
        applyCoverArtCorsHeaders(res, req.headers.origin as string | undefined);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // Cache for 1 year
        res.setHeader("ETag", etag);

        // Send the image
        res.send(imageBuffer);
    } catch (error) {
        logger.error("Get cover art error:", error);
        res.status(500).json({ error: "Failed to fetch cover art" });
    }
});

// GET /library/album-cover/:mbid - Fetch and cache album cover by MBID
// This is called lazily by the frontend when an album doesn't have a cached cover
router.get("/album-cover/:mbid", imageLimiter, async (req, res) => {
    try {
        const { mbid } = req.params;

        if (!mbid || mbid.startsWith("temp-")) {
            return res.status(400).json({ error: "Valid MBID required" });
        }

        // Fetch from Cover Art Archive (this uses caching internally)
        const coverUrl = await coverArtService.getCoverArt(mbid);

        if (!coverUrl) {
            // Return 204 No Content instead of 404 to avoid console spam
            // Cover Art Archive doesn't have covers for all albums
            return res.status(204).send();
        }

        res.json({ coverUrl });
    } catch (error) {
        logger.error("Get album cover error:", error);
        res.status(500).json({ error: "Failed to fetch cover art" });
    }
});

// GET /library/cover-art-colors?url= - Extract colors from a cover art URL
router.get("/cover-art-colors", imageLimiter, async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({ error: "URL parameter required" });
        }

        const imageUrl = decodeURIComponent(url as string);

        // Handle placeholder images - return default fallback colors
        if (
            imageUrl.includes("placeholder") ||
            imageUrl.startsWith("/placeholder")
        ) {
            logger.debug(
                `[COLORS] Placeholder image detected, returning fallback colors`
            );
            return res.json({
                vibrant: "#1db954",
                darkVibrant: "#121212",
                lightVibrant: "#181818",
                muted: "#535353",
                darkMuted: "#121212",
                lightMuted: "#b3b3b3",
            });
        }

        // Create cache key for colors
        const cacheKey = `colors:${crypto
            .createHash("md5")
            .update(imageUrl)
            .digest("hex")}`;

        // Try to get from Redis cache first
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(
                    `[COLORS] Cache HIT for ${imageUrl.substring(0, 60)}...`
                );
                return res.json(JSON.parse(cached));
            } else {
                logger.debug(
                    `[COLORS] ✗ Cache MISS for ${imageUrl.substring(0, 60)}...`
                );
            }
        } catch (cacheError) {
            logger.warn("[COLORS] Redis cache read error:", cacheError);
        }

        // Fetch the image
        logger.debug(
            `[COLORS] Fetching image: ${imageUrl.substring(0, 100)}...`
        );
        const imageResponse = await fetch(imageUrl, {
            headers: {
                "User-Agent":
                    "Lidify/1.0.0 (https://github.com/Chevron7Locked/lidify)",
            },
        });

        if (!imageResponse.ok) {
            logger.error(
                `[COLORS] Failed to fetch image: ${imageUrl} (${imageResponse.status})`
            );
            return res.status(404).json({ error: "Image not found" });
        }

        const buffer = await imageResponse.arrayBuffer();
        const imageBuffer = Buffer.from(buffer);

        // Extract colors using sharp
        const colors = await extractColorsFromImage(imageBuffer);

        logger.debug(`[COLORS] Extracted colors:`, colors);

        // Cache the result for 30 days
        try {
            await redisClient.setEx(
                cacheKey,
                30 * 24 * 60 * 60, // 30 days
                JSON.stringify(colors)
            );
            logger.debug(`[COLORS] Cached colors for 30 days`);
        } catch (cacheError) {
            logger.warn("[COLORS] Redis cache write error:", cacheError);
        }

        res.json(colors);
    } catch (error) {
        logger.error("Extract colors error:", error);
        res.status(500).json({ error: "Failed to extract colors" });
    }
});

// GET /library/tracks/:id/stream
router.get("/tracks/:id/stream", async (req, res) => {
    try {
        logger.debug("[STREAM] Request received for track:", req.params.id);
        const { quality } = req.query;
        const userId = req.user?.id;

        if (!userId) {
            logger.debug("[STREAM] No userId in session - unauthorized");
            return res.status(401).json({ error: "Unauthorized" });
        }

        const track = await prisma.track.findUnique({
            where: { id: req.params.id },
        });

        if (!track) {
            logger.debug("[STREAM] Track not found");
            return res.status(404).json({ error: "Track not found" });
        }

        // Log play start - only if this is a new playback session
        const recentPlay = await prisma.play.findFirst({
            where: {
                userId,
                trackId: track.id,
                playedAt: {
                    gte: new Date(Date.now() - 30 * 1000),
                },
            },
            orderBy: { playedAt: "desc" },
        });

        if (!recentPlay) {
            await prisma.play.create({
                data: {
                    userId,
                    trackId: track.id,
                },
            });
            logger.debug("[STREAM] Logged new play for track:", track.title);
        }

        // Get user's quality preference
        let requestedQuality: string = "medium";
        if (quality) {
            requestedQuality = quality as string;
        } else {
            const settings = await prisma.userSettings.findUnique({
                where: { userId },
            });
            requestedQuality = settings?.playbackQuality || "medium";
        }

        const ext = track.filePath
            ? path.extname(track.filePath).toLowerCase()
            : "";
        logger.debug(
            `[STREAM] Quality: requested=${
                quality || "default"
            }, using=${requestedQuality}, format=${ext}`
        );

        // === NATIVE FILE STREAMING ===
        // Check if track has native file path
        if (track.filePath && track.fileModified) {
            try {
                // Initialize streaming service
                const streamingService = new AudioStreamingService(
                    config.music.musicPath,
                    config.music.transcodeCachePath,
                    config.music.transcodeCacheMaxGb
                );

                // Get absolute path to source file
                // Normalize path separators for cross-platform compatibility (Windows -> Linux)
                const normalizedFilePath = track.filePath.replace(/\\/g, "/");
                const absolutePath = path.join(
                    config.music.musicPath,
                    normalizedFilePath
                );

                logger.debug(
                    `[STREAM] Using native file: ${track.filePath} (${requestedQuality})`
                );

                // Get stream file (either original or transcoded)
                const { filePath, mimeType } =
                    await streamingService.getStreamFilePath(
                        track.id,
                        requestedQuality as any,
                        track.fileModified,
                        absolutePath
                    );

                // Stream file with range support
                logger.debug(
                    `[STREAM] Sending file: ${filePath}, mimeType: ${mimeType}`
                );

                await streamingService.streamFileWithRangeSupport(
                    req,
                    res,
                    filePath,
                    mimeType
                );
                streamingService.destroy();
                logger.debug(
                    `[STREAM] File sent successfully: ${path.basename(
                        filePath
                    )}`
                );

                return;
            } catch (err: any) {
                // If FFmpeg not found, try original quality instead
                if (
                    err.code === "FFMPEG_NOT_FOUND" &&
                    requestedQuality !== "original"
                ) {
                    logger.warn(
                        `[STREAM] FFmpeg not available, falling back to original quality`
                    );
                    const fallbackFilePath = track.filePath.replace(/\\/g, "/");
                    const absolutePath = path.join(
                        config.music.musicPath,
                        fallbackFilePath
                    );

                    const streamingService = new AudioStreamingService(
                        config.music.musicPath,
                        config.music.transcodeCachePath,
                        config.music.transcodeCacheMaxGb
                    );

                    const { filePath, mimeType } =
                        await streamingService.getStreamFilePath(
                            track.id,
                            "original",
                            track.fileModified,
                            absolutePath
                        );

                    await streamingService.streamFileWithRangeSupport(
                        req,
                        res,
                        filePath,
                        mimeType
                    );
                    streamingService.destroy();
                    return;
                }

                logger.error("[STREAM] Native streaming failed:", err.message);
                return res
                    .status(500)
                    .json({ error: "Failed to stream track" });
            }
        }

        // No file path available
        logger.debug("[STREAM] Track has no file path - unavailable");
        return res.status(404).json({ error: "Track not available" });
    } catch (error) {
        logger.error("Stream track error:", error);
        res.status(500).json({ error: "Failed to stream track" });
    }
});

// GET /library/tracks/:id
router.get("/tracks/:id", async (req, res) => {
    try {
        const track = await prisma.track.findUnique({
            where: { id: req.params.id },
            include: {
                album: {
                    include: {
                        artist: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
            },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        // Transform to match frontend Track interface: artist at top level
        const formattedTrack = {
            id: track.id,
            title: track.title,
            artist: {
                name: track.album?.artist?.name || "Unknown Artist",
                id: track.album?.artist?.id,
            },
            album: {
                title: track.album?.title || "Unknown Album",
                coverArt: track.album?.coverUrl,
                id: track.album?.id,
            },
            duration: track.duration,
        };

        res.json(formattedTrack);
    } catch (error) {
        logger.error("Get track error:", error);
        res.status(500).json({ error: "Failed to fetch track" });
    }
});

// DELETE /library/tracks/:id
router.delete("/tracks/:id", async (req, res) => {
    try {
        const track = await prisma.track.findUnique({
            where: { id: req.params.id },
            include: {
                album: {
                    include: {
                        artist: true,
                    },
                },
            },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        // Delete file from filesystem if path is available
        if (track.filePath) {
            try {
                const absolutePath = path.join(
                    config.music.musicPath,
                    track.filePath
                );

                if (fs.existsSync(absolutePath)) {
                    fs.unlinkSync(absolutePath);
                    logger.debug(`[DELETE] Deleted file: ${absolutePath}`);
                }
            } catch (err) {
                logger.warn("[DELETE] Could not delete file:", err);
                // Continue with database deletion even if file deletion fails
            }
        }

        // Delete from database (cascade will handle related records)
        await prisma.track.delete({
            where: { id: track.id },
        });

        logger.debug(`[DELETE] Deleted track: ${track.title}`);

        res.json({ message: "Track deleted successfully" });
    } catch (error) {
        logger.error("Delete track error:", error);
        res.status(500).json({ error: "Failed to delete track" });
    }
});

// DELETE /library/albums/:id
router.delete("/albums/:id", async (req, res) => {
    try {
        const album = await prisma.album.findUnique({
            where: { id: req.params.id },
            include: {
                artist: true,
                tracks: {
                    include: {
                        album: true,
                    },
                },
            },
        });

        if (!album) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Delete all track files
        let deletedFiles = 0;
        for (const track of album.tracks) {
            if (track.filePath) {
                try {
                    const absolutePath = path.join(
                        config.music.musicPath,
                        track.filePath
                    );

                    if (fs.existsSync(absolutePath)) {
                        fs.unlinkSync(absolutePath);
                        deletedFiles++;
                    }
                } catch (err) {
                    logger.warn("[DELETE] Could not delete file:", err);
                }
            }
        }

        // Try to delete album folder if empty
        try {
            const artistName = album.artist.name;
            const albumFolder = path.join(
                config.music.musicPath,
                artistName,
                album.title
            );

            if (fs.existsSync(albumFolder)) {
                const files = fs.readdirSync(albumFolder);
                if (files.length === 0) {
                    fs.rmdirSync(albumFolder);
                    logger.debug(
                        `[DELETE] Deleted empty album folder: ${albumFolder}`
                    );
                }
            }
        } catch (err) {
            logger.warn("[DELETE] Could not delete album folder:", err);
        }

        // Delete from database (cascade will delete tracks)
        await prisma.album.delete({
            where: { id: album.id },
        });

        logger.debug(
            `[DELETE] Deleted album: ${album.title} (${deletedFiles} files)`
        );

        res.json({
            message: "Album deleted successfully",
            deletedFiles,
        });
    } catch (error) {
        logger.error("Delete album error:", error);
        res.status(500).json({ error: "Failed to delete album" });
    }
});

// DELETE /library/artists/:id
router.delete("/artists/:id", async (req, res) => {
    try {
        const artist = await prisma.artist.findUnique({
            where: { id: req.params.id },
            include: {
                albums: {
                    include: {
                        tracks: true,
                    },
                },
            },
        });

        if (!artist) {
            return res.status(404).json({ error: "Artist not found" });
        }

        // Delete all track files and collect actual artist folders from file paths
        let deletedFiles = 0;
        const artistFoldersToDelete = new Set<string>();

        for (const album of artist.albums) {
            for (const track of album.tracks) {
                if (track.filePath) {
                    try {
                        const absolutePath = path.join(
                            config.music.musicPath,
                            track.filePath
                        );

                        if (fs.existsSync(absolutePath)) {
                            fs.unlinkSync(absolutePath);
                            deletedFiles++;

                            // Extract actual artist folder from file path
                            // Path format: Soulseek/Artist/Album/Track.mp3 OR Artist/Album/Track.mp3
                            const pathParts = track.filePath.split(path.sep);
                            if (pathParts.length >= 2) {
                                // If first part is "Soulseek", artist folder is Soulseek/Artist
                                // Otherwise, artist folder is just Artist
                                const actualArtistFolder =
                                    pathParts[0].toLowerCase() === "soulseek"
                                        ? path.join(
                                              config.music.musicPath,
                                              pathParts[0],
                                              pathParts[1]
                                          )
                                        : path.join(
                                              config.music.musicPath,
                                              pathParts[0]
                                          );
                                artistFoldersToDelete.add(actualArtistFolder);
                            } else if (pathParts.length === 1) {
                                // Single-level path (rare case)
                                const actualArtistFolder = path.join(
                                    config.music.musicPath,
                                    pathParts[0]
                                );
                                artistFoldersToDelete.add(actualArtistFolder);
                            }
                        }
                    } catch (err) {
                        logger.warn("[DELETE] Could not delete file:", err);
                    }
                }
            }
        }

        // Delete artist folders based on actual file paths, not database name
        for (const artistFolder of artistFoldersToDelete) {
            try {
                if (fs.existsSync(artistFolder)) {
                    logger.debug(
                        `[DELETE] Attempting to delete folder: ${artistFolder}`
                    );

                    // Always try recursive delete with force
                    fs.rmSync(artistFolder, {
                        recursive: true,
                        force: true,
                    });
                    logger.debug(
                        `[DELETE] Successfully deleted artist folder: ${artistFolder}`
                    );
                }
            } catch (err: any) {
                logger.error(
                    `[DELETE] Failed to delete artist folder ${artistFolder}:`,
                    err?.message || err
                );

                // Try alternative: delete contents first, then folder
                try {
                    const files = fs.readdirSync(artistFolder);
                    for (const file of files) {
                        const filePath = path.join(artistFolder, file);
                        try {
                            const stat = fs.statSync(filePath);
                            if (stat.isDirectory()) {
                                fs.rmSync(filePath, {
                                    recursive: true,
                                    force: true,
                                });
                            } else {
                                fs.unlinkSync(filePath);
                            }
                            logger.debug(`[DELETE] Deleted: ${filePath}`);
                        } catch (fileErr: any) {
                            logger.error(
                                `[DELETE] Could not delete ${filePath}:`,
                                fileErr?.message
                            );
                        }
                    }
                    // Try deleting the now-empty folder
                    fs.rmdirSync(artistFolder);
                    logger.debug(
                        `[DELETE] Deleted artist folder after manual cleanup: ${artistFolder}`
                    );
                } catch (cleanupErr: any) {
                    logger.error(
                        `[DELETE] Cleanup also failed for ${artistFolder}:`,
                        cleanupErr?.message
                    );
                }
            }
        }

        // Also try deleting from common music folder paths (in case tracks weren't indexed)
        const commonPaths = [
            path.join(config.music.musicPath, artist.name),
            path.join(config.music.musicPath, "Soulseek", artist.name),
            path.join(config.music.musicPath, "discovery", artist.name),
        ];

        for (const commonPath of commonPaths) {
            if (
                fs.existsSync(commonPath) &&
                !artistFoldersToDelete.has(commonPath)
            ) {
                try {
                    fs.rmSync(commonPath, { recursive: true, force: true });
                    logger.debug(
                        `[DELETE] Deleted additional artist folder: ${commonPath}`
                    );
                } catch (err: any) {
                    logger.error(
                        `[DELETE] Could not delete ${commonPath}:`,
                        err?.message
                    );
                }
            }
        }

        // Delete from Lidarr if connected and artist has MBID
        let lidarrDeleted = false;
        let lidarrError: string | null = null;
        if (artist.mbid && !artist.mbid.startsWith("temp-")) {
            try {
                const { lidarrService } = await import("../services/lidarr");
                const lidarrResult = await lidarrService.deleteArtist(
                    artist.mbid,
                    true
                );
                if (lidarrResult.success) {
                    logger.debug(`[DELETE] Lidarr: ${lidarrResult.message}`);
                    lidarrDeleted = true;
                } else {
                    logger.warn(
                        `[DELETE] Lidarr deletion note: ${lidarrResult.message}`
                    );
                    lidarrError = lidarrResult.message;
                }
            } catch (err: any) {
                logger.warn(
                    "[DELETE] Could not delete from Lidarr:",
                    err?.message || err
                );
                lidarrError = err?.message || "Unknown error";
            }
        }

        // Explicitly delete OwnedAlbum records first (should cascade, but being safe)
        try {
            await prisma.ownedAlbum.deleteMany({
                where: { artistId: artist.id },
            });
        } catch (err) {
            logger.warn("[DELETE] Could not delete OwnedAlbum records:", err);
        }

        // Delete from database (cascade will delete albums and tracks)
        logger.debug(
            `[DELETE] Deleting artist from database: ${artist.name} (${artist.id})`
        );
        await prisma.artist.delete({
            where: { id: artist.id },
        });

        logger.debug(
            `[DELETE] Successfully deleted artist: ${
                artist.name
            } (${deletedFiles} files${
                lidarrDeleted ? ", removed from Lidarr" : ""
            })`
        );

        res.json({
            message: "Artist deleted successfully",
            deletedFiles,
            lidarrDeleted,
            lidarrError,
        });
    } catch (error: any) {
        logger.error("Delete artist error:", error?.message || error);
        logger.error("Delete artist stack:", error?.stack);
        res.status(500).json({
            error: "Failed to delete artist",
            details: error?.message || "Unknown error",
        });
    }
});

/**
 * GET /library/genres
 * Get list of genres in the library with track counts
 */
router.get("/genres", async (req, res) => {
    try {
        // Get artist names to filter them out of genres (they sometimes get incorrectly tagged)
        const artists = await prisma.artist.findMany({
            select: { name: true, normalizedName: true },
        });
        const artistNames = new Set(
            artists.flatMap((a) =>
                [a.name.toLowerCase(), a.normalizedName?.toLowerCase()].filter(
                    Boolean
                )
            )
        );

        // Query Artist.genres field (populated by enrichment from Last.fm tags)
        // Use raw SQL to expand JSONB array and count tracks per genre
        const minTracks = 15; // Minimum tracks for a genre to show up
        const genreResults = await prisma.$queryRaw<
            { genre: string; track_count: bigint }[]
        >`
            SELECT LOWER(g.genre) as genre, COUNT(DISTINCT t.id) as track_count
            FROM "Artist" ar
            CROSS JOIN LATERAL jsonb_array_elements_text(ar.genres::jsonb) AS g(genre)
            JOIN "Album" a ON a."artistId" = ar.id
            JOIN "Track" t ON t."albumId" = a.id
            WHERE ar.genres IS NOT NULL
            GROUP BY LOWER(g.genre)
            HAVING COUNT(DISTINCT t.id) >= ${minTracks}
            ORDER BY track_count DESC
            LIMIT 20
        `;

        // Filter out artist names and convert bigint to number
        const genres = genreResults
            .map((row) => ({
                genre: row.genre,
                count: Number(row.track_count),
            }))
            .filter((g) => !artistNames.has(g.genre.toLowerCase()));

        logger.debug(
            `[Genres] Found ${genres.length} genres from Artist.genres (min ${minTracks} tracks)`
        );

        res.json({ genres });
    } catch (error) {
        logger.error("Genres endpoint error:", error);
        res.status(500).json({ error: "Failed to get genres" });
    }
});

/**
 * GET /library/decades
 * Get available decades in the library with track counts
 * Returns only decades with enough tracks (15+)
 */
router.get("/decades", async (req, res) => {
    try {
        // Get all albums with year fields and track count
        const albums = await prisma.album.findMany({
            select: {
                year: true,
                originalYear: true,
                displayYear: true,
                _count: { select: { tracks: true } },
            },
        });

        // Group by decade using effective year (displayYear > originalYear > year)
        const decadeMap = new Map<number, number>();

        for (const album of albums) {
            const effectiveYear = getEffectiveYear(album);
            if (effectiveYear) {
                const decadeStart = getDecadeFromYear(effectiveYear);
                decadeMap.set(
                    decadeStart,
                    (decadeMap.get(decadeStart) || 0) + album._count.tracks
                );
            }
        }

        // Convert to array, filter by minimum tracks, and sort by decade
        const decades = Array.from(decadeMap.entries())
            .map(([decade, count]) => ({ decade, count }))
            .filter((d) => d.count >= 15) // Minimum 15 tracks for a radio station
            .sort((a, b) => b.decade - a.decade); // Newest first

        res.json({ decades });
    } catch (error) {
        logger.error("Decades endpoint error:", error);
        res.status(500).json({ error: "Failed to get decades" });
    }
});

/**
 * GET /library/radio
 * Get tracks for a library-based radio station
 *
 * Query params:
 * - type: "discovery" | "favorites" | "decade" | "genre" | "mood"
 * - value: Optional value for decade (e.g., "1990") or genre name
 * - limit: Number of tracks to return (default 50)
 */
router.get("/radio", async (req, res) => {
    try {
        const { type, value, limit = "50" } = req.query;
        const limitNum = Math.min(parseInt(limit as string) || 50, 100);
        const userId = req.user?.id;

        if (!type) {
            return res.status(400).json({ error: "Radio type is required" });
        }

        let whereClause: any = {};
        let orderBy: any = {};
        let trackIds: string[] = [];
        let vibeSourceFeatures: any = null; // For vibe mode - store source track features

        switch (type) {
            case "discovery":
                // Lesser-played tracks - get tracks the user hasn't played or played least
                // First, get tracks with NO plays at all (truly undiscovered)
                const unplayedTracks = await prisma.track.findMany({
                    where: {
                        plays: { none: {} }, // No plays by anyone
                    },
                    select: { id: true },
                    take: limitNum * 2,
                });

                if (unplayedTracks.length >= limitNum) {
                    trackIds = unplayedTracks.map((t) => t.id);
                } else {
                    // Fallback: get tracks with the fewest plays using raw count
                    const leastPlayedTracks = await prisma.$queryRaw<
                        { id: string }[]
                    >`
                        SELECT t.id 
                        FROM "Track" t
                        LEFT JOIN "Play" p ON p."trackId" = t.id
                        GROUP BY t.id
                        ORDER BY COUNT(p.id) ASC
                        LIMIT ${limitNum * 2}
                    `;
                    trackIds = leastPlayedTracks.map((t) => t.id);
                }
                break;

            case "favorites":
                // Most-played tracks - use raw query for accurate count ordering
                const mostPlayedTracks = await prisma.$queryRaw<
                    { id: string; play_count: bigint }[]
                >`
                    SELECT t.id, COUNT(p.id) as play_count
                    FROM "Track" t
                    LEFT JOIN "Play" p ON p."trackId" = t.id
                    GROUP BY t.id
                    HAVING COUNT(p.id) > 0
                    ORDER BY play_count DESC
                    LIMIT ${limitNum * 2}
                `;

                if (mostPlayedTracks.length > 0) {
                    trackIds = mostPlayedTracks.map((t) => t.id);
                } else {
                    // No play data yet - just get random tracks
                    logger.debug(
                        "[Radio:favorites] No play data found, returning random tracks"
                    );
                    const randomTracks = await prisma.track.findMany({
                        select: { id: true },
                        take: limitNum * 2,
                    });
                    trackIds = randomTracks.map((t) => t.id);
                }
                break;

            case "decade":
                // Filter by decade (e.g., value = "1990" for 90s)
                const decadeStart = parseInt(value as string) || 2000;

                const decadeTracks = await prisma.track.findMany({
                    where: {
                        album: getDecadeWhereClause(decadeStart),
                    },
                    select: { id: true },
                    take: limitNum * 3,
                });
                trackIds = decadeTracks.map((t) => t.id);
                break;

            case "genre":
                // Filter by genre (uses Artist.genres and Artist.userGenres)
                const genreValue = ((value as string) || "").toLowerCase();

                // Query Artist.genres and userGenres fields with raw SQL
                // Join Artist → Album → Track and filter by genre using LIKE for partial matching
                // Check BOTH canonical genres AND user-added genres (OR condition)
                const genreTracks = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT DISTINCT t.id
                    FROM "Artist" ar
                    JOIN "Album" a ON a."artistId" = ar.id
                    JOIN "Track" t ON t."albumId" = a.id
                    WHERE (
                        (ar.genres IS NOT NULL AND EXISTS (
                            SELECT 1 FROM jsonb_array_elements_text(ar.genres::jsonb) AS g(genre)
                            WHERE LOWER(g.genre) LIKE ${"%" + genreValue + "%"}
                        ))
                        OR
                        (ar."userGenres" IS NOT NULL AND EXISTS (
                            SELECT 1 FROM jsonb_array_elements_text(ar."userGenres"::jsonb) AS ug(genre)
                            WHERE LOWER(ug.genre) LIKE ${"%" + genreValue + "%"}
                        ))
                    )
                    LIMIT ${limitNum * 2}
                `;
                trackIds = genreTracks.map((t) => t.id);

                logger.debug(
                    `[Radio:genre] Found ${trackIds.length} tracks for genre "${genreValue}" from Artist.genres and userGenres`
                );
                break;

            case "mood":
                // Mood-based filtering using audio analysis features
                const moodValue = ((value as string) || "").toLowerCase();
                let moodWhere: any = { analysisStatus: "completed" };

                switch (moodValue) {
                    case "high-energy":
                        moodWhere = {
                            analysisStatus: "completed",
                            energy: { gte: 0.7 },
                            bpm: { gte: 120 },
                        };
                        break;
                    case "chill":
                        moodWhere = {
                            analysisStatus: "completed",
                            OR: [
                                { energy: { lte: 0.4 } },
                                { arousal: { lte: 0.4 } },
                            ],
                        };
                        break;
                    case "happy":
                        moodWhere = {
                            analysisStatus: "completed",
                            valence: { gte: 0.6 },
                            energy: { gte: 0.5 },
                        };
                        break;
                    case "melancholy":
                        moodWhere = {
                            analysisStatus: "completed",
                            OR: [
                                { valence: { lte: 0.4 } },
                                { keyScale: "minor" },
                            ],
                        };
                        break;
                    case "dance":
                        moodWhere = {
                            analysisStatus: "completed",
                            danceability: { gte: 0.7 },
                        };
                        break;
                    case "acoustic":
                        moodWhere = {
                            analysisStatus: "completed",
                            acousticness: { gte: 0.6 },
                        };
                        break;
                    case "instrumental":
                        moodWhere = {
                            analysisStatus: "completed",
                            instrumentalness: { gte: 0.7 },
                        };
                        break;
                    default:
                        // Try Last.fm tags if mood not recognized
                        moodWhere = {
                            lastfmTags: { has: moodValue },
                        };
                }

                const moodTracks = await prisma.track.findMany({
                    where: moodWhere,
                    select: { id: true },
                    take: limitNum * 3,
                });
                trackIds = moodTracks.map((t) => t.id);
                break;

            case "workout":
                // High-energy workout tracks - multiple strategies
                let workoutTrackIds: string[] = [];

                // Strategy 1: Audio analysis - high energy AND fast BPM
                const energyTracks = await prisma.track.findMany({
                    where: {
                        analysisStatus: "completed",
                        OR: [
                            // High energy with fast tempo
                            {
                                AND: [
                                    { energy: { gte: 0.65 } },
                                    { bpm: { gte: 115 } },
                                ],
                            },
                            // Has workout mood tag
                            {
                                moodTags: {
                                    hasSome: ["workout", "energetic", "upbeat"],
                                },
                            },
                        ],
                    },
                    select: { id: true },
                    take: limitNum * 2,
                });
                workoutTrackIds = energyTracks.map((t) => t.id);
                logger.debug(
                    `[Radio:workout] Found ${workoutTrackIds.length} tracks via audio analysis`
                );

                // Strategy 2: Genre-based (if not enough from audio)
                if (workoutTrackIds.length < limitNum) {
                    const workoutGenreNames = [
                        "rock",
                        "metal",
                        "hard rock",
                        "alternative rock",
                        "punk",
                        "hip hop",
                        "rap",
                        "trap",
                        "electronic",
                        "edm",
                        "house",
                        "techno",
                        "drum and bass",
                        "dubstep",
                        "hardstyle",
                        "metalcore",
                        "hardcore",
                        "industrial",
                        "nu metal",
                        "pop punk",
                    ];

                    // Check Genre table
                    const workoutGenres = await prisma.genre.findMany({
                        where: {
                            name: {
                                in: workoutGenreNames,
                                mode: "insensitive",
                            },
                        },
                        include: {
                            trackGenres: {
                                select: { trackId: true },
                                take: 50,
                            },
                        },
                    });

                    const genreTrackIds = workoutGenres.flatMap((g) =>
                        g.trackGenres.map((tg) => tg.trackId)
                    );
                    workoutTrackIds = [
                        ...new Set([...workoutTrackIds, ...genreTrackIds]),
                    ];
                    logger.debug(
                        `[Radio:workout] After genre check: ${workoutTrackIds.length} tracks`
                    );

                    // Also check album.genres JSON field
                    if (workoutTrackIds.length < limitNum) {
                        const albumGenreTracks = await prisma.track.findMany({
                            where: {
                                album: {
                                    OR: workoutGenreNames.map((g) => ({
                                        genres: { string_contains: g },
                                    })),
                                },
                            },
                            select: { id: true },
                            take: limitNum,
                        });
                        workoutTrackIds = [
                            ...new Set([
                                ...workoutTrackIds,
                                ...albumGenreTracks.map((t) => t.id),
                            ]),
                        ];
                        logger.debug(
                            `[Radio:workout] After album genre check: ${workoutTrackIds.length} tracks`
                        );
                    }
                }

                trackIds = workoutTrackIds;
                break;

            case "artist":
                // Artist Radio - plays tracks from the artist + similar artists in library
                // Uses hybrid approach: Last.fm similarity (filtered to library) + genre matching + vibe boost
                const artistId = value as string;
                if (!artistId) {
                    return res
                        .status(400)
                        .json({ error: "Artist ID required for artist radio" });
                }

                logger.debug(
                    `[Radio:artist] Starting artist radio for: ${artistId}`
                );

                // 1. Get tracks from this artist (they're in library by definition)
                const artistTracks = await prisma.track.findMany({
                    where: { album: { artistId } },
                    select: {
                        id: true,
                        bpm: true,
                        energy: true,
                        valence: true,
                        danceability: true,
                    },
                });
                logger.debug(
                    `[Radio:artist] Found ${artistTracks.length} tracks from artist`
                );

                if (artistTracks.length === 0) {
                    return res.json({ tracks: [] });
                }

                // Calculate artist's average "vibe" for later matching
                const analyzedTracks = artistTracks.filter(
                    (t) => t.bpm || t.energy || t.valence
                );
                const avgVibe =
                    analyzedTracks.length > 0
                        ? {
                              bpm:
                                  analyzedTracks.reduce(
                                      (sum, t) => sum + (t.bpm || 0),
                                      0
                                  ) / analyzedTracks.length,
                              energy:
                                  analyzedTracks.reduce(
                                      (sum, t) => sum + (t.energy || 0),
                                      0
                                  ) / analyzedTracks.length,
                              valence:
                                  analyzedTracks.reduce(
                                      (sum, t) => sum + (t.valence || 0),
                                      0
                                  ) / analyzedTracks.length,
                              danceability:
                                  analyzedTracks.reduce(
                                      (sum, t) => sum + (t.danceability || 0),
                                      0
                                  ) / analyzedTracks.length,
                          }
                        : null;
                logger.debug(`[Radio:artist] Artist vibe:`, avgVibe);

                // 2. Get library artist IDs (artists user actually owns)
                const ownedArtists = await prisma.ownedAlbum.findMany({
                    select: { artistId: true },
                    distinct: ["artistId"],
                });
                const libraryArtistIds = new Set(
                    ownedArtists.map((o) => o.artistId)
                );
                libraryArtistIds.delete(artistId); // Exclude the current artist
                logger.debug(
                    `[Radio:artist] Library has ${libraryArtistIds.size} other artists`
                );

                // 3. Try Last.fm similar artists, filtered to library
                const similarInLibrary = await prisma.similarArtist.findMany({
                    where: {
                        fromArtistId: artistId,
                        toArtistId: { in: Array.from(libraryArtistIds) },
                    },
                    orderBy: { weight: "desc" },
                    take: 15,
                });
                let similarArtistIds = similarInLibrary.map(
                    (s) => s.toArtistId
                );
                logger.debug(
                    `[Radio:artist] Found ${similarArtistIds.length} Last.fm similar artists in library`
                );

                // 4. Fallback: genre matching if not enough similar artists
                if (similarArtistIds.length < 5 && libraryArtistIds.size > 0) {
                    const artist = await prisma.artist.findUnique({
                        where: { id: artistId },
                        select: { genres: true, userGenres: true },
                    });
                    const artistGenres = getMergedGenres(artist || {});

                    if (artistGenres.length > 0) {
                        // Find library artists with overlapping genres
                        const genreMatchArtists = await prisma.artist.findMany({
                            where: {
                                id: { in: Array.from(libraryArtistIds) },
                            },
                            select: {
                                id: true,
                                genres: true,
                                userGenres: true,
                            },
                        });

                        // Score artists by genre overlap using merged genres
                        const scoredArtists = genreMatchArtists
                            .map((a) => {
                                const theirGenres = getMergedGenres(a);
                                const overlap = artistGenres.filter((g) =>
                                    theirGenres.some(
                                        (tg) =>
                                            tg
                                                .toLowerCase()
                                                .includes(g.toLowerCase()) ||
                                            g
                                                .toLowerCase()
                                                .includes(tg.toLowerCase())
                                    )
                                ).length;
                                return { id: a.id, score: overlap };
                            })
                            .filter((a) => a.score > 0)
                            .sort((a, b) => b.score - a.score)
                            .slice(0, 10);

                        const genreArtistIds = scoredArtists.map((a) => a.id);
                        similarArtistIds = [
                            ...new Set([
                                ...similarArtistIds,
                                ...genreArtistIds,
                            ]),
                        ];
                        logger.debug(
                            `[Radio:artist] After genre matching: ${similarArtistIds.length} similar artists`
                        );
                    }
                }

                // 5. Get tracks from similar library artists
                let similarTracks: {
                    id: string;
                    bpm: number | null;
                    energy: number | null;
                    valence: number | null;
                    danceability: number | null;
                }[] = [];
                if (similarArtistIds.length > 0) {
                    similarTracks = await prisma.track.findMany({
                        where: {
                            album: { artistId: { in: similarArtistIds } },
                        },
                        select: {
                            id: true,
                            bpm: true,
                            energy: true,
                            valence: true,
                            danceability: true,
                        },
                    });
                    logger.debug(
                        `[Radio:artist] Found ${similarTracks.length} tracks from similar artists`
                    );
                }

                // 6. Apply vibe boost if we have audio analysis data
                if (avgVibe && similarTracks.length > 0) {
                    // Score each similar track by how close its vibe is to the artist's average
                    similarTracks = similarTracks
                        .map((t) => {
                            if (!t.bpm && !t.energy && !t.valence)
                                return { ...t, vibeScore: 0.5 };

                            let score = 0;
                            let factors = 0;

                            if (t.bpm && avgVibe.bpm) {
                                // BPM within 20 = good match
                                const bpmDiff = Math.abs(t.bpm - avgVibe.bpm);
                                score += Math.max(0, 1 - bpmDiff / 40);
                                factors++;
                            }
                            if (t.energy !== null && avgVibe.energy) {
                                score +=
                                    1 -
                                    Math.abs((t.energy || 0) - avgVibe.energy);
                                factors++;
                            }
                            if (t.valence !== null && avgVibe.valence) {
                                score +=
                                    1 -
                                    Math.abs(
                                        (t.valence || 0) - avgVibe.valence
                                    );
                                factors++;
                            }
                            if (
                                t.danceability !== null &&
                                avgVibe.danceability
                            ) {
                                score +=
                                    1 -
                                    Math.abs(
                                        (t.danceability || 0) -
                                            avgVibe.danceability
                                    );
                                factors++;
                            }

                            return {
                                ...t,
                                vibeScore: factors > 0 ? score / factors : 0.5,
                            };
                        })
                        .sort(
                            (a, b) =>
                                (b as any).vibeScore - (a as any).vibeScore
                        );

                    logger.debug(
                        `[Radio:artist] Applied vibe boost, top score: ${(
                            similarTracks[0] as any
                        )?.vibeScore?.toFixed(2)}`
                    );
                }

                // 7. Mix: ~40% original artist, ~60% similar (vibe-boosted)
                const originalCount = Math.min(
                    Math.ceil(limitNum * 0.4),
                    artistTracks.length
                );
                const similarCount = Math.min(
                    limitNum - originalCount,
                    similarTracks.length
                );

                const selectedOriginal = artistTracks
                    .sort(() => Math.random() - 0.5)
                    .slice(0, originalCount);
                // Take top vibe-matched tracks (already sorted by vibe score), then shuffle slightly
                const selectedSimilar = similarTracks
                    .slice(0, similarCount * 2)
                    .sort(() => Math.random() - 0.3) // Slight shuffle to add variety
                    .slice(0, similarCount);

                trackIds = [...selectedOriginal, ...selectedSimilar].map(
                    (t) => t.id
                );
                logger.debug(
                    `[Radio:artist] Final mix: ${selectedOriginal.length} original + ${selectedSimilar.length} similar = ${trackIds.length} tracks`
                );
                break;

            case "vibe":
                // Vibe Match - finds tracks that sound like the given track
                // Pure audio feature matching with graceful fallbacks
                const sourceTrackId = value as string;
                if (!sourceTrackId) {
                    return res
                        .status(400)
                        .json({ error: "Track ID required for vibe matching" });
                }

                logger.debug(
                    `[Radio:vibe] Starting vibe match for track: ${sourceTrackId}`
                );

                // 1. Get the source track's audio features (including Enhanced mode fields)
                const sourceTrack = (await prisma.track.findUnique({
                    where: { id: sourceTrackId },
                    include: {
                        album: {
                            select: {
                                artistId: true,
                                genres: true,
                                artist: { select: { id: true, name: true } },
                            },
                        },
                    },
                })) as any; // Cast to any to include all Track fields

                if (!sourceTrack) {
                    return res.status(404).json({ error: "Track not found" });
                }

                // Check if track has Enhanced mode analysis
                const isEnhancedAnalysis =
                    sourceTrack.analysisMode === "enhanced" ||
                    (sourceTrack.moodHappy !== null &&
                        sourceTrack.moodSad !== null);

                logger.debug(
                    `[Radio:vibe] Source: "${sourceTrack.title}" by ${sourceTrack.album.artist.name}`
                );
                logger.debug(
                    `[Radio:vibe] Analysis mode: ${
                        isEnhancedAnalysis ? "ENHANCED" : "STANDARD"
                    }`
                );
                logger.debug(
                    `[Radio:vibe] Source features: BPM=${sourceTrack.bpm}, Energy=${sourceTrack.energy}, Valence=${sourceTrack.valence}`
                );
                if (isEnhancedAnalysis) {
                    logger.debug(
                        `[Radio:vibe] ML Moods: Happy=${sourceTrack.moodHappy}, Sad=${sourceTrack.moodSad}, Relaxed=${sourceTrack.moodRelaxed}, Aggressive=${sourceTrack.moodAggressive}, Party=${sourceTrack.moodParty}, Acoustic=${sourceTrack.moodAcoustic}, Electronic=${sourceTrack.moodElectronic}`
                    );
                }

                // Store source features for frontend visualization
                vibeSourceFeatures = {
                    bpm: sourceTrack.bpm,
                    energy: sourceTrack.energy,
                    valence: sourceTrack.valence,
                    arousal: sourceTrack.arousal,
                    danceability: sourceTrack.danceability,
                    keyScale: sourceTrack.keyScale,
                    instrumentalness: sourceTrack.instrumentalness,
                    // Enhanced mode features (all 7 ML mood predictions)
                    moodHappy: sourceTrack.moodHappy,
                    moodSad: sourceTrack.moodSad,
                    moodRelaxed: sourceTrack.moodRelaxed,
                    moodAggressive: sourceTrack.moodAggressive,
                    moodParty: sourceTrack.moodParty,
                    moodAcoustic: sourceTrack.moodAcoustic,
                    moodElectronic: sourceTrack.moodElectronic,
                    analysisMode: isEnhancedAnalysis ? "enhanced" : "standard",
                };

                let vibeMatchedIds: string[] = [];
                const sourceArtistId = sourceTrack.album.artistId;

                // 2. Try audio feature matching first (if track is analyzed)
                const hasAudioData =
                    sourceTrack.bpm ||
                    sourceTrack.energy ||
                    sourceTrack.valence;

                if (hasAudioData) {
                    // Get all analyzed tracks (excluding source) - include Enhanced mode fields
                    const analyzedTracks = await prisma.track.findMany({
                        where: {
                            id: { not: sourceTrackId },
                            analysisStatus: "completed",
                        },
                        select: {
                            id: true,
                            bpm: true,
                            energy: true,
                            valence: true,
                            arousal: true,
                            danceability: true,
                            keyScale: true,
                            moodTags: true,
                            lastfmTags: true,
                            essentiaGenres: true,
                            instrumentalness: true,
                            // Enhanced mode fields (all 7 ML mood predictions)
                            moodHappy: true,
                            moodSad: true,
                            moodRelaxed: true,
                            moodAggressive: true,
                            moodParty: true,
                            moodAcoustic: true,
                            moodElectronic: true,
                            danceabilityMl: true,
                            analysisMode: true,
                        },
                    });

                    logger.debug(
                        `[Radio:vibe] Found ${analyzedTracks.length} analyzed tracks to compare`
                    );

                    if (analyzedTracks.length > 0) {
                        // === COSINE SIMILARITY SCORING ===
                        // Industry-standard approach: build feature vectors, compute cosine similarity
                        // Uses ALL 13 features for comprehensive matching

                        // Enhanced valence: mode/tonality + mood + audio features
                        const calculateEnhancedValence = (
                            track: any
                        ): number => {
                            const happy = track.moodHappy ?? 0.5;
                            const sad = track.moodSad ?? 0.5;
                            const party = (track as any).moodParty ?? 0.5;
                            const isMajor = track.keyScale === "major";
                            const isMinor = track.keyScale === "minor";
                            const modeValence = isMajor
                                ? 0.3
                                : isMinor
                                ? -0.2
                                : 0;
                            const moodValence =
                                happy * 0.35 + party * 0.25 + (1 - sad) * 0.2;
                            const audioValence =
                                (track.energy ?? 0.5) * 0.1 +
                                (track.danceabilityMl ??
                                    track.danceability ??
                                    0.5) *
                                    0.1;

                            return Math.max(
                                0,
                                Math.min(
                                    1,
                                    moodValence + modeValence + audioValence
                                )
                            );
                        };

                        // Enhanced arousal: mood + energy + tempo (avoids unreliable "electronic" mood)
                        const calculateEnhancedArousal = (
                            track: any
                        ): number => {
                            const aggressive = track.moodAggressive ?? 0.5;
                            const party = (track as any).moodParty ?? 0.5;
                            const relaxed = track.moodRelaxed ?? 0.5;
                            const acoustic = (track as any).moodAcoustic ?? 0.5;
                            const energy = track.energy ?? 0.5;
                            const bpm = track.bpm ?? 120;
                            const moodArousal = aggressive * 0.3 + party * 0.2;
                            const energyArousal = energy * 0.25;
                            const tempoArousal =
                                Math.max(0, Math.min(1, (bpm - 60) / 120)) *
                                0.15;
                            const calmReduction =
                                (1 - relaxed) * 0.05 + (1 - acoustic) * 0.05;

                            return Math.max(
                                0,
                                Math.min(
                                    1,
                                    moodArousal +
                                        energyArousal +
                                        tempoArousal +
                                        calmReduction
                                )
                            );
                        };

                        // OOD detection using Energy-based scoring
                        const detectOOD = (track: any): boolean => {
                            const coreMoods = [
                                track.moodHappy ?? 0.5,
                                track.moodSad ?? 0.5,
                                track.moodRelaxed ?? 0.5,
                                track.moodAggressive ?? 0.5,
                            ];

                            const minMood = Math.min(...coreMoods);
                            const maxMood = Math.max(...coreMoods);

                            // Enhanced OOD detection based on research
                            // Flag if all core moods are high (>0.7) with low variance, OR if all are very neutral (~0.5)
                            const allHigh =
                                minMood > 0.7 && maxMood - minMood < 0.3;
                            const allNeutral =
                                Math.abs(maxMood - 0.5) < 0.15 &&
                                Math.abs(minMood - 0.5) < 0.15;

                            return allHigh || allNeutral;
                        };

                        // Octave-aware BPM distance calculation
                        const octaveAwareBPMDistance = (
                            bpm1: number,
                            bpm2: number
                        ): number => {
                            if (!bpm1 || !bpm2) return 0;

                            // Normalize to standard octave range (77-154 BPM)
                            const normalizeToOctave = (bpm: number): number => {
                                while (bpm < 77) bpm *= 2;
                                while (bpm > 154) bpm /= 2;
                                return bpm;
                            };

                            const norm1 = normalizeToOctave(bpm1);
                            const norm2 = normalizeToOctave(bpm2);

                            // Calculate distance on logarithmic scale for harmonic equivalence
                            const logDistance = Math.abs(
                                Math.log2(norm1) - Math.log2(norm2)
                            );
                            return Math.min(logDistance, 1); // Cap at 1 for similarity calculation
                        };

                        // Helper: Build enhanced weighted feature vector from track
                        const buildFeatureVector = (track: any): number[] => {
                            // Detect OOD and apply normalization if needed
                            const isOOD = detectOOD(track);

                            // Get mood values with OOD normalization
                            const getMoodValue = (
                                value: number | null,
                                defaultValue: number
                            ): number => {
                                if (!value) return defaultValue;
                                if (!isOOD) return value;
                                // Normalize OOD predictions to spread them out (0.2-0.8 range)
                                return (
                                    0.2 +
                                    Math.max(0, Math.min(0.6, value - 0.2))
                                );
                            };

                            // Use enhanced valence/arousal calculations
                            const enhancedValence =
                                calculateEnhancedValence(track);
                            const enhancedArousal =
                                calculateEnhancedArousal(track);

                            return [
                                // ML Mood predictions (7 features) - enhanced weighting and OOD handling
                                getMoodValue(track.moodHappy, 0.5) * 1.3, // 1.3x weight for semantic features
                                getMoodValue(track.moodSad, 0.5) * 1.3,
                                getMoodValue(track.moodRelaxed, 0.5) * 1.3,
                                getMoodValue(track.moodAggressive, 0.5) * 1.3,
                                getMoodValue((track as any).moodParty, 0.5) *
                                    1.3,
                                getMoodValue((track as any).moodAcoustic, 0.5) *
                                    1.3,
                                getMoodValue(
                                    (track as any).moodElectronic,
                                    0.5
                                ) * 1.3,
                                // Audio features (5 features) - standard weight
                                track.energy ?? 0.5,
                                enhancedArousal, // Use enhanced arousal
                                track.danceabilityMl ??
                                    track.danceability ??
                                    0.5,
                                track.instrumentalness ?? 0.5,
                                // Octave-aware BPM normalized to 0-1
                                1 -
                                    octaveAwareBPMDistance(
                                        track.bpm ?? 120,
                                        120
                                    ), // Similarity to reference tempo
                                // Enhanced key mode with valence consideration
                                enhancedValence, // Use enhanced valence instead of binary key
                            ];
                        };

                        // Helper: Compute cosine similarity between two vectors
                        const cosineSimilarity = (
                            a: number[],
                            b: number[]
                        ): number => {
                            let dot = 0,
                                magA = 0,
                                magB = 0;
                            for (let i = 0; i < a.length; i++) {
                                dot += a[i] * b[i];
                                magA += a[i] * a[i];
                                magB += b[i] * b[i];
                            }
                            if (magA === 0 || magB === 0) return 0;
                            return dot / (Math.sqrt(magA) * Math.sqrt(magB));
                        };

                        // Helper: Compute tag overlap bonus
                        const computeTagBonus = (
                            sourceTags: string[],
                            sourceGenres: string[],
                            trackTags: string[],
                            trackGenres: string[]
                        ): number => {
                            const sourceSet = new Set(
                                [...sourceTags, ...sourceGenres].map((t) =>
                                    t.toLowerCase()
                                )
                            );
                            const trackSet = new Set(
                                [...trackTags, ...trackGenres].map((t) =>
                                    t.toLowerCase()
                                )
                            );
                            if (sourceSet.size === 0 || trackSet.size === 0)
                                return 0;
                            const overlap = [...sourceSet].filter((tag) =>
                                trackSet.has(tag)
                            ).length;
                            // Max 5% bonus for tag overlap
                            return Math.min(0.05, overlap * 0.01);
                        };

                        // Build source feature vector once
                        const sourceVector = buildFeatureVector(sourceTrack);

                        // Check if source track has Enhanced mode data
                        const bothEnhanced = isEnhancedAnalysis;

                        const scored = analyzedTracks.map((t) => {
                            // Check if target track has Enhanced mode data
                            const targetEnhanced =
                                t.analysisMode === "enhanced" ||
                                (t.moodHappy !== null && t.moodSad !== null);
                            const useEnhanced = bothEnhanced && targetEnhanced;

                            // Build target feature vector
                            const targetVector = buildFeatureVector(t as any);

                            // Compute base cosine similarity
                            let score = cosineSimilarity(
                                sourceVector,
                                targetVector
                            );

                            // Add tag/genre overlap bonus (max 5%)
                            const tagBonus = computeTagBonus(
                                sourceTrack.lastfmTags || [],
                                sourceTrack.essentiaGenres || [],
                                t.lastfmTags || [],
                                t.essentiaGenres || []
                            );

                            // Final score: 95% cosine similarity + 5% tag bonus
                            const finalScore = score * 0.95 + tagBonus;

                            return {
                                id: t.id,
                                score: finalScore,
                                enhanced: useEnhanced,
                            };
                        });

                        // Filter to good matches and sort by score
                        // Use lower threshold (40%) for Enhanced mode since it's more precise
                        const minThreshold = isEnhancedAnalysis ? 0.4 : 0.5;
                        const goodMatches = scored
                            .filter((t) => t.score > minThreshold)
                            .sort((a, b) => b.score - a.score);

                        vibeMatchedIds = goodMatches.map((t) => t.id);
                        const enhancedCount = goodMatches.filter(
                            (t) => t.enhanced
                        ).length;
                        logger.debug(
                            `[Radio:vibe] Audio matching found ${
                                vibeMatchedIds.length
                            } tracks (>${minThreshold * 100}% similarity)`
                        );
                        logger.debug(
                            `[Radio:vibe] Enhanced matches: ${enhancedCount}, Standard matches: ${
                                goodMatches.length - enhancedCount
                            }`
                        );

                        if (goodMatches.length > 0) {
                            logger.debug(
                                `[Radio:vibe] Top match score: ${goodMatches[0].score.toFixed(
                                    2
                                )} (${
                                    goodMatches[0].enhanced
                                        ? "enhanced"
                                        : "standard"
                                })`
                            );
                        }
                    }
                }

                // 3. Fallback A: Same artist's other tracks
                if (vibeMatchedIds.length < limitNum) {
                    const artistTracks = await prisma.track.findMany({
                        where: {
                            album: { artistId: sourceArtistId },
                            id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                        },
                        select: { id: true },
                    });
                    const newIds = artistTracks.map((t) => t.id);
                    vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                    logger.debug(
                        `[Radio:vibe] Fallback A (same artist): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`
                    );
                }

                // 4. Fallback B: Similar artists from Last.fm (filtered to library)
                if (vibeMatchedIds.length < limitNum) {
                    const ownedArtistIds = await prisma.ownedAlbum.findMany({
                        select: { artistId: true },
                        distinct: ["artistId"],
                    });
                    const libraryArtistSet = new Set(
                        ownedArtistIds.map((o) => o.artistId)
                    );
                    libraryArtistSet.delete(sourceArtistId);

                    const similarArtists = await prisma.similarArtist.findMany({
                        where: {
                            fromArtistId: sourceArtistId,
                            toArtistId: { in: Array.from(libraryArtistSet) },
                        },
                        orderBy: { weight: "desc" },
                        take: 10,
                    });

                    if (similarArtists.length > 0) {
                        const similarArtistTracks = await prisma.track.findMany(
                            {
                                where: {
                                    album: {
                                        artistId: {
                                            in: similarArtists.map(
                                                (s) => s.toArtistId
                                            ),
                                        },
                                    },
                                    id: {
                                        notIn: [
                                            sourceTrackId,
                                            ...vibeMatchedIds,
                                        ],
                                    },
                                },
                                select: { id: true },
                            }
                        );
                        const newIds = similarArtistTracks.map((t) => t.id);
                        vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                        logger.debug(
                            `[Radio:vibe] Fallback B (similar artists): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`
                        );
                    }
                }

                // 5. Fallback C: Same genre (using TrackGenre relation)
                const sourceGenres =
                    (sourceTrack.album.genres as string[]) || [];
                if (
                    vibeMatchedIds.length < limitNum &&
                    sourceGenres.length > 0
                ) {
                    // Search using the TrackGenre relation for better accuracy
                    const genreTracks = await prisma.track.findMany({
                        where: {
                            trackGenres: {
                                some: {
                                    genre: {
                                        name: {
                                            in: sourceGenres,
                                            mode: "insensitive",
                                        },
                                    },
                                },
                            },
                            id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                        },
                        select: { id: true },
                        take: limitNum,
                    });
                    const newIds = genreTracks.map((t) => t.id);
                    vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                    logger.debug(
                        `[Radio:vibe] Fallback C (same genre): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`
                    );
                }

                // 6. Fallback D: Random from library
                if (vibeMatchedIds.length < limitNum) {
                    const randomTracks = await prisma.track.findMany({
                        where: {
                            id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                        },
                        select: { id: true },
                        take: limitNum - vibeMatchedIds.length,
                    });
                    const newIds = randomTracks.map((t) => t.id);
                    vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                    logger.debug(
                        `[Radio:vibe] Fallback D (random): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`
                    );
                }

                trackIds = vibeMatchedIds;
                logger.debug(
                    `[Radio:vibe] Final vibe queue: ${trackIds.length} tracks`
                );
                break;

            case "all":
            default:
                // Random selection from all tracks in library
                const allTracks = await prisma.track.findMany({
                    select: { id: true },
                });
                trackIds = allTracks.map((t) => t.id);
        }

        // For vibe mode, keep the sorted order (by match score)
        // For other modes, shuffle the results
        const finalIds =
            type === "vibe"
                ? trackIds.slice(0, limitNum) // Already sorted by match score
                : trackIds.sort(() => Math.random() - 0.5).slice(0, limitNum);

        if (finalIds.length === 0) {
            return res.json({ tracks: [] });
        }

        // Fetch full track data (include all analysis fields for logging)
        const tracks = await prisma.track.findMany({
            where: {
                id: { in: finalIds },
            },
            include: {
                album: {
                    include: {
                        artist: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
                trackGenres: {
                    include: {
                        genre: { select: { name: true } },
                    },
                },
            },
        });

        // For vibe mode, reorder tracks to match the sorted finalIds order
        // (Prisma's findMany with IN doesn't preserve order)
        let orderedTracks = tracks;
        if (type === "vibe") {
            const trackMap = new Map(tracks.map((t) => [t.id, t]));
            orderedTracks = finalIds
                .map((id) => trackMap.get(id))
                .filter((t): t is (typeof tracks)[0] => t !== undefined);
        }

        // === VIBE QUEUE LOGGING ===
        // Log detailed info for vibe matching analysis (using ordered tracks)
        if (type === "vibe" && vibeSourceFeatures) {
            logger.debug("\n" + "=".repeat(100));
            logger.debug("VIBE QUEUE ANALYSIS - Source Track");
            logger.debug("=".repeat(100));

            // Find source track for logging
            const srcTrack = await prisma.track.findUnique({
                where: { id: value as string },
                include: {
                    album: { include: { artist: { select: { name: true } } } },
                    trackGenres: {
                        include: { genre: { select: { name: true } } },
                    },
                },
            });

            if (srcTrack) {
                logger.debug(
                    `SOURCE: "${srcTrack.title}" by ${srcTrack.album.artist.name}`
                );
                logger.debug(`  Album: ${srcTrack.album.title}`);
                logger.debug(
                    `  Analysis Mode: ${
                        (srcTrack as any).analysisMode || "unknown"
                    }`
                );
                logger.debug(
                    `  BPM: ${srcTrack.bpm?.toFixed(1) || "N/A"} | Energy: ${
                        srcTrack.energy?.toFixed(2) || "N/A"
                    } | Valence: ${srcTrack.valence?.toFixed(2) || "N/A"}`
                );
                logger.debug(
                    `  Danceability: ${
                        srcTrack.danceability?.toFixed(2) || "N/A"
                    } | Arousal: ${
                        srcTrack.arousal?.toFixed(2) || "N/A"
                    } | Key: ${srcTrack.keyScale || "N/A"}`
                );
                logger.debug(
                    `  ML Moods: Happy=${
                        (srcTrack as any).moodHappy?.toFixed(2) || "N/A"
                    }, Sad=${
                        (srcTrack as any).moodSad?.toFixed(2) || "N/A"
                    }, Relaxed=${
                        (srcTrack as any).moodRelaxed?.toFixed(2) || "N/A"
                    }, Aggressive=${
                        (srcTrack as any).moodAggressive?.toFixed(2) || "N/A"
                    }`
                );
                logger.debug(
                    `  Genres: ${
                        srcTrack.trackGenres
                            .map((tg) => tg.genre.name)
                            .join(", ") || "N/A"
                    }`
                );
                logger.debug(
                    `  Last.fm Tags: ${
                        ((srcTrack as any).lastfmTags || []).join(", ") || "N/A"
                    }`
                );
                logger.debug(
                    `  Mood Tags: ${
                        ((srcTrack as any).moodTags || []).join(", ") || "N/A"
                    }`
                );
            }

            logger.debug("\n" + "-".repeat(100));
            logger.debug(
                `VIBE QUEUE - ${orderedTracks.length} tracks (showing up to 50, SORTED BY MATCH SCORE)`
            );
            logger.debug("-".repeat(100));
            logger.debug(
                `${"#".padEnd(3)} | ${"TRACK".padEnd(35)} | ${"ARTIST".padEnd(
                    20
                )} | ${"BPM".padEnd(6)} | ${"ENG".padEnd(5)} | ${"VAL".padEnd(
                    5
                )} | ${"H".padEnd(4)} | ${"S".padEnd(4)} | ${"R".padEnd(
                    4
                )} | ${"A".padEnd(4)} | MODE    | GENRES`
            );
            logger.debug("-".repeat(100));

            orderedTracks.slice(0, 50).forEach((track, i) => {
                const t = track as any;
                const title = track.title.substring(0, 33).padEnd(35);
                const artist = track.album.artist.name
                    .substring(0, 18)
                    .padEnd(20);
                const bpm = track.bpm
                    ? track.bpm.toFixed(0).padEnd(6)
                    : "N/A".padEnd(6);
                const energy =
                    track.energy !== null
                        ? track.energy.toFixed(2).padEnd(5)
                        : "N/A".padEnd(5);
                const valence =
                    track.valence !== null
                        ? track.valence.toFixed(2).padEnd(5)
                        : "N/A".padEnd(5);
                const happy =
                    t.moodHappy !== null
                        ? t.moodHappy.toFixed(2).padEnd(4)
                        : "N/A".padEnd(4);
                const sad =
                    t.moodSad !== null
                        ? t.moodSad.toFixed(2).padEnd(4)
                        : "N/A".padEnd(4);
                const relaxed =
                    t.moodRelaxed !== null
                        ? t.moodRelaxed.toFixed(2).padEnd(4)
                        : "N/A".padEnd(4);
                const aggressive =
                    t.moodAggressive !== null
                        ? t.moodAggressive.toFixed(2).padEnd(4)
                        : "N/A".padEnd(4);
                const mode = (t.analysisMode || "std")
                    .substring(0, 7)
                    .padEnd(8);
                const genres = track.trackGenres
                    .slice(0, 3)
                    .map((tg) => tg.genre.name)
                    .join(", ");

                logger.debug(
                    `${String(i + 1).padEnd(
                        3
                    )} | ${title} | ${artist} | ${bpm} | ${energy} | ${valence} | ${happy} | ${sad} | ${relaxed} | ${aggressive} | ${mode} | ${genres}`
                );
            });

            if (orderedTracks.length > 50) {
                logger.debug(
                    `... and ${orderedTracks.length - 50} more tracks`
                );
            }

            logger.debug("=".repeat(100) + "\n");
        }

        // Transform to match frontend Track interface
        const transformedTracks = orderedTracks.map((track) => ({
            id: track.id,
            title: track.title,
            duration: track.duration,
            trackNo: track.trackNo,
            filePath: track.filePath,
            artist: {
                id: track.album.artist.id,
                name: track.album.artist.name,
            },
            album: {
                id: track.album.id,
                title: track.album.title,
                coverArt: track.album.coverUrl,
            },
            // Include audio features for vibe mode visualization (if available)
            ...(vibeSourceFeatures && {
                audioFeatures: {
                    bpm: track.bpm,
                    energy: track.energy,
                    valence: track.valence,
                    arousal: track.arousal,
                    danceability: track.danceability,
                    keyScale: track.keyScale,
                    instrumentalness: track.instrumentalness,
                    analysisMode: track.analysisMode,
                    // ML Mood predictions for enhanced visualization
                    moodHappy: track.moodHappy,
                    moodSad: track.moodSad,
                    moodRelaxed: track.moodRelaxed,
                    moodAggressive: track.moodAggressive,
                    moodParty: track.moodParty,
                    moodAcoustic: track.moodAcoustic,
                    moodElectronic: track.moodElectronic,
                },
            }),
        }));

        // For vibe mode, keep sorted order. For other modes, shuffle.
        const finalTracks =
            type === "vibe"
                ? transformedTracks
                : transformedTracks.sort(() => Math.random() - 0.5);

        // Include source features if this was a vibe request
        const response: any = { tracks: finalTracks };
        if (vibeSourceFeatures) {
            response.sourceFeatures = vibeSourceFeatures;
        }

        res.json(response);
    } catch (error) {
        logger.error("Radio endpoint error:", error);
        res.status(500).json({ error: "Failed to get radio tracks" });
    }
});

export default router;
