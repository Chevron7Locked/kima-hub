import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken, requireAdmin, requireAcquirePermission } from "../middleware/auth";
import { prisma } from "../utils/db";
import { listenBrainzService } from "../services/listenBrainz";
import { startOfWeek, endOfWeek } from "date-fns";
import { resolveViewWeek, resolveGenerationWeekStart, weekStartKey, weekBoundaryIso } from "../lib/discoveryWeek";
import { isLidarrConfigured } from "../services/lidarrClient";

import { discoverQueue } from "../workers/queues";
import { requestScan } from "../workers/scanRequest";
import { getSystemSettings } from "../utils/systemSettings";
import { lidarrService } from "../services/lidarr";
import { discoveryArtistVerdict, removeDiscoveryArtist } from "../services/discovery/lidarrRemoval";
import { createDiscoveryDownloadJob } from "../services/discovery/discoveryDownloadJob";
import { discoveryAlbumLifecycle, returnToDiscover, takeIntoLibrary } from "../services/discovery/discoveryAlbumLifecycle";
import {
  clearOrphanedDiscoverAlbums,
  clearSuggestion,
  clearUnsuggestedDownloads,
  errorReason,
  reportOrphanFailures,
  findScannedAlbum,
  reportLidarrFailures,
  type ClearFailure,
} from "../services/discovery/discoverClearing";
import { relocateDiscoverAlbums } from "../services/discovery/discoverEvidence";
import {
  UserFacingError,
  IntegrationError,
  ConfigurationError,
} from '../utils/errors';
import { distributedLock } from '../utils/distributedLock';
import { withArtistArtwork } from "../services/artwork";

const router = Router();

router.use(requireAuthOrToken);

router.get("/batch-status", async (req, res) => {
    try {
        const userId = req.user!.id;

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
            const latestTerminal = await prisma.discoveryBatch.findFirst({
                where: { userId, status: { in: ["completed", "failed"] } },
                // completedAt has no DB-level NOT NULL; a terminal batch missing
                // it would sort NULLS LAST under Postgres desc and be skipped.
                // Fall back to createdAt so it still ranks by creation time.
                orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
                select: { id: true, status: true },
            });
            return res.json({
                active: false,
                status: null,
                progress: null,
                lastBatchId: latestTerminal?.id ?? null,
                lastBatchStatus: latestTerminal?.status ?? null,
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

router.delete("/batch", async (req, res) => {
    try {
        const userId = req.user!.id;

        logger.info(`[Discover Cancel] Starting cancellation for user ${userId}`);

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

            // A cancelled batch produced no playlist -- it must not read as a
            // successful empty week to the /current fallback.
            await prisma.discoveryBatch.update({
                where: { id: batch.id },
                data: {
                    status: "failed",
                    completedAt: new Date(),
                    errorMessage: "Cancelled by user",
                },
            });
            batchesCancelled++;
            logger.info(`[Discover Cancel] Marked batch ${batch.id} as failed`);
        }

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

router.post("/generate", requireAcquirePermission, async (req, res) => {
    try {
        const userId = req.user!.id;

        // Use distributed lock to prevent race condition between check and queue
        const result = await distributedLock.withLock(
            `discover:generate:${userId}`,
            30000,
            async () => {
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

                logger.debug(`\nQueuing Discover Weekly generation for user ${userId}`);

                const weekKey = weekStartKey(resolveGenerationWeekStart(new Date(), 1));
                const jobId = `discover-weekly-${userId}-${weekKey}`;
                const existing = await discoverQueue.getJob(jobId);
                if (existing) {
                    const state = await existing.getState();
                    if (state === "completed" || state === "failed") {
                        await existing.remove();
                    }
                }
                const job = await discoverQueue.add("discover-weekly", { userId }, { jobId });

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


        if (error instanceof IntegrationError) {
            logger.error(`Integration error (${error.integration}):`, error);
            return res.status(503).json({
                error: `${error.integration} is currently unavailable. Please try again later.`,
                code: 'INTEGRATION_ERROR',
            });
        }

        logger.error('Unexpected error in discovery generation:', error);
        return res.status(500).json({
            error: 'An unexpected error occurred',
            code: 'INTERNAL_ERROR',
        });
    }
});

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

router.get("/current", async (req, res) => {
    try {
        const userId = req.user!.id;

        const calendarWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
        const latestBatch = await prisma.discoveryBatch.findFirst({
            where: { userId, status: "completed" },
            orderBy: { createdAt: "desc" },
            select: { weekStart: true },
        });
        const view = resolveViewWeek(calendarWeekStart, latestBatch?.weekStart ?? null);
        const weekStart = view.weekStart;
        const weekEnd = endOfWeek(view.weekOf, { weekStartsOn: 1 });

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

        const tracks = [];

        for (const discoveryAlbum of discoveryAlbums) {
            if (discoveryAlbum.tracks && discoveryAlbum.tracks.length > 0) {
                const trackIds = discoveryAlbum.tracks
                    .map((dt) => dt.trackId)
                    .filter((id): id is string => id !== null);

                if (trackIds.length > 0) {
                    const libraryTracks = await prisma.track.findMany({
                        where: { id: { in: trackIds } },
                        include: { album: { include: { artist: true } } },
                    });

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
                        // A liked suggestion's album is in the library now; any other's is a Discover album, never
                        // a library album of the same name.
                        ...(discoveryAlbum.status === "LIKED" ? {} : { location: "DISCOVER" as const }),
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

        const successfulMbids = new Set(discoveryAlbums.map((da) => da.rgMbid));

        // Filter unavailable albums:
        // 1. Remove albums that successfully downloaded (have DiscoveryAlbum record)
        // 2. Remove albums that the user now owns (in Album table)

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

            if (existingByMbid.has(album.albumMbid)) {
                continue;
            }

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
            weekStart: weekBoundaryIso(view.weekOf),
            weekEnd: weekBoundaryIso(weekEnd),
            stale: view.stale,
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

// Likes a track, which marks its whole album to keep.
router.post("/like", async (req, res) => {
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
                status: "ACTIVE",
            },
        });

        if (!discoveryAlbum) {
            return res
                .status(404)
                .json({ error: "Album not in active discovery" });
        }

        // Claim only an ACTIVE row; count 0 means cleanup claimed it first and its
        // files are being removed (409).
        const claimed = await prisma.discoveryAlbum.updateMany({
            where: { id: discoveryAlbum.id, status: "ACTIVE" },
            data: {
                status: "LIKED",
                likedAt: new Date(),
            },
        });
        if (claimed.count === 0) {
            return res.status(409).json({
                error: "This album was just removed and can no longer be kept",
                code: "ALBUM_GONE",
            });
        }

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

        const dbAlbum = await findScannedAlbum(discoveryAlbum, "DISCOVER");

        if (dbAlbum) {
            await takeIntoLibrary(dbAlbum);
            logger.debug(
                `Added liked album to library: ${dbAlbum.artist.name} - ${dbAlbum.title} (matched from discovery)`
            );
        } else {
            logger.debug(
                `   [WARN] Could not find scanned album for: ${discoveryAlbum.artistName} - ${discoveryAlbum.albumTitle}`
            );
        }

        // Retroactively mark all plays from this album as DISCOVERY_KEPT
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

        await prisma.discoveryAlbum.update({
            where: { id: discoveryAlbum.id },
            data: {
                status: "ACTIVE",
                likedAt: null,
            },
        });

        // Back to Discover with the ownership the like gave it, unless another listener's like still keeps it.
        const dbAlbum = await findScannedAlbum(discoveryAlbum, "LIBRARY");
        if (dbAlbum) await returnToDiscover(dbAlbum, albumId);

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

router.post("/retry-unavailable", requireAcquirePermission, async (req, res) => {
    try {
        const userId = req.user!.id;

        const calendarWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
        const latestBatch = await prisma.discoveryBatch.findFirst({
            where: { userId, status: "completed" },
            orderBy: { createdAt: "desc" },
            select: { weekStart: true },
        });
        const weekStart = resolveViewWeek(calendarWeekStart, latestBatch?.weekStart ?? null).weekStart;

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

        // Filter 4: albums a download is already working on, from any batch
        const inFlight = new Set(
            (await prisma.downloadJob.findMany({
                where: { targetMbid: { in: allMbids }, status: { in: ["pending", "processing"] } },
                select: { targetMbid: true },
            })).map((j) => j.targetMbid)
        );

        const staleIds: string[] = [];
        const retriableAlbums = unavailableAlbums.filter((album) => {
            if (inFlight.has(album.albumMbid)) return false;
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
            const message = inFlight.size > 0
                ? "The unavailable albums are already downloading"
                : "All unavailable albums are already in your library";
            return res.json({ success: true, queued: 0, message });
        }

        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath;
        if (!musicPath) {
            return res.status(400).json({ error: "Music path not configured" });
        }

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
                await createDiscoveryDownloadJob(tx, {
                    userId,
                    batchId: newBatch.id,
                    musicPath,
                    album,
                    similarity: album.similarity,
                    extraMetadata: { retryOfUnavailable: true },
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

            // checkBatchCompletion owns the rest: the Lidarr import wait, the completion
            // scan, buildFinalPlaylist, reconcile and the final status. If a job is still
            // pending, the batch waits for the webhook, scan or the 30-min stuck sweep.
            const { discoverWeeklyService } = await import("../services/discoverWeekly");
            await prisma.discoveryBatch.update({
                where: { id: batch.id },
                data: { completedAlbums: completed, failedAlbums: failed },
            });
            await discoverWeeklyService.checkBatchCompletion(batch.id);
            logger.info(`[Discover Retry] Batch ${batch.id} handed to completion flow: ${completed} ok, ${failed} failed`);
        })().catch(async (bgError) => {
            logger.error(`[Discover Retry] Background processing crashed for batch ${batch.id}:`, bgError);
            await prisma.discoveryBatch.update({
                where: { id: batch.id },
                data: { status: "failed", errorMessage: "Retry processing crashed", completedAt: new Date() },
            }).catch(() => {});
        });
    } catch (error) {
        logger.error("Retry unavailable albums error:", error);
        res.status(500).json({ error: "Failed to retry unavailable albums" });
    }
});

router.get("/config", async (req, res) => {
    try {
        const userId = req.user!.id;

        let config = await prisma.userDiscoverConfig.findUnique({
            where: { userId },
        });

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

        if (playlistSize !== undefined) {
            const size = parseInt(playlistSize, 10);
            if (isNaN(size) || size < 5 || size > 50 || size % 5 !== 0) {
                return res.status(400).json({
                    error: "Invalid playlist size. Must be between 5-50 in increments of 5.",
                });
            }
        }

        if (maxRetryAttempts !== undefined) {
            const retries = parseInt(maxRetryAttempts, 10);
            if (isNaN(retries) || retries < 1 || retries > 10) {
                return res.status(400).json({
                    error: "Invalid retry attempts. Must be between 1-10.",
                });
            }
        }

        if (exclusionMonths !== undefined) {
            const months = parseInt(exclusionMonths, 10);
            if (isNaN(months) || months < 0 || months > 12) {
                return res.status(400).json({
                    error: "Invalid exclusion months. Must be between 0-12.",
                });
            }
        }

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

router.get("/popular-artists", async (req, res) => {
    try {
        const limit = parseInt(req.query.limit as string) || 20;

        const chart = await listenBrainzService.getTopChartArtists(limit);
        // ListenBrainz charts carry no pictures; the artwork door finds them.
        const artists = await withArtistArtwork(
            chart,
            (a) => ({ name: a.name, mbid: a.mbid, interactive: true }),
            (a, image) => ({ ...a, image }),
        );

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

// Clears the discovery playlist: liked albums move to the library and the rest are deleted.
router.delete("/clear", async (req, res) => {
    try {
        const userId = req.user!.id;

        logger.debug(`\nClearing Discover Weekly playlist for user ${userId}`);

        const settings = await getSystemSettings();
        if (!settings) {
            return res.status(500).json({ error: "System settings unavailable" });
        }

        const discoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                status: { in: ["ACTIVE", "LIKED"] },
            },
        });
        const likedAlbums = discoveryAlbums.filter((a) => a.status === "LIKED");
        const activeAlbums = discoveryAlbums.filter((a) => a.status === "ACTIVE");

        let likedMoved = 0;
        let activeDeleted = 0;
        // Albums Lidarr did not delete; each stays in Discover as it was, and the
        // listener is told to clear again.
        const lidarrFailed: ClearFailure[] = [];

        for (const album of likedAlbums) {
            try {
                if (await discoveryAlbumLifecycle.moveLikedAlbumToLibrary(album)) likedMoved++;
            } catch (error: any) {
                logger.error(`  Failed to move ${album.albumTitle}: ${error.message}`);
            }
        }

        for (const album of activeAlbums) {
            try {
                const result = await clearSuggestion(album);
                if (result.outcome === "cleared") activeDeleted++;
                else if (result.outcome === "kept") lidarrFailed.push(result.failure);
            } catch (error: any) {
                logger.error(`  Failed to delete ${album.albumTitle}: ${error.message}`);
                lidarrFailed.push({ artistName: album.artistName, albumTitle: album.albumTitle, reason: errorReason(error) });
            }
        }

        // Albums Lidarr fetched that no suggestion names (they missed the final playlist).
        lidarrFailed.push(...(await clearUnsuggestedDownloads(userId)));

        await prisma.unavailableAlbum.deleteMany({
            where: { userId },
        });

        // Failed discovery jobs are of no further use to the scanner.
        await prisma.downloadJob.deleteMany({
            where: {
                userId,
                discoveryBatchId: { not: null },
                status: "failed",
            },
        });

        // DISCOVER albums that no suggestion covers, left by failed downloads or a failed playlist build.
        const orphans = await clearOrphanedDiscoverAlbums();
        const orphanedAlbumsDeleted = orphans.cleared;
        const strip = ({ userIds: _named, ...f }: (typeof orphans.failures)[number]): ClearFailure => f;
        lidarrFailed.push(...orphans.failures.filter((f) => f.userIds.includes(userId)).map(strip));
        // Orphans no record names go to the admins' row, not the caller's own.
        const unnamedFailed = orphans.failures.filter((f) => f.userIds.length === 0).map(strip);
        await reportOrphanFailures(userId, orphans.failures);

        // Artists left with no albums
        const orphanedArtists = await prisma.artist.findMany({
            where: {
                albums: { none: {} },
            },
        });

        if (orphanedArtists.length > 0) {
            const orphanIds = orphanedArtists.map((a) => a.id);

            // Delete artist relations first (SimilarArtist records)
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

        const orphanedDiscoveryTracks = await prisma.discoveryTrack.deleteMany({
            where: { trackId: null },
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

        // Remove Discover-tagged artists; lidarrRemoval decides whether files go
        let lidarrArtistsRemoved = 0;
        if (isLidarrConfigured(settings)) {
            logger.debug(
                `\n[LIDARR CLEANUP] Tag-based cleanup (lidify-discovery tag)...`
            );

            try {
                const discoveryArtists =
                    await lidarrService.getDiscoveryArtists();
                logger.debug(
                    `   Found ${discoveryArtists.length} artists with discovery tag`
                );

                for (const lidarrArtist of discoveryArtists) {
                    if (await removeDiscoveryArtist(lidarrArtist)) {
                        lidarrArtistsRemoved++;
                        logger.debug(`Removed: ${lidarrArtist.artistName}`);
                    }
                }

                logger.debug(
                    `   Tag-based cleanup complete: ${lidarrArtistsRemoved} artists removed`
                );
            } catch (lidarrError: any) {
                logger.debug(`   Lidarr cleanup failed: ${lidarrError.message}`);
            }
        }

        logger.debug(`\n[SCAN] Triggering library scan to sync database...`);
        try {
            await requestScan({ userId, source: "discover-cleanup" });
            logger.debug(`   Library scan queued successfully`);
        } catch (scanError: any) {
            logger.debug(`   Library scan queue failed: ${scanError.message}`);
        }

        logger.debug(
            `\nClear complete: ${likedMoved} moved to library, ${activeDeleted} deleted, ${orphanedAlbumsDeleted} orphans cleaned, ${lidarrArtistsRemoved} Lidarr artists removed`
        );

        // This clear tried every Lidarr album Discover holds, so it writes the listener's
        // tray row when any failed and clears the row when none did.
        await reportLidarrFailures(userId, lidarrFailed, { complete: true, renotify: true });

        res.json({
            success: true,
            message: discoveryAlbums.length === 0 ? "No discovery albums to clear" : "Discovery playlist cleared",
            likedMoved,
            activeDeleted,
            orphanedAlbumsDeleted,
            lidarrArtistsRemoved,
            lidarrFailed: [...lidarrFailed, ...unnamedFailed],
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

// Removes artists discovery added to Lidarr that nothing references any more. DESTRUCTIVE: removes
// their files too. Dry run unless ?dryRun=false. Protection is global, because Lidarr is shared:
// an artist survives if any user owns or liked their work.
router.post("/cleanup-lidarr", requireAdmin, async (req, res) => {
    try {
        const dryRun = req.query.dryRun !== "false";

        logger.debug(
            `\n[CLEANUP] Starting Lidarr cleanup of discovery-only artists (dryRun=${dryRun})...`
        );

        const settings = await getSystemSettings();

        if (!isLidarrConfigured(settings)) {
            return res.status(400).json({ error: "Lidarr not configured" });
        }

        const discoveryArtists = await lidarrService.getDiscoveryArtists();
        const activeDiscoveryArtistMbids = new Set(
            (await prisma.discoveryAlbum.findMany({
                where: { status: "ACTIVE" },
                select: { artistMbid: true },
                distinct: ["artistMbid"],
            })).map((da) => da.artistMbid)
        );

        const artistsRemoved: string[] = [];
        const artistsKept: string[] = [];
        const errors: string[] = [];

        for (const lidarrArtist of discoveryArtists) {
            const artistName = lidarrArtist.artistName;
            if (activeDiscoveryArtistMbids.has(lidarrArtist.foreignArtistId)) {
                artistsKept.push(`${artistName} (has active discovery)`);
                continue;
            }
            try {
                const removable = dryRun
                    ? (await discoveryArtistVerdict(lidarrArtist)) === "delete"
                    : await removeDiscoveryArtist(lidarrArtist);
                if (removable) artistsRemoved.push(artistName);
                else artistsKept.push(`${artistName} (library, liked, or files Discover did not fetch)`);
            } catch (error: any) {
                errors.push(`Failed to process ${artistName}: ${error.message}`);
            }
        }

        logger.debug(`\n[CLEANUP] Complete:`);
        logger.debug(`   - Removed: ${artistsRemoved.length}`);
        logger.debug(`   - Kept: ${artistsKept.length}`);
        logger.debug(`   - Errors: ${errors.length}`);

        res.json({
            success: true,
            dryRun,
            // In a dry run this is the list that WOULD be removed; nothing was touched.
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

// Re-tags albums wrongly marked LIBRARY as DISCOVER and deletes their OwnedAlbum rows; liked and
// native library albums are left alone. DESTRUCTIVE. Dry run unless ?dryRun=false.
router.post("/fix-tagging", requireAdmin, async (req, res) => {
    try {
        const dryRun = req.query.dryRun !== "false";

        logger.debug(
            `\n[FIX-TAGGING] Starting album tagging repair (dryRun=${dryRun})...`
        );

        // The albums Discover's records say came from Discover, by exact match only (discoverEvidence).
        const relocated = await relocateDiscoverAlbums({ dryRun });
        const albumsFixed = relocated.length;
        const fixedArtists = [...new Set(relocated.map((a) => a.artist))];

        logger.debug(`[FIX-TAGGING] Complete: ${albumsFixed} albums ${dryRun ? "would move" : "moved"} to Discover`);

        res.json({
            success: true,
            dryRun,
            // In a dry run these are the counts that WOULD change; nothing was written.
            albumsFixed,
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
