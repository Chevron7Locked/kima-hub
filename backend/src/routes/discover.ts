import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { lastFmService } from "../services/lastfm";
import { startOfWeek, endOfWeek } from "date-fns";
import axios from "axios";
import fs from "fs";
import path from "path";
import { config } from "../config";

// Static imports for performance
import { discoverQueue, scanQueue } from "../workers/queues";
import { getSystemSettings } from "../utils/systemSettings";
import { lidarrService } from "../services/lidarr";
import {
  UserFacingError,
  IntegrationError,
  ConfigurationError,
  RateLimitError,
} from '../utils/errors';
import { distributedLock } from '../utils/distributedLock';

const router = Router();

router.use(requireAuthOrToken);

// GET /discover/batch-status - Check if there's an active batch being processed
router.get("/batch-status", async (req, res) => {
    try {
        const userId = req.user!.id;

        // Find any active batch for this user
        const activeBatch = await prisma.discoveryBatch.findFirst({
            where: {
                userId,
                status: { in: ["downloading", "scanning"] },
            },
            include: {
                jobs: {
                    select: {
                        status: true,
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        if (!activeBatch) {
            logger.debug(`[Batch Status] User ${userId}: No active batch`);
            return res.json({
                active: false,
                status: null,
                progress: null,
            });
        }

        const completedJobs = activeBatch.jobs.filter(
            (j) => j.status === "completed"
        ).length;
        const failedJobs = activeBatch.jobs.filter(
            (j) => j.status === "failed" || j.status === "exhausted"
        ).length;
        const totalJobs = activeBatch.jobs.length;
        const progress =
            totalJobs > 0
                ? Math.round(((completedJobs + failedJobs) / totalJobs) * 100)
                : 0;

        const response = {
            active: true,
            status: activeBatch.status,
            batchId: activeBatch.id,
            progress,
            completed: completedJobs,
            failed: failedJobs,
            total: totalJobs,
        };

        logger.info(`[Batch Status] User ${userId}: ACTIVE batch found - ${activeBatch.id}, status: ${activeBatch.status}, progress: ${progress}%`);

        res.json(response);
    } catch (error) {
        logger.error("Get batch status error:", error);
        res.status(500).json({ error: "Failed to get batch status" });
    }
});

// DELETE /discover/batch - Cancel/reset stuck batch
router.delete("/batch", async (req, res) => {
    try {
        const userId = req.user!.id;

        logger.info(`[Discover Cancel] Starting cancellation for user ${userId}`);

        // Find ALL active batches for this user (in case there are multiple)
        const activeBatches = await prisma.discoveryBatch.findMany({
            where: {
                userId,
                status: { in: ["downloading", "scanning"] },
            },
            include: {
                jobs: true,
            },
            orderBy: { createdAt: "desc" },
        });

        logger.info(`[Discover Cancel] Found ${activeBatches.length} active batches`);

        if (activeBatches.length === 0) {
            return res.json({
                success: true,
                message: "No active batch to cancel",
                batchesCancelled: 0,
            });
        }

        let batchesCancelled = 0;
        let jobsCancelled = 0;
        let downloadJobsCancelled = 0;

        for (const batch of activeBatches) {
            logger.info(`[Discover Cancel] Processing batch ${batch.id}, status: ${batch.status}`);

            // Cancel all DownloadJobs associated with this batch
            const downloadJobsUpdated = await prisma.downloadJob.updateMany({
                where: {
                    discoveryBatchId: batch.id,
                    status: { in: ["pending", "active", "waiting"] },
                },
                data: {
                    status: "failed",
                    error: "Cancelled by user",
                },
            });
            downloadJobsCancelled += downloadJobsUpdated.count;
            logger.info(`[Discover Cancel] Cancelled ${downloadJobsUpdated.count} download jobs for batch ${batch.id}`);

            // Mark batch as completed
            await prisma.discoveryBatch.update({
                where: { id: batch.id },
                data: {
                    status: "completed",
                    completedAt: new Date(),
                    errorMessage: "Cancelled by user",
                },
            });
            batchesCancelled++;
            logger.info(`[Discover Cancel] Marked batch ${batch.id} as completed`);
        }

        // Find and cancel any active BullMQ jobs for this user
        const activeJobs = await discoverQueue.getActive();
        for (const job of activeJobs) {
            if (job.data.userId === userId) {
                try {
                    await job.moveToFailed(new Error("Cancelled by user"), "");
                    jobsCancelled++;
                    logger.info(`[Discover Cancel] Cancelled Bull job ${job.id}`);
                } catch (jobError) {
                    logger.warn(`[Discover Cancel] Failed to cancel job ${job.id}:`, jobError);
                }
            }
        }

        // Also check waiting jobs
        const waitingJobs = await discoverQueue.getWaiting();
        for (const job of waitingJobs) {
            if (job.data.userId === userId) {
                try {
                    await job.remove();
                    jobsCancelled++;
                    logger.info(`[Discover Cancel] Removed waiting job ${job.id}`);
                } catch (jobError) {
                    logger.warn(`[Discover Cancel] Failed to remove job ${job.id}:`, jobError);
                }
            }
        }

        logger.info(`[Discover Cancel] Complete: ${batchesCancelled} batches, ${jobsCancelled} Bull jobs, ${downloadJobsCancelled} download jobs`);

        res.json({
            success: true,
            message: "Batch cancelled",
            batchesCancelled,
            jobsCancelled,
            downloadJobsCancelled,
            batchIds: activeBatches.map(b => b.id),
        });
    } catch (error) {
        logger.error("[Discover Cancel] Error:", error);
        res.status(500).json({ error: "Failed to cancel batch" });
    }
});

// POST /discover/generate - Generate new Discover Weekly playlist
router.post("/generate", async (req, res) => {
    try {
        const userId = req.user!.id;

        // Use distributed lock to prevent race condition between check and queue
        const result = await distributedLock.withLock(
            `discover:generate:${userId}`,
            30000,
            async () => {
                // Check for existing active batch
                const existingBatch = await prisma.discoveryBatch.findFirst({
                    where: {
                        userId,
                        status: { in: ["downloading", "scanning"] },
                    },
                });

                if (existingBatch) {
                    return {
                        conflict: true as const,
                        batchId: existingBatch.id,
                        status: existingBatch.status,
                    };
                }

                logger.debug(`\n Queuing Discover Weekly generation for user ${userId}`);

                // Add generation job to queue
                const weekKey = startOfWeek(new Date(), { weekStartsOn: 1 }).toISOString().split('T')[0];
                const job = await discoverQueue.add("discover-weekly", { userId }, {
                    jobId: `discover-weekly-${userId}-${weekKey}`,
                });

                return { conflict: false as const, jobId: job.id };
            },
        );

        if (result.conflict) {
            return res.status(409).json({
                error: "Generation already in progress",
                batchId: result.batchId,
                status: result.status,
            });
        }

        res.json({
            message: "Discover Weekly generation started",
            jobId: result.jobId,
        });
    } catch (error) {
        // Lock acquisition failure means another request is already processing
        if (error instanceof Error && error.message.startsWith('Failed to acquire lock')) {
            return res.status(409).json({
                error: "Generation already in progress",
                code: 'LOCK_CONFLICT',
            });
        }

        if (error instanceof UserFacingError) {
            return res.status(error.statusCode).json({
                error: error.message,
                code: error.code,
            });
        }

        if (error instanceof ConfigurationError) {
            return res.status(400).json({
                error: error.message,
                code: 'CONFIGURATION_ERROR',
            });
        }

        if (error instanceof RateLimitError) {
            return res.status(429).json({
                error: error.message,
                retryAfter: error.retryAfter,
            });
        }

        if (error instanceof IntegrationError) {
            logger.error(`Integration error (${error.integration}):`, error);
            return res.status(503).json({
                error: `${error.integration} is currently unavailable. Please try again later.`,
                code: 'INTEGRATION_ERROR',
            });
        }

        // Unknown error
        logger.error('Unexpected error in discovery generation:', error);
        return res.status(500).json({
            error: 'An unexpected error occurred',
            code: 'INTERNAL_ERROR',
        });
    }
});

// GET /discover/generate/status/:jobId - Check generation job status
router.get("/generate/status/:jobId", async (req, res) => {
    try {
        const job = await discoverQueue.getJob(req.params.jobId);

        if (!job) {
            return res.status(404).json({ error: "Job not found" });
        }

        const state = await job.getState();
        const progress = job.progress;
        const result = job.returnvalue;

        res.json({
            status: state,
            progress,
            result,
        });
    } catch (error) {
        logger.error("Get generation status error:", error);
        res.status(500).json({ error: "Failed to get job status" });
    }
});

// GET /discover/current - Get current week's Discover Weekly playlist
router.get("/current", async (req, res) => {
    try {
        const userId = req.user!.id;

        const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 }); // Monday
        const weekEnd = endOfWeek(new Date(), { weekStartsOn: 1 }); // Sunday

        // Get all discovery albums for this week with their tracks
        const discoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                weekStartDate: weekStart,
                status: { in: ["ACTIVE", "LIKED"] },
            },
            include: {
                tracks: true, // DiscoveryTrack records (trackId is just a string, not a relation)
            },
            orderBy: { downloadedAt: "asc" },
        });

        // Get unavailable albums for this week (show full replacement chain)
        const unavailableAlbums = await prisma.unavailableAlbum.findMany({
            where: {
                userId,
                weekStartDate: weekStart,
            },
            orderBy: [
                { originalAlbumId: "asc" }, // Group by original album
                { attemptNumber: "asc" }, // Then sort by attempt number
            ],
        });

        // Build track list from DiscoveryTrack records (the actual selected tracks)
        const tracks = [];

        for (const discoveryAlbum of discoveryAlbums) {
            // If we have DiscoveryTrack records, use them (the actual selected tracks)
            if (discoveryAlbum.tracks && discoveryAlbum.tracks.length > 0) {
                // Fetch all tracks in one query using their IDs
                const trackIds = discoveryAlbum.tracks
                    .map((dt) => dt.trackId)
                    .filter((id): id is string => id !== null);

                if (trackIds.length > 0) {
                    const libraryTracks = await prisma.track.findMany({
                        where: { id: { in: trackIds } },
                        include: { album: { include: { artist: true } } },
                    });

                    // Create a map for quick lookup
                    const trackMap = new Map(
                        libraryTracks.map((t) => [t.id, t])
                    );

                    for (const dt of discoveryAlbum.tracks) {
                        const track = dt.trackId
                            ? trackMap.get(dt.trackId)
                            : null;
                        if (track) {
                            tracks.push({
                                id: track.id,
                                title: track.title,
                                artist: discoveryAlbum.artistName,
                                album: discoveryAlbum.albumTitle,
                                albumId: discoveryAlbum.rgMbid,
                                isLiked: discoveryAlbum.status === "LIKED",
                                likedAt: discoveryAlbum.likedAt,
                                similarity: discoveryAlbum.similarity,
                                tier: discoveryAlbum.tier,
                                coverUrl: track.album?.coverUrl,
                                available: true,
                                duration: track.duration,
                            });
                        }
                    }
                }
            }

            // Fallback: No DiscoveryTrack records or no valid trackIds, find ONE track from library
            if (
                tracks.filter((t) => t.album === discoveryAlbum.albumTitle)
                    .length === 0
            ) {
                const album = await prisma.album.findFirst({
                    where: {
                        title: discoveryAlbum.albumTitle,
                        artist: { name: discoveryAlbum.artistName },
                    },
                    include: {
                        artist: true,
                        tracks: { take: 1, orderBy: { trackNo: "asc" } },
                    },
                });

                if (album && album.tracks.length > 0) {
                    const track = album.tracks[0];
                    tracks.push({
                        id: track.id,
                        title: track.title,
                        artist: discoveryAlbum.artistName,
                        album: discoveryAlbum.albumTitle,
                        albumId: discoveryAlbum.rgMbid,
                        isLiked: discoveryAlbum.status === "LIKED",
                        likedAt: discoveryAlbum.likedAt,
                        similarity: discoveryAlbum.similarity,
                        tier: discoveryAlbum.tier,
                        coverUrl: album.coverUrl,
                        available: true,
                        duration: track.duration,
                    });
                } else {
                    // Album not in library yet (downloading/pending)
                    tracks.push({
                        id: `pending-${discoveryAlbum.id}`,
                        title: `${discoveryAlbum.albumTitle} (pending import)`,
                        artist: discoveryAlbum.artistName,
                        album: discoveryAlbum.albumTitle,
                        albumId: discoveryAlbum.rgMbid,
                        isLiked: discoveryAlbum.status === "LIKED",
                        likedAt: discoveryAlbum.likedAt,
                        similarity: discoveryAlbum.similarity,
                        tier: discoveryAlbum.tier,
                        coverUrl: null,
                        available: false,
                        isPending: true,
                        duration: 0,
                    });
                }
            }
        }

        // Get the list of successfully downloaded album MBIDs from discoveryAlbums
        const successfulMbids = new Set(discoveryAlbums.map((da) => da.rgMbid));

        // Filter unavailable albums:
        // 1. Remove albums that successfully downloaded (have DiscoveryAlbum record)
        // 2. Remove albums that the user now owns (in Album table)

        // Batch fetch: albums matching by rgMbid
        const allUnavailableMbids = unavailableAlbums
            .map((a) => a.albumMbid)
            .filter(Boolean);
        const existingByMbid = new Set(
            (await prisma.album.findMany({
                where: { rgMbid: { in: allUnavailableMbids } },
                select: { rgMbid: true },
            })).map((a) => a.rgMbid)
        );

        // Batch fetch: all library albums with their artist names for fuzzy matching
        const libraryAlbumsForMatch = await prisma.album.findMany({
            select: {
                title: true,
                artist: { select: { name: true } },
            },
        });
        const libraryAlbumIndex = libraryAlbumsForMatch.map((a) => ({
            title: a.title.toLowerCase().trim(),
            artist: a.artist.name.toLowerCase().trim(),
        }));

        const filteredUnavailable: typeof unavailableAlbums = [];
        for (const album of unavailableAlbums) {
            if (successfulMbids.has(album.albumMbid)) {
                continue;
            }

            // Check rgMbid match from batch query
            if (existingByMbid.has(album.albumMbid)) {
                continue;
            }

            // Check fuzzy title/artist match in-memory
            const normalizedArtist = album.artistName.toLowerCase().trim();
            const normalizedAlbum = album.albumTitle
                .toLowerCase()
                .replace(/\(.*?\)/g, "")
                .replace(/\[.*?\]/g, "")
                .trim();

            const existsInLibrary = libraryAlbumIndex.some(
                (lib) =>
                    lib.title.includes(normalizedAlbum) &&
                    lib.artist.includes(normalizedArtist)
            );

            if (existsInLibrary) {
                continue;
            }

            filteredUnavailable.push(album);
        }

        // Format unavailable albums
        const unavailable = filteredUnavailable.map((album) => ({
            id: `unavailable-${album.id}`,
            title: album.albumTitle,
            artist: album.artistName,
            album: album.albumTitle,
            albumId: album.albumMbid,
            similarity: album.similarity,
            tier: album.tier,
            previewUrl: album.previewUrl,
            deezerTrackId: album.deezerTrackId,
            deezerAlbumId: album.deezerAlbumId,
            attemptNumber: album.attemptNumber,
            originalAlbumId: album.originalAlbumId,
            available: false,
        }));

        try {
            logger.debug(`\nDiscover Weekly API Response:`);
            logger.debug(`  Total tracks: ${tracks.length}`);
            logger.debug(`  Unavailable albums: ${unavailable.length}`);
            if (unavailable.length > 0 && unavailable.length <= 20) {
                logger.debug(`  Unavailable albums with previews:`);
                unavailable.slice(0, 5).forEach((album, i) => {
                    logger.debug(
                        `    ${i + 1}. ${album.artist} - ${album.album} [${
                            album.previewUrl ? "HAS PREVIEW" : "NO PREVIEW"
                        }]`
                    );
                });
                if (unavailable.length > 5) {
                    logger.debug(`    ... and ${unavailable.length - 5} more`);
                }
            }
        } catch (err) {
            logger.error("Error logging discover response:", err);
        }

        res.json({
            weekStart,
            weekEnd,
            tracks,
            unavailable,
            totalCount: tracks.length,
            unavailableCount: unavailable.length,
        });
    } catch (error) {
        logger.error("Get current Discover Weekly error:", error);
        res.status(500).json({
            error: "Failed to get Discover Weekly playlist",
        });
    }
});

// POST /discover/like - Like a track (marks entire album for keeping)
router.post("/like", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { albumId } = req.body;

        if (!albumId) {
            return res.status(400).json({ error: "albumId required" });
        }

        // Find the discovery album
        const discoveryAlbum = await prisma.discoveryAlbum.findFirst({
            where: {
                userId,
                rgMbid: albumId,
                status: "ACTIVE",
            },
        });

        if (!discoveryAlbum) {
            return res
                .status(404)
                .json({ error: "Album not in active discovery" });
        }

        // Mark as liked (entire album will be kept)
        await prisma.discoveryAlbum.update({
            where: { id: discoveryAlbum.id },
            data: {
                status: "LIKED",
                likedAt: new Date(),
            },
        });

        // Remove discovery tag from the artist in Lidarr
        // This prevents the artist from being deleted during cleanup
        logger.debug(
            `   Removing discovery tag from artist: ${discoveryAlbum.artistName}`
        );

        // If artistMbid is a temp ID, we need to search Lidarr by artist name instead
        if (
            discoveryAlbum.artistMbid &&
            !discoveryAlbum.artistMbid.startsWith("temp-")
        ) {
            await lidarrService.removeDiscoveryTagByMbid(
                discoveryAlbum.artistMbid
            );
        } else {
            // Search Lidarr for the artist by name and remove tag
            try {
                const lidarrArtists = await lidarrService.getArtists();
                const lidarrArtist = lidarrArtists.find(
                    (a) =>
                        a.artistName.toLowerCase() ===
                        discoveryAlbum.artistName.toLowerCase()
                );

                if (lidarrArtist) {
                    const tagId = await lidarrService.getOrCreateDiscoveryTag();
                    if (tagId && lidarrArtist.tags?.includes(tagId)) {
                        await lidarrService.removeTagsFromArtist(
                            lidarrArtist.id,
                            [tagId]
                        );
                        logger.debug(
                            `   Removed discovery tag from ${lidarrArtist.artistName} (found by name)`
                        );
                    }
                } else {
                    logger.debug(
                        `   Artist ${discoveryAlbum.artistName} not found in Lidarr (may have been removed)`
                    );
                }
            } catch (e: any) {
                logger.debug(`   Failed to remove discovery tag: ${e.message}`);
            }
        }

        // Find the actual Album record and create OwnedAlbum so it appears in library immediately
        // Match by artist name + album title since rgMbid may differ between DiscoveryAlbum and scanned Album
        const dbAlbum = await prisma.album.findFirst({
            where: {
                OR: [
                    { rgMbid: albumId },
                    {
                        title: {
                            equals: discoveryAlbum.albumTitle,
                            mode: "insensitive",
                        },
                        artist: {
                            name: {
                                equals: discoveryAlbum.artistName,
                                mode: "insensitive",
                            },
                        },
                    },
                ],
            },
            include: { artist: true },
        });

        if (dbAlbum) {
            // Update album location to LIBRARY so it appears in owned view
            await prisma.album.update({
                where: { id: dbAlbum.id },
                data: { location: "LIBRARY" },
            });

            // Create OwnedAlbum record if doesn't exist (makes it appear in "Owned" filter)
            await prisma.ownedAlbum.upsert({
                where: {
                    artistId_rgMbid: {
                        artistId: dbAlbum.artistId,
                        rgMbid: dbAlbum.rgMbid,
                    },
                },
                create: {
                    artistId: dbAlbum.artistId,
                    rgMbid: dbAlbum.rgMbid,
                    source: "discovery_liked",
                },
                update: {
                    source: "discovery_liked",
                },
            });
            logger.debug(
                ` Added liked album to library: ${dbAlbum.artist.name} - ${dbAlbum.title} (matched from discovery)`
            );
        } else {
            logger.debug(
                `   [WARN] Could not find scanned album for: ${discoveryAlbum.artistName} - ${discoveryAlbum.albumTitle}`
            );
        }

        // Retroactively mark all plays from this album as DISCOVERY_KEPT
        // Note: This requires getting tracks from the album first
        const tracks = await prisma.discoveryTrack.findMany({
            where: { discoveryAlbumId: discoveryAlbum.id },
            select: { trackId: true },
        });

        const trackIds = tracks
            .map((t) => t.trackId)
            .filter((id): id is string => id !== null);

        if (trackIds.length > 0) {
            await prisma.play.updateMany({
                where: {
                    userId,
                    trackId: { in: trackIds },
                    source: "DISCOVERY",
                },
                data: {
                    source: "DISCOVERY_KEPT",
                },
            });
        }

        res.json({ success: true });
    } catch (error) {
        logger.error("Like discovery album error:", error);
        res.status(500).json({ error: "Failed to like album" });
    }
});

// DELETE /discover/unlike - Unlike a track
router.delete("/unlike", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { albumId } = req.body;

        if (!albumId) {
            return res.status(400).json({ error: "albumId required" });
        }

        const discoveryAlbum = await prisma.discoveryAlbum.findFirst({
            where: {
                userId,
                rgMbid: albumId,
                status: "LIKED",
            },
        });

        if (!discoveryAlbum) {
            return res.status(404).json({ error: "Album not liked" });
        }

        // Revert status back to ACTIVE
        await prisma.discoveryAlbum.update({
            where: { id: discoveryAlbum.id },
            data: {
                status: "ACTIVE",
                likedAt: null,
            },
        });

        // Remove OwnedAlbum record if it was from discovery_liked
        await prisma.ownedAlbum.deleteMany({
            where: {
                rgMbid: albumId,
                source: "discovery_liked",
            },
        });

        // Revert plays back to DISCOVERY source
        const tracks = await prisma.discoveryTrack.findMany({
            where: { discoveryAlbumId: discoveryAlbum.id },
            select: { trackId: true },
        });

        const trackIds = tracks
            .map((t) => t.trackId)
            .filter((id): id is string => id !== null);

        if (trackIds.length > 0) {
            await prisma.play.updateMany({
                where: {
                    userId,
                    trackId: { in: trackIds },
                    source: "DISCOVERY_KEPT",
                },
                data: {
                    source: "DISCOVERY",
                },
            });
        }

        res.json({ success: true });
    } catch (error) {
        logger.error("Unlike discovery album error:", error);
        res.status(500).json({ error: "Failed to unlike album" });
    }
});

// POST /discover/retry-unavailable - Retry all unavailable albums from this week
router.post("/retry-unavailable", async (req, res) => {
    try {
        const userId = req.user!.id;

        const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });

        // Check for an active batch already in progress
        const activeBatch = await prisma.discoveryBatch.findFirst({
            where: {
                userId,
                status: { in: ["downloading", "scanning"] },
            },
        });

        if (activeBatch) {
            return res.status(409).json({
                error: "A discovery batch is already in progress",
                batchId: activeBatch.id,
            });
        }

        const unavailableAlbums = await prisma.unavailableAlbum.findMany({
            where: {
                userId,
                weekStartDate: weekStart,
            },
        });

        if (unavailableAlbums.length === 0) {
            return res.json({ success: true, queued: 0, message: "No unavailable albums to retry" });
        }

        // Apply the same filtering used by GET /current to exclude albums that are
        // already in the library. Without this, the retry would re-download albums
        // the user already has, importing duplicate tracks.

        // Filter 1: albums with a successful DiscoveryAlbum record this week
        const successfulDiscovery = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                weekStartDate: weekStart,
                status: { in: ["ACTIVE", "LIKED"] },
            },
            select: { rgMbid: true },
        });
        const successfulMbids = new Set(successfulDiscovery.map((da) => da.rgMbid));

        // Filter 2: albums already present in the library by MBID
        const allMbids = unavailableAlbums.map((a) => a.albumMbid).filter(Boolean);
        const existingByMbid = new Set(
            (await prisma.album.findMany({
                where: { rgMbid: { in: allMbids } },
                select: { rgMbid: true },
            })).map((a) => a.rgMbid)
        );

        // Filter 3: fuzzy title+artist match against the full library
        const libraryAlbums = await prisma.album.findMany({
            select: { title: true, artist: { select: { name: true } } },
        });
        const libraryIndex = libraryAlbums.map((a) => ({
            title: a.title.toLowerCase().trim(),
            artist: a.artist.name.toLowerCase().trim(),
        }));

        const staleIds: string[] = [];
        const retriableAlbums = unavailableAlbums.filter((album) => {
            if (successfulMbids.has(album.albumMbid)) {
                staleIds.push(album.id);
                return false;
            }
            if (existingByMbid.has(album.albumMbid)) {
                staleIds.push(album.id);
                return false;
            }
            const normalizedArtist = album.artistName.toLowerCase().trim();
            const normalizedTitle = album.albumTitle
                .toLowerCase()
                .replace(/\(.*?\)/g, "")
                .replace(/\[.*?\]/g, "")
                .trim();
            const existsInLibrary = libraryIndex.some(
                (lib) =>
                    lib.title.includes(normalizedTitle) &&
                    lib.artist.includes(normalizedArtist)
            );
            if (existsInLibrary) {
                staleIds.push(album.id);
                return false;
            }
            return true;
        });

        // Delete stale UnavailableAlbum records so they don't reappear next retry
        if (staleIds.length > 0) {
            await prisma.unavailableAlbum.deleteMany({ where: { id: { in: staleIds } } });
            logger.info(`[Discover Retry] Cleared ${staleIds.length} stale unavailable records (already in library)`);
        }

        if (retriableAlbums.length === 0) {
            return res.json({ success: true, queued: 0, message: "All unavailable albums are already in your library" });
        }

        const settings = await getSystemSettings();
        if (!settings?.musicPath) {
            return res.status(400).json({ error: "Music path not configured" });
        }

        // Create a new batch for retry tracking
        const batch = await prisma.$transaction(async (tx) => {
            const newBatch = await tx.discoveryBatch.create({
                data: {
                    userId,
                    weekStart,
                    targetSongCount: retriableAlbums.length,
                    status: "downloading",
                    totalAlbums: retriableAlbums.length,
                    completedAlbums: 0,
                    failedAlbums: 0,
                    logs: [
                        {
                            timestamp: new Date().toISOString(),
                            level: "info",
                            message: `Retry: ${retriableAlbums.length} unavailable albums`,
                        },
                    ] as any,
                },
            });

            for (const album of retriableAlbums) {
                await tx.downloadJob.create({
                    data: {
                        userId,
                        subject: `${album.artistName} - ${album.albumTitle}`,
                        type: "album",
                        targetMbid: album.albumMbid,
                        status: "pending",
                        discoveryBatchId: newBatch.id,
                        metadata: {
                            downloadType: "discovery",
                            rootFolderPath: settings.musicPath,
                            artistName: album.artistName,
                            artistMbid: album.artistMbid,
                            albumTitle: album.albumTitle,
                            albumMbid: album.albumMbid,
                            similarity: album.similarity,
                            tier: album.tier,
                            retryOfUnavailable: true,
                        },
                    },
                });
            }

            // Delete unavailable records so they don't block re-evaluation
            await tx.unavailableAlbum.deleteMany({
                where: {
                    userId,
                    weekStartDate: weekStart,
                },
            });

            return newBatch;
        });

        logger.info(`[Discover Retry] Created batch ${batch.id} with ${retriableAlbums.length} albums`);

        res.json({
            success: true,
            queued: retriableAlbums.length,
            batchId: batch.id,
            message: `Retrying ${retriableAlbums.length} unavailable albums`,
        });

        // Process downloads in background using acquisition service
        const { acquisitionService } = await import("../services/acquisitionService");
        const jobs = await prisma.downloadJob.findMany({
            where: { discoveryBatchId: batch.id },
        });

        (async () => {
            let completed = 0;
            let failed = 0;

            for (const job of jobs) {
                const metadata = job.metadata as any;
                try {
                    const result = await acquisitionService.acquireAlbum(
                        {
                            albumTitle: metadata.albumTitle,
                            artistName: metadata.artistName,
                            mbid: metadata.albumMbid,
                        },
                        {
                            userId,
                            discoveryBatchId: batch.id,
                            existingJobId: job.id,
                        }
                    );

                    if (result.success) {
                        completed++;
                    } else {
                        failed++;
                    }
                } catch (error) {
                    logger.error(`[Discover Retry] Error acquiring ${metadata.albumTitle}:`, error);
                    failed++;
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: "failed",
                            error: (error as any)?.message || "Acquisition failed",
                            completedAt: new Date(),
                        },
                    }).catch(() => {});
                }

                await prisma.discoveryBatch.update({
                    where: { id: batch.id },
                    data: {
                        completedAlbums: completed,
                        failedAlbums: failed,
                    },
                }).catch(() => {});
            }

            // Mark batch as scanning, then trigger library scan
            await prisma.discoveryBatch.update({
                where: { id: batch.id },
                data: {
                    status: "scanning",
                    completedAlbums: completed,
                    failedAlbums: failed,
                },
            });

            try {
                await scanQueue.add("scan", {
                    userId,
                    type: "full",
                    source: "discover-retry-unavailable",
                    discoveryBatchId: batch.id,
                });
            } catch (scanError) {
                logger.error("[Discover Retry] Failed to queue scan:", scanError);
            }

            await prisma.discoveryBatch.update({
                where: { id: batch.id },
                data: {
                    status: "completed",
                    completedAt: new Date(),
                },
            });

            logger.info(`[Discover Retry] Batch ${batch.id} complete: ${completed} succeeded, ${failed} failed`);
        })();
    } catch (error) {
        logger.error("Retry unavailable albums error:", error);
        res.status(500).json({ error: "Failed to retry unavailable albums" });
    }
});

// GET /discover/config - Get user's Discover Weekly configuration
router.get("/config", async (req, res) => {
    try {
        const userId = req.user!.id;

        let config = await prisma.userDiscoverConfig.findUnique({
            where: { userId },
        });

        // Create default config if doesn't exist
        if (!config) {
            config = await prisma.userDiscoverConfig.create({
                data: {
                    userId,
                    playlistSize: 10,
                    maxRetryAttempts: 3,
                    exclusionMonths: 6,
                    downloadRatio: 1.3,
                    enabled: true,
                },
            });
        }

        res.json(config);
    } catch (error) {
        logger.error("Get Discover Weekly config error:", error);
        res.status(500).json({ error: "Failed to get configuration" });
    }
});

// PATCH /discover/config - Update user's Discover Weekly configuration
router.patch("/config", async (req, res) => {
    try {
        const userId = req.user!.id;
        const {
            playlistSize,
            maxRetryAttempts,
            exclusionMonths,
            downloadRatio,
            enabled,
        } = req.body;

        // Validate playlist size
        if (playlistSize !== undefined) {
            const size = parseInt(playlistSize, 10);
            if (isNaN(size) || size < 5 || size > 50 || size % 5 !== 0) {
                return res.status(400).json({
                    error: "Invalid playlist size. Must be between 5-50 in increments of 5.",
                });
            }
        }

        // Validate max retry attempts
        if (maxRetryAttempts !== undefined) {
            const retries = parseInt(maxRetryAttempts, 10);
            if (isNaN(retries) || retries < 1 || retries > 10) {
                return res.status(400).json({
                    error: "Invalid retry attempts. Must be between 1-10.",
                });
            }
        }

        // Validate exclusion months
        if (exclusionMonths !== undefined) {
            const months = parseInt(exclusionMonths, 10);
            if (isNaN(months) || months < 0 || months > 12) {
                return res.status(400).json({
                    error: "Invalid exclusion months. Must be between 0-12.",
                });
            }
        }

        // Validate download ratio
        if (downloadRatio !== undefined) {
            const ratio = parseFloat(downloadRatio);
            if (isNaN(ratio) || ratio < 1.0 || ratio > 2.0) {
                return res.status(400).json({
                    error: "Invalid download ratio. Must be between 1.0-2.0.",
                });
            }
        }

        const config = await prisma.userDiscoverConfig.upsert({
            where: { userId },
            create: {
                userId,
                playlistSize: playlistSize ?? 10,
                maxRetryAttempts: maxRetryAttempts ?? 3,
                exclusionMonths: exclusionMonths ?? 6,
                downloadRatio: downloadRatio ?? 1.3,
                enabled: enabled ?? true,
            },
            update: {
                ...(playlistSize !== undefined && {
                    playlistSize: parseInt(playlistSize, 10),
                }),
                ...(maxRetryAttempts !== undefined && {
                    maxRetryAttempts: parseInt(maxRetryAttempts, 10),
                }),
                ...(exclusionMonths !== undefined && {
                    exclusionMonths: parseInt(exclusionMonths, 10),
                }),
                ...(downloadRatio !== undefined && {
                    downloadRatio: parseFloat(downloadRatio),
                }),
                ...(enabled !== undefined && { enabled }),
            },
        });

        res.json(config);
    } catch (error) {
        logger.error("Update Discover Weekly config error:", error);
        res.status(500).json({ error: "Failed to update configuration" });
    }
});

// GET /discover/popular-artists - Get popular artists from Last.fm charts
router.get("/popular-artists", async (req, res) => {
    try {
        const limit = parseInt(req.query.limit as string) || 20;

        const artists = await lastFmService.getTopChartArtists(limit);

        res.json({ artists });
    } catch (error: any) {
        logger.error(
            "[Discover] Get popular artists error:",
            error?.message || error
        );
        // Return empty array instead of 500 - allows homepage to still render
        res.json({ artists: [] });
    }
});

// DELETE /discover/clear - Clear the discovery playlist (move liked to library, delete the rest)
router.delete("/clear", async (req, res) => {
    try {
        const userId = req.user!.id;

        logger.debug(`\n Clearing Discover Weekly playlist for user ${userId}`);

        // Get all discovery albums for this user
        const discoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                status: { in: ["ACTIVE", "LIKED"] },
            },
        });

        if (discoveryAlbums.length === 0) {
            return res.json({
                success: true,
                message: "No discovery albums to clear",
                likedMoved: 0,
                activeDeleted: 0,
            });
        }

        const likedAlbums = discoveryAlbums.filter((a) => a.status === "LIKED");
        const activeAlbums = discoveryAlbums.filter(
            (a) => a.status === "ACTIVE"
        );

        logger.debug(
            `  Found ${likedAlbums.length} liked albums to move to library`
        );
        logger.debug(`  Found ${activeAlbums.length} active albums to delete`);

        // Get system settings for Lidarr
        const settings = await getSystemSettings();

        let likedMoved = 0;
        let activeDeleted = 0;

        // Process liked albums - move to library
        if (likedAlbums.length > 0) {
            logger.debug(`\n[LIBRARY] Moving liked albums to library...`);

            for (const album of likedAlbums) {
                try {
                    // Find the album in the database by matching artist + title
                    const dbAlbum = await prisma.album.findFirst({
                        where: {
                            title: album.albumTitle,
                            artist: { name: album.artistName },
                        },
                        include: { artist: true },
                    });

                    if (dbAlbum) {
                        // Update album location to LIBRARY
                        await prisma.album.update({
                            where: { id: dbAlbum.id },
                            data: { location: "LIBRARY" },
                        });

                        // Create OwnedAlbum record if doesn't exist
                        await prisma.ownedAlbum.upsert({
                            where: {
                                artistId_rgMbid: {
                                    artistId: dbAlbum.artistId,
                                    rgMbid: dbAlbum.rgMbid,
                                },
                            },
                            create: {
                                artistId: dbAlbum.artistId,
                                rgMbid: dbAlbum.rgMbid,
                                source: "discover_liked",
                            },
                            update: {}, // No update needed if exists
                        });

                        // If Lidarr is enabled, move the album files to main library
                        if (
                            settings.lidarrEnabled &&
                            settings.lidarrUrl &&
                            settings.lidarrApiKey &&
                            album.lidarrAlbumId
                        ) {
                            try {
                                // Get album details from Lidarr
                                const albumResponse = await axios.get(
                                    `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                                    {
                                        headers: {
                                            "X-Api-Key": settings.lidarrApiKey,
                                        },
                                        timeout: 10000,
                                    }
                                );

                                const artistId = albumResponse.data.artistId;

                                // Get artist details
                                const artistResponse = await axios.get(
                                    `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                    {
                                        headers: {
                                            "X-Api-Key": settings.lidarrApiKey,
                                        },
                                        timeout: 10000,
                                    }
                                );

                                // Update artist's root folder path to main library if in discovery
                                if (
                                    artistResponse.data.path?.includes(
                                        "/music/discovery"
                                    )
                                ) {
                                    // Move artist to main library path
                                    await axios.put(
                                        `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                        {
                                            ...artistResponse.data,
                                            path: artistResponse.data.path.replace(
                                                "/music/discovery",
                                                "/music"
                                            ),
                                            moveFiles: true,
                                        },
                                        {
                                            headers: {
                                                "X-Api-Key":
                                                    settings.lidarrApiKey,
                                            },
                                            timeout: 30000,
                                        }
                                    );
                                    logger.debug(
                                        `    Moved to library: ${album.artistName} - ${album.albumTitle}`
                                    );
                                }
                            } catch (lidarrError: any) {
                                logger.debug(
                                    `  Lidarr move failed for ${album.albumTitle}: ${lidarrError.message}`
                                );
                            }
                        }

                        likedMoved++;
                    }

                    // Mark as MOVED in discovery database
                    await prisma.discoveryAlbum.update({
                        where: { id: album.id },
                        data: { status: "MOVED" },
                    });
                } catch (error: any) {
                    logger.error(
                        `  ✗ Failed to move ${album.albumTitle}: ${error.message}`
                    );
                }
            }
        }

        // Process active (non-liked) albums - delete them
        if (activeAlbums.length > 0) {
            logger.debug(`\n[CLEANUP] Deleting non-liked albums...`);

            const checkedArtistIds = new Set<number>();

            for (const album of activeAlbums) {
                try {
                    // Remove from Lidarr if enabled
                    if (
                        settings.lidarrEnabled &&
                        settings.lidarrUrl &&
                        settings.lidarrApiKey &&
                        album.lidarrAlbumId
                    ) {
                        try {
                            // Get album details to find artist ID
                            let artistId: number | undefined;
                            try {
                                const albumResponse = await axios.get(
                                    `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                                    {
                                        headers: {
                                            "X-Api-Key": settings.lidarrApiKey,
                                        },
                                        timeout: 10000,
                                    }
                                );
                                artistId = albumResponse.data.artistId;
                            } catch (e: any) {
                                if (e.response?.status !== 404) throw e;
                            }

                            // Delete album from Lidarr
                            await axios.delete(
                                `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                                {
                                    params: { deleteFiles: true },
                                    headers: {
                                        "X-Api-Key": settings.lidarrApiKey,
                                    },
                                    timeout: 10000,
                                }
                            );
                            logger.debug(
                                `    Deleted from Lidarr: ${album.albumTitle}`
                            );

                            // Check if artist should be removed too
                            if (artistId && !checkedArtistIds.has(artistId)) {
                                checkedArtistIds.add(artistId);

                                try {
                                    const artistResponse = await axios.get(
                                        `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                        {
                                            headers: {
                                                "X-Api-Key":
                                                    settings.lidarrApiKey,
                                            },
                                            timeout: 10000,
                                        }
                                    );

                                    const artist = artistResponse.data;
                                    const artistMbid = artist.foreignArtistId;

                                    // Check if artist has any NATIVE library content (real user library)
                                    // This is more reliable than checking Album.location which can be wrong
                                    const hasNativeOwnedAlbums =
                                        await prisma.ownedAlbum.findFirst({
                                            where: {
                                                artist: { mbid: artistMbid },
                                                source: "native_scan",
                                            },
                                        });

                                    // Check if artist has any LIKED/MOVED discovery albums
                                    const hasKeptDiscoveryAlbums =
                                        await prisma.discoveryAlbum.findFirst({
                                            where: {
                                                artistMbid: artistMbid,
                                                status: {
                                                    in: ["LIKED", "MOVED"],
                                                },
                                            },
                                        });

                                    // Only remove artist if they have no native library content and no kept discovery albums
                                    if (
                                        !hasNativeOwnedAlbums &&
                                        !hasKeptDiscoveryAlbums
                                    ) {
                                        await axios.delete(
                                            `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                            {
                                                params: { deleteFiles: true },
                                                headers: {
                                                    "X-Api-Key":
                                                        settings.lidarrApiKey,
                                                },
                                                timeout: 10000,
                                            }
                                        );
                                        logger.debug(
                                            `    Removed artist from Lidarr: ${artist.artistName}`
                                        );
                                    } else {
                                        logger.debug(
                                            `    Keeping artist in Lidarr: ${artist.artistName} (has library or kept albums)`
                                        );
                                    }
                                } catch (e: any) {
                                    // Artist might have other albums
                                }
                            }
                        } catch (lidarrError: any) {
                            if (lidarrError.response?.status !== 404) {
                                logger.debug(
                                    `  Lidarr delete failed for ${album.albumTitle}: ${lidarrError.message}`
                                );
                            }
                        }
                    }

                    // FALLBACK: Direct filesystem deletion (in case Lidarr's deleteFiles didn't work)
                    // Try to delete files directly from the discovery folder
                    try {
                        const discoveryPath = path.join(
                            config.music.musicPath,
                            "discovery"
                        );
                        // Try common folder structures: /discovery/Artist/Album or /discovery/Artist - Album
                        const possiblePaths = [
                            path.join(
                                discoveryPath,
                                album.artistName,
                                album.albumTitle
                            ),
                            path.join(discoveryPath, album.artistName),
                            path.join(
                                discoveryPath,
                                `${album.artistName} - ${album.albumTitle}`
                            ),
                        ];

                        for (const albumPath of possiblePaths) {
                            if (fs.existsSync(albumPath)) {
                                fs.rmSync(albumPath, {
                                    recursive: true,
                                    force: true,
                                });
                                logger.debug(`    Direct deleted: ${albumPath}`);
                                break; // Stop after first successful delete
                            }
                        }
                    } catch (fsError: any) {
                        logger.debug(
                            `    Filesystem delete failed for ${album.albumTitle}: ${fsError.message}`
                        );
                    }

                    // Delete DiscoveryTrack records first (foreign key to Track)
                    await prisma.discoveryTrack.deleteMany({
                        where: { discoveryAlbumId: album.id },
                    });

                    // Remove from local database
                    const dbAlbum = await prisma.album.findFirst({
                        where: {
                            title: album.albumTitle,
                            artist: { name: album.artistName },
                            location: "DISCOVER",
                        },
                        include: { tracks: true },
                    });

                    if (dbAlbum) {
                        // Delete tracks first
                        await prisma.track.deleteMany({
                            where: { albumId: dbAlbum.id },
                        });

                        // Delete album
                        await prisma.album.delete({
                            where: { id: dbAlbum.id },
                        });
                    }

                    // Mark as DELETED in discovery database
                    await prisma.discoveryAlbum.update({
                        where: { id: album.id },
                        data: { status: "DELETED" },
                    });

                    activeDeleted++;
                } catch (error: any) {
                    logger.error(
                        `  ✗ Failed to delete ${album.albumTitle}: ${error.message}`
                    );
                }
            }
        }

        // ALSO clean up "extra" downloaded albums that didn't make the final playlist
        // These are in DownloadJob but not in DiscoveryAlbum
        // IMPORTANT: Skip any albums where the artist has LIKED content (even if MBID doesn't match)
        if (
            settings.lidarrEnabled &&
            settings.lidarrUrl &&
            settings.lidarrApiKey
        ) {
            const completedJobs = await prisma.downloadJob.findMany({
                where: {
                    userId,
                    discoveryBatchId: { not: null },
                    status: "completed",
                },
            });

            // Get all DiscoveryAlbum for this user (including ones we just processed)
            const allDiscoveryAlbums = await prisma.discoveryAlbum.findMany({
                where: { userId },
                select: {
                    rgMbid: true,
                    artistName: true,
                    albumTitle: true,
                    status: true,
                },
            });
            const discoveryMbids = new Set(
                allDiscoveryAlbums.map((da) => da.rgMbid)
            );

            // Build a set of liked artist names (case-insensitive) for extra protection
            const likedArtistNames = new Set(
                allDiscoveryAlbums
                    .filter(
                        (da) => da.status === "LIKED" || da.status === "MOVED"
                    )
                    .map((da) => da.artistName.toLowerCase())
            );

            // Find completed jobs that didn't make the playlist AND aren't from liked artists
            const extraJobs = completedJobs.filter((job) => {
                // If MBID matches a discovery album, not an "extra"
                if (discoveryMbids.has(job.targetMbid!)) return false;

                // If this job's artist has any LIKED albums, don't clean it up
                const metadata = job.metadata as any;
                const artistName = metadata?.artistName?.toLowerCase();
                if (artistName && likedArtistNames.has(artistName)) {
                    logger.debug(
                        `    Skipping ${metadata?.albumTitle} - artist ${metadata?.artistName} has liked albums`
                    );
                    return false;
                }

                return true;
            });

            if (extraJobs.length > 0) {
                logger.debug(
                    `\n[CLEANUP] Found ${extraJobs.length} extra albums to clean from Lidarr...`
                );

                for (const job of extraJobs) {
                    const metadata = job.metadata as any;
                    const albumTitle = metadata?.albumTitle || job.subject;
                    const artistName = metadata?.artistName;

                    // Double-check: also check by artist name + album title for LIKED status
                    const isLikedByName = await prisma.discoveryAlbum.findFirst(
                        {
                            where: {
                                userId,
                                artistName: {
                                    equals: artistName,
                                    mode: "insensitive",
                                },
                                albumTitle: {
                                    equals: albumTitle,
                                    mode: "insensitive",
                                },
                                status: { in: ["LIKED", "MOVED"] },
                            },
                        }
                    );

                    if (isLikedByName) {
                        logger.debug(
                            `    Skipping ${albumTitle} - marked as LIKED`
                        );
                        continue;
                    }

                    if (job.lidarrAlbumId) {
                        try {
                            // Get artist ID before deleting album
                            let artistId: number | undefined;
                            try {
                                const albumResponse = await axios.get(
                                    `${settings.lidarrUrl}/api/v1/album/${job.lidarrAlbumId}`,
                                    {
                                        headers: {
                                            "X-Api-Key": settings.lidarrApiKey,
                                        },
                                        timeout: 10000,
                                    }
                                );
                                artistId = albumResponse.data.artistId;
                            } catch (e) {
                                // Album might not exist
                            }

                            // Delete album from Lidarr
                            await axios.delete(
                                `${settings.lidarrUrl}/api/v1/album/${job.lidarrAlbumId}`,
                                {
                                    params: { deleteFiles: true },
                                    headers: {
                                        "X-Api-Key": settings.lidarrApiKey,
                                    },
                                    timeout: 10000,
                                }
                            );
                            logger.debug(
                                `    Cleaned up extra album: ${albumTitle}`
                            );

                            // Check if artist should be removed too
                            if (artistId) {
                                // Check if artist has any liked albums by NAME (more reliable than MBID)
                                const hasLikedByArtistName =
                                    await prisma.discoveryAlbum.findFirst({
                                        where: {
                                            artistName: {
                                                equals: artistName,
                                                mode: "insensitive",
                                            },
                                            status: { in: ["LIKED", "MOVED"] },
                                        },
                                    });

                                if (hasLikedByArtistName) {
                                    logger.debug(
                                        `    Keeping artist: ${artistName} (has liked albums)`
                                    );
                                    continue;
                                }

                                const artistMbid = metadata?.artistMbid;
                                if (
                                    artistMbid &&
                                    !artistMbid.startsWith("temp-")
                                ) {
                                    // Check if artist has native library content
                                    const hasNativeLibrary =
                                        await prisma.ownedAlbum.findFirst({
                                            where: {
                                                artist: { mbid: artistMbid },
                                                source: "native_scan",
                                            },
                                        });

                                    if (!hasNativeLibrary) {
                                        try {
                                            await axios.delete(
                                                `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                                {
                                                    params: {
                                                        deleteFiles: true,
                                                    },
                                                    headers: {
                                                        "X-Api-Key":
                                                            settings.lidarrApiKey,
                                                    },
                                                    timeout: 10000,
                                                }
                                            );
                                            logger.debug(
                                                `    Removed extra artist from Lidarr: ${artistName}`
                                            );
                                        } catch (e) {
                                            // Artist might have other albums
                                        }
                                    }
                                }
                            }
                        } catch (e: any) {
                            // Ignore - might already be removed
                            if (e.response?.status !== 404) {
                                logger.debug(
                                    `    Failed to clean up ${albumTitle}: ${e.message}`
                                );
                            }
                        }
                    }
                }
            }
        }

        // Clean up unavailable albums for this user
        await prisma.unavailableAlbum.deleteMany({
            where: { userId },
        });

        // === PHASE 1.5: Clean up failed artists from Lidarr ===
        // Get all failed download jobs for this user and remove their artists from Lidarr
        if (
            settings.lidarrEnabled &&
            settings.lidarrUrl &&
            settings.lidarrApiKey
        ) {
            logger.debug(
                `\n[CLEANUP] Checking for failed artists to remove from Lidarr...`
            );

            const failedJobs = await prisma.downloadJob.findMany({
                where: {
                    userId,
                    status: "failed",
                    discoveryBatchId: { not: null },
                },
            });

            // Group by artist
            const failedArtistMbids = new Set<string>();
            const artistNames = new Map<string, string>();

            for (const job of failedJobs) {
                const metadata = job.metadata as any;
                if (metadata?.artistMbid) {
                    failedArtistMbids.add(metadata.artistMbid);
                    artistNames.set(
                        metadata.artistMbid,
                        metadata.artistName || "Unknown"
                    );
                }
            }

            // Remove failed artists that don't have native library content
            for (const artistMbid of failedArtistMbids) {
                try {
                    // Check if artist has any NATIVE library content (real user library)
                    const hasNativeOwnedAlbums =
                        await prisma.ownedAlbum.findFirst({
                            where: {
                                artist: { mbid: artistMbid },
                                source: "native_scan",
                            },
                        });

                    if (hasNativeOwnedAlbums) {
                        logger.debug(
                            `   Keeping ${artistNames.get(
                                artistMbid
                            )} - has native library content`
                        );
                        continue;
                    }

                    // Check if artist has any LIKED discovery albums
                    const hasLikedDiscovery =
                        await prisma.discoveryAlbum.findFirst({
                            where: {
                                artistMbid,
                                status: { in: ["LIKED", "MOVED"] },
                            },
                        });

                    if (hasLikedDiscovery) {
                        logger.debug(
                            `   Keeping ${artistNames.get(
                                artistMbid
                            )} - has liked discovery albums`
                        );
                        continue;
                    }

                    // Find and remove from Lidarr
                    const searchResponse = await axios.get(
                        `${settings.lidarrUrl}/api/v1/artist`,
                        {
                            headers: { "X-Api-Key": settings.lidarrApiKey },
                            timeout: 10000,
                        }
                    );

                    const lidarrArtist = searchResponse.data.find(
                        (a: any) => a.foreignArtistId === artistMbid
                    );

                    if (lidarrArtist) {
                        await axios.delete(
                            `${settings.lidarrUrl}/api/v1/artist/${lidarrArtist.id}`,
                            {
                                params: { deleteFiles: true },
                                headers: { "X-Api-Key": settings.lidarrApiKey },
                                timeout: 10000,
                            }
                        );
                        logger.debug(
                            ` Removed failed artist from Lidarr: ${artistNames.get(
                                artistMbid
                            )}`
                        );
                    }
                } catch (e: any) {
                    // Ignore errors - artist might already be removed
                }
            }

            // DON'T delete download jobs immediately - scanner needs them to identify discovery albums
            // They will be cleaned up by the data integrity worker after 30 days
            // Only delete FAILED jobs (they won't help with matching anyway)
            await prisma.downloadJob.deleteMany({
                where: {
                    userId,
                    discoveryBatchId: { not: null },
                    status: "failed",
                },
            });
        }

        // === PHASE 2: Clean up orphaned discovery records ===
        // These are Album/Track records with location="DISCOVER" that weren't linked to a DiscoveryAlbum
        // This can happen if downloads failed or playlist build failed
        logger.debug(`\n Cleaning up orphaned discovery records...`);

        // Find all DISCOVER albums that don't have a corresponding DiscoveryAlbum record
        const orphanedAlbums = await prisma.album.findMany({
            where: {
                location: "DISCOVER",
            },
            include: { artist: true, tracks: true },
        });

        let orphanedAlbumsDeleted = 0;
        for (const orphanAlbum of orphanedAlbums) {
            // Check if there's a DiscoveryAlbum record for this
            // Include MOVED status because liked albums are marked MOVED during clear
            const hasDiscoveryRecord = await prisma.discoveryAlbum.findFirst({
                where: {
                    OR: [
                        { rgMbid: orphanAlbum.rgMbid },
                        {
                            albumTitle: orphanAlbum.title,
                            artistName: orphanAlbum.artist.name,
                        },
                    ],
                    status: { in: ["ACTIVE", "LIKED", "MOVED"] }, // Keep if active, liked, or moved to library
                },
            });

            // Also check if there's an OwnedAlbum record (user liked it)
            const hasOwnedRecord = await prisma.ownedAlbum.findFirst({
                where: {
                    rgMbid: orphanAlbum.rgMbid,
                },
            });

            if (!hasDiscoveryRecord && !hasOwnedRecord) {
                // Delete tracks first
                await prisma.track.deleteMany({
                    where: { albumId: orphanAlbum.id },
                });
                // Delete album
                await prisma.album.delete({
                    where: { id: orphanAlbum.id },
                });
                orphanedAlbumsDeleted++;
                logger.debug(
                    `    Deleted orphaned album: ${orphanAlbum.artist.name} - ${orphanAlbum.title}`
                );
            }
        }

        if (orphanedAlbumsDeleted > 0) {
            logger.debug(
                `  Cleaned up ${orphanedAlbumsDeleted} orphaned discovery albums`
            );
        }

        // Clean up orphaned artists (artists with no albums)
        const orphanedArtists = await prisma.artist.findMany({
            where: {
                albums: { none: {} },
            },
        });

        if (orphanedArtists.length > 0) {
            const orphanIds = orphanedArtists.map((a) => a.id);

            // Delete artist relations first (SimilarArtist records)
            // Note: SimilarArtist uses fromArtistId/toArtistId field names
            await prisma.similarArtist.deleteMany({
                where: {
                    OR: [
                        { fromArtistId: { in: orphanIds } },
                        { toArtistId: { in: orphanIds } },
                    ],
                },
            });

            await prisma.artist.deleteMany({
                where: { id: { in: orphanIds } },
            });
            logger.debug(
                `  Cleaned up ${orphanedArtists.length} orphaned artists`
            );
        }

        // Clean up orphaned DiscoveryTrack records (tracks whose album was deleted)
        const orphanedDiscoveryTracks = await prisma.discoveryTrack.deleteMany({
            where: {
                trackId: null, // Track was deleted but DiscoveryTrack record remains
            },
        });

        if (orphanedDiscoveryTracks.count > 0) {
            logger.debug(
                `  Cleaned up ${orphanedDiscoveryTracks.count} orphaned discovery track records`
            );
        }

        // Clean up old DiscoveryAlbum records that are DELETED or MOVED (older than 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const oldDiscoveryAlbums = await prisma.discoveryAlbum.deleteMany({
            where: {
                userId,
                status: { in: ["DELETED", "MOVED"] },
                downloadedAt: { lt: thirtyDaysAgo },
            },
        });

        if (oldDiscoveryAlbums.count > 0) {
            logger.debug(
                `  Cleaned up ${oldDiscoveryAlbums.count} old discovery album records`
            );
        }

        // === PHASE 3: Tag-based Lidarr cleanup ===
        // Only remove artists that have the "lidify-discovery" tag
        // This is the ONLY reliable way to identify discovery artists
        // User's pre-existing library is NEVER touched (no tag = safe)
        let lidarrArtistsRemoved = 0;
        if (
            settings.lidarrEnabled &&
            settings.lidarrUrl &&
            settings.lidarrApiKey
        ) {
            logger.debug(
                `\n[LIDARR CLEANUP] Tag-based cleanup (lidify-discovery tag)...`
            );

            try {
                // Get all artists with the discovery tag
                const discoveryArtists =
                    await lidarrService.getDiscoveryArtists();
                logger.debug(
                    `   Found ${discoveryArtists.length} artists with discovery tag`
                );

                for (const lidarrArtist of discoveryArtists) {
                    const artistMbid = lidarrArtist.foreignArtistId;
                    const artistName = lidarrArtist.artistName;

                    if (!artistMbid) continue;

                    // Double-check: if artist has LIKED albums, remove tag but don't delete
                    // (This is a safety net - the like endpoint should have already removed the tag)
                    const hasKeptDiscovery =
                        await prisma.discoveryAlbum.findFirst({
                            where: {
                                artistMbid: artistMbid,
                                status: { in: ["LIKED", "MOVED"] },
                            },
                        });

                    if (hasKeptDiscovery) {
                        // Remove the tag but keep the artist
                        logger.debug(
                            `   Keeping ${artistName} - has liked albums (removing tag)`
                        );
                        await lidarrService.removeDiscoveryTagByMbid(
                            artistMbid
                        );
                        continue;
                    }

                    // Artist has discovery tag AND no liked albums = safe to delete
                    try {
                        const result = await lidarrService.deleteArtistById(
                            lidarrArtist.id,
                            true
                        );
                        if (result.success) {
                            lidarrArtistsRemoved++;
                            logger.debug(` Removed: ${artistName}`);
                        }
                    } catch (deleteError: any) {
                        logger.debug(
                            ` Failed to remove ${artistName}: ${deleteError.message}`
                        );
                    }
                }

                logger.debug(
                    `   Tag-based cleanup complete: ${lidarrArtistsRemoved} artists removed`
                );
            } catch (lidarrError: any) {
                logger.debug(`   Lidarr cleanup failed: ${lidarrError.message}`);
            }
        }

        // === PHASE 4: Trigger library scan to sync database with filesystem ===
        logger.debug(`\n[SCAN] Triggering library scan to sync database...`);
        try {
            await scanQueue.add("scan", {
                userId,
                musicPath: config.music.musicPath,
            });
            logger.debug(`   Library scan queued successfully`);
        } catch (scanError: any) {
            logger.debug(`   Library scan queue failed: ${scanError.message}`);
            // Non-fatal - continue with response
        }

        logger.debug(
            `\nClear complete: ${likedMoved} moved to library, ${activeDeleted} deleted, ${orphanedAlbumsDeleted} orphans cleaned, ${lidarrArtistsRemoved} Lidarr artists removed`
        );

        res.json({
            success: true,
            message: "Discovery playlist cleared",
            likedMoved,
            activeDeleted,
            orphanedAlbumsDeleted,
            lidarrArtistsRemoved,
        });
    } catch (error: any) {
        logger.error(
            "Clear discovery playlist error:",
            error?.message || error
        );
        logger.error("Stack:", error?.stack);
        res.status(500).json({
            error: "Failed to clear discovery playlist",
            details: error?.message || "Unknown error",
        });
    }
});

// GET /discover/exclusions - Get all exclusions for current user
router.get("/exclusions", async (req, res) => {
    try {
        const userId = req.user!.id;

        const exclusions = await prisma.discoverExclusion.findMany({
            where: {
                userId,
                expiresAt: { gt: new Date() }, // Only active exclusions
            },
            orderBy: { lastSuggestedAt: "desc" },
        });

        // Return exclusions with names
        const mapped = exclusions.map((exc) => ({
            id: exc.id,
            albumMbid: exc.albumMbid,
            artistName: exc.artistName || "Unknown Artist",
            albumTitle: exc.albumTitle || exc.albumMbid.slice(0, 8) + "...",
            lastSuggestedAt: exc.lastSuggestedAt,
            expiresAt: exc.expiresAt,
        }));

        res.json({
            exclusions: mapped,
            count: exclusions.length,
        });
    } catch (error: any) {
        logger.error("Get exclusions error:", error?.message || error);
        logger.error("Stack:", error?.stack);
        res.status(500).json({
            error: "Failed to get exclusions",
            details: error?.message,
        });
    }
});

// DELETE /discover/exclusions - Clear all exclusions for current user
router.delete("/exclusions", async (req, res) => {
    try {
        const userId = req.user!.id;

        const result = await prisma.discoverExclusion.deleteMany({
            where: { userId },
        });

        logger.debug(
            `[Discovery] Cleared ${result.count} exclusions for user ${userId}`
        );

        res.json({
            success: true,
            message: `Cleared ${result.count} exclusions`,
            clearedCount: result.count,
        });
    } catch (error) {
        logger.error("Clear exclusions error:", error);
        res.status(500).json({ error: "Failed to clear exclusions" });
    }
});

// DELETE /discover/exclusions/:id - Remove a specific exclusion
router.delete("/exclusions/:id", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { id } = req.params;

        const exclusion = await prisma.discoverExclusion.findFirst({
            where: { id, userId },
        });

        if (!exclusion) {
            return res.status(404).json({ error: "Exclusion not found" });
        }

        await prisma.discoverExclusion.delete({
            where: { id },
        });

        res.json({
            success: true,
            message: "Exclusion removed",
        });
    } catch (error) {
        logger.error("Remove exclusion error:", error);
        res.status(500).json({ error: "Failed to remove exclusion" });
    }
});

// POST /discover/cleanup-lidarr - Remove discovery-only artists from Lidarr
// This cleans up artists that were added for discovery but shouldn't remain
router.post("/cleanup-lidarr", async (req, res) => {
    try {
        logger.debug(
            "\n[CLEANUP] Starting Lidarr cleanup of discovery-only artists..."
        );

        const settings = await getSystemSettings();

        if (
            !settings.lidarrEnabled ||
            !settings.lidarrUrl ||
            !settings.lidarrApiKey
        ) {
            return res.status(400).json({ error: "Lidarr not configured" });
        }

        // Get all artists from Lidarr
        const lidarrResponse = await axios.get(
            `${settings.lidarrUrl}/api/v1/artist`,
            {
                headers: { "X-Api-Key": settings.lidarrApiKey },
                timeout: 30000,
            }
        );

        const lidarrArtists = lidarrResponse.data;
        logger.debug(
            `[CLEANUP] Found ${lidarrArtists.length} artists in Lidarr`
        );

        const artistsRemoved: string[] = [];
        const artistsKept: string[] = [];
        const errors: string[] = [];

        // Batch fetch all artist MBIDs that have native owned albums
        const nativeOwnedArtistMbids = new Set(
            (await prisma.ownedAlbum.findMany({
                where: { source: "native_scan" },
                select: { artist: { select: { mbid: true } } },
                distinct: ["artistId"],
            })).map((oa) => oa.artist.mbid).filter(Boolean)
        );

        // Batch fetch all artist MBIDs that have LIKED/MOVED discovery albums
        const keptDiscoveryArtistMbids = new Set(
            (await prisma.discoveryAlbum.findMany({
                where: { status: { in: ["LIKED", "MOVED"] } },
                select: { artistMbid: true },
                distinct: ["artistMbid"],
            })).map((da) => da.artistMbid)
        );

        // Batch fetch all artist MBIDs that have ACTIVE discovery albums
        const activeDiscoveryArtistMbids = new Set(
            (await prisma.discoveryAlbum.findMany({
                where: { status: "ACTIVE" },
                select: { artistMbid: true },
                distinct: ["artistMbid"],
            })).map((da) => da.artistMbid)
        );

        for (const lidarrArtist of lidarrArtists) {
            const artistMbid = lidarrArtist.foreignArtistId;
            const artistName = lidarrArtist.artistName;

            if (!artistMbid) continue;

            try {
                const hasNativeOwnedAlbums = nativeOwnedArtistMbids.has(artistMbid);
                const hasKeptDiscoveryAlbums = keptDiscoveryArtistMbids.has(artistMbid);
                const hasActiveDiscoveryAlbums = activeDiscoveryArtistMbids.has(artistMbid);

                if (hasNativeOwnedAlbums || hasKeptDiscoveryAlbums) {
                    artistsKept.push(
                        `${artistName} (has native library or kept albums)`
                    );
                    continue;
                }

                if (hasActiveDiscoveryAlbums) {
                    artistsKept.push(`${artistName} (has active discovery)`);
                    continue;
                }

                // This artist has no library albums and no active/kept discovery albums
                // They should be removed from Lidarr
                logger.debug(
                    `[CLEANUP] Removing discovery-only artist: ${artistName}`
                );

                await axios.delete(
                    `${settings.lidarrUrl}/api/v1/artist/${lidarrArtist.id}`,
                    {
                        params: { deleteFiles: true },
                        headers: { "X-Api-Key": settings.lidarrApiKey },
                        timeout: 30000,
                    }
                );

                artistsRemoved.push(artistName);
                logger.debug(`[CLEANUP] Removed: ${artistName}`);
            } catch (error: any) {
                const msg = `Failed to process ${artistName}: ${error.message}`;
                errors.push(msg);
                logger.error(`[CLEANUP] ${msg}`);
            }
        }

        logger.debug(`\n[CLEANUP] Complete:`);
        logger.debug(`   - Removed: ${artistsRemoved.length}`);
        logger.debug(`   - Kept: ${artistsKept.length}`);
        logger.debug(`   - Errors: ${errors.length}`);

        res.json({
            success: true,
            removed: artistsRemoved,
            kept: artistsKept,
            errors,
            summary: {
                removed: artistsRemoved.length,
                kept: artistsKept.length,
                errors: errors.length,
            },
        });
    } catch (error: any) {
        logger.error(
            "[CLEANUP] Lidarr cleanup error:",
            error?.message || error
        );
        res.status(500).json({
            error: "Failed to cleanup Lidarr",
            details: error?.message || "Unknown error",
        });
    }
});

// POST /discover/fix-tagging - Fix albums incorrectly tagged as LIBRARY that should be DISCOVER
// This repairs existing bad data caused by scanner timing issues
// IMPORTANT: Does NOT touch albums that user has LIKED (discovery_liked) or native library
router.post("/fix-tagging", async (req, res) => {
    try {
        logger.debug("\n[FIX-TAGGING] Starting album tagging repair...");

        // Get all discovery artists (from DiscoveryAlbum records)
        const discoveryArtists = await prisma.discoveryAlbum.findMany({
            distinct: ["artistMbid"],
            select: { artistMbid: true, artistName: true },
        });

        logger.debug(
            `[FIX-TAGGING] Found ${discoveryArtists.length} artists with discovery records`
        );

        let albumsFixed = 0;
        let ownedRecordsRemoved = 0;
        const fixedArtists: string[] = [];

        for (const da of discoveryArtists) {
            if (!da.artistMbid) continue;

            // Check if artist has ANY protected content:
            // 1. native_scan = real user library from before discovery
            // 2. discovery_liked = user liked a discovery album (should be kept!)
            const hasProtectedContent = await prisma.ownedAlbum.findFirst({
                where: {
                    artist: { mbid: da.artistMbid },
                    source: { in: ["native_scan", "discovery_liked"] },
                },
            });

            if (hasProtectedContent) {
                // Artist has protected content - don't touch their albums
                logger.debug(
                    `[FIX-TAGGING] Skipping ${da.artistName} - has protected content (${hasProtectedContent.source})`
                );
                continue;
            }

            // Also check if artist has any LIKED discovery albums (double-check)
            const hasLikedDiscovery = await prisma.discoveryAlbum.findFirst({
                where: {
                    artistMbid: da.artistMbid,
                    status: { in: ["LIKED", "MOVED"] },
                },
            });

            if (hasLikedDiscovery) {
                // User liked albums from this artist - don't touch
                logger.debug(
                    `[FIX-TAGGING] Skipping ${da.artistName} - has LIKED discovery albums`
                );
                continue;
            }

            // This artist has NO protected content - they're purely an ACTIVE discovery artist
            // Fix any of their albums that are incorrectly tagged as LIBRARY
            const mistaggedAlbums = await prisma.album.findMany({
                where: {
                    artist: { mbid: da.artistMbid },
                    location: "LIBRARY",
                },
            });

            if (mistaggedAlbums.length > 0) {
                // Update all these albums to DISCOVER
                const updated = await prisma.album.updateMany({
                    where: {
                        artist: { mbid: da.artistMbid },
                        location: "LIBRARY",
                    },
                    data: { location: "DISCOVER" },
                });

                // Remove incorrect OwnedAlbum records (but not protected ones)
                const removed = await prisma.ownedAlbum.deleteMany({
                    where: {
                        artist: { mbid: da.artistMbid },
                        source: { notIn: ["native_scan", "discovery_liked"] },
                    },
                });

                albumsFixed += updated.count;
                ownedRecordsRemoved += removed.count;
                fixedArtists.push(da.artistName);

                logger.debug(
                    `[FIX-TAGGING] Fixed ${updated.count} albums for ${da.artistName}`
                );
            }
        }

        logger.debug(
            `[FIX-TAGGING] Complete: ${albumsFixed} albums fixed, ${ownedRecordsRemoved} OwnedAlbum records removed`
        );

        res.json({
            success: true,
            albumsFixed,
            ownedRecordsRemoved,
            fixedArtists,
        });
    } catch (error: any) {
        logger.error("[FIX-TAGGING] Error:", error?.message || error);
        res.status(500).json({
            error: "Failed to fix album tagging",
            details: error?.message || "Unknown error",
        });
    }
});

export default router;
