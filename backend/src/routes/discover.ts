import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken, requireAdmin, requireAcquirePermission } from "../middleware/auth";
import { prisma } from "../utils/db";
import { listenBrainzService } from "../services/listenBrainz";
import { startOfWeek, endOfWeek } from "date-fns";
import { resolveViewWeek, resolveGenerationWeekStart, weekStartKey, weekBoundaryIso, WEEK_STARTS_ON } from "../lib/discoveryWeek";
import { isLidarrConfigured } from "../services/lidarrClient";

import { discoverQueue } from "../workers/queues";
import { requestScan } from "../workers/scanRequest";
import { getSystemSettings } from "../utils/systemSettings";
import { lidarrService } from "../services/lidarr";
import { discoveryArtistVerdict, removeDiscoveryArtist } from "../services/discovery/lidarrRemoval";
import { createDiscoveryDownloadJob } from "../services/discovery/discoveryDownloadJob";
import { discoveryAlbumLifecycle, returnToDiscover, takeIntoLibrary } from "../services/discovery/discoveryAlbumLifecycle";
import { findDiscoverAlbum, findScannedAlbum, reportLidarrFailures } from "../services/discovery/discoverClearing";
import { lookupKey, relocateDiscoverAlbums, sameName } from "../services/discovery/discoverEvidence";
import { distributedLock } from '../utils/distributedLock';
import { withArtistArtwork } from "../services/artwork";
import { parseLimit } from "./library/paging";
import { config } from "../config";

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

        logger.debug(`[Batch Status] User ${userId}: batch ${activeBatch.id} ${activeBatch.status}, ${progress}%`);

        res.json(response);
    } catch (error) {
        logger.error("Get batch status error:", error);
        res.status(500).json({ error: "Failed to get batch status" });
    }
});

router.delete("/batch", async (req, res) => {
    try {
        const userId = req.user!.id;

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
            logger.debug(`[Discover Cancel] Processing batch ${batch.id}, status: ${batch.status}`);

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
            logger.debug(`[Discover Cancel] Cancelled ${downloadJobsUpdated.count} download jobs for batch ${batch.id}`);

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
            logger.debug(`[Discover Cancel] Marked batch ${batch.id} as failed`);
        }

        const activeJobs = await discoverQueue.getActive();
        for (const job of activeJobs) {
            if (job.data.userId === userId) {
                try {
                    await job.moveToFailed(new Error("Cancelled by user"), "");
                    jobsCancelled++;
                    logger.debug(`[Discover Cancel] Cancelled Bull job ${job.id}`);
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
                    logger.debug(`[Discover Cancel] Removed waiting job ${job.id}`);
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

                logger.debug(`[Discover] Queuing generation for user ${userId}`);

                const weekKey = weekStartKey(resolveGenerationWeekStart(new Date()));
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

        logger.error('Unexpected error in discovery generation:', error);
        return res.status(500).json({
            error: 'An unexpected error occurred',
            code: 'INTERNAL_ERROR',
        });
    }
});

type UnavailableRow = Awaited<ReturnType<typeof prisma.unavailableAlbum.findMany>>[number];

/**
 * Splits a week's unavailable albums into those still missing and those that turned up since: a suggestion of the
 * week downloaded the release, an album with its release id exists, or an album of the same artist and title by
 * `lookupKey` exists. Another edition is not the album asked for.
 */
async function unavailableStillMissing(
    userId: string,
    weekStart: Date,
    albums: UnavailableRow[],
): Promise<{ missing: UnavailableRow[]; turnedUp: UnavailableRow[] }> {
    if (albums.length === 0) return { missing: [], turnedUp: [] };
    const mbids = albums.map((a) => a.albumMbid).filter(Boolean);
    const [suggested, withMbid, everyAlbum] = await Promise.all([
        prisma.discoveryAlbum.findMany({
            where: { userId, weekStartDate: weekStart, status: { in: ["ACTIVE", "LIKED"] } },
            select: { rgMbid: true },
        }),
        prisma.album.findMany({ where: { rgMbid: { in: mbids } }, select: { rgMbid: true } }),
        prisma.album.findMany({ select: { title: true, artist: { select: { name: true } } } }),
    ]);
    const suggestedMbids = new Set(suggested.map((a) => a.rgMbid));
    const existingMbids = new Set(withMbid.map((a) => a.rgMbid));
    const byName = new Set(everyAlbum.map((a) => lookupKey(a.artist.name, a.title)));

    const missing: UnavailableRow[] = [];
    const turnedUp: UnavailableRow[] = [];
    for (const album of albums) {
        const found =
            suggestedMbids.has(album.albumMbid) ||
            existingMbids.has(album.albumMbid) ||
            byName.has(lookupKey(album.artistName, album.albumTitle));
        (found ? turnedUp : missing).push(album);
    }
    return { missing, turnedUp };
}

type SuggestionRow = Awaited<ReturnType<typeof prisma.discoveryAlbum.findMany>>[number];

/** One song of a week's suggestion as GET /current lists it. */
function suggestionSong(
    suggestion: SuggestionRow,
    song: { id: string; title: string; duration: number; coverUrl: string | null },
) {
    return {
        id: song.id,
        title: song.title,
        artist: suggestion.artistName,
        album: suggestion.albumTitle,
        albumId: suggestion.rgMbid,
        isLiked: suggestion.status === "LIKED",
        likedAt: suggestion.likedAt,
        similarity: suggestion.similarity,
        tier: suggestion.tier,
        coverUrl: song.coverUrl,
        available: true,
        duration: song.duration,
    };
}

/** The week the listener's Discover page shows, from the calendar week and their latest completed batch. */
async function viewWeekFor(userId: string) {
    const latestBatch = await prisma.discoveryBatch.findFirst({
        where: { userId, status: "completed" },
        orderBy: { createdAt: "desc" },
        select: { weekStart: true },
    });
    return resolveViewWeek(startOfWeek(new Date(), { weekStartsOn: WEEK_STARTS_ON }), latestBatch?.weekStart ?? null);
}

router.get("/current", async (req, res) => {
    try {
        const userId = req.user!.id;

        const view = await viewWeekFor(userId);
        const weekStart = view.weekStart;
        const weekEnd = endOfWeek(view.weekOf, { weekStartsOn: WEEK_STARTS_ON });

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
                            tracks.push(suggestionSong(discoveryAlbum, { ...track, coverUrl: track.album?.coverUrl ?? null }));
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
                    tracks.push(suggestionSong(discoveryAlbum, { ...album.tracks[0], coverUrl: album.coverUrl }));
                } else {
                    // Album not in library yet (downloading/pending)
                    tracks.push({
                        ...suggestionSong(discoveryAlbum, {
                            id: `pending-${discoveryAlbum.id}`,
                            title: `${discoveryAlbum.albumTitle} (pending import)`,
                            duration: 0,
                            coverUrl: null,
                        }),
                        available: false,
                        isPending: true,
                    });
                }
            }
        }

        const { missing: filteredUnavailable } = await unavailableStillMissing(userId, weekStart, unavailableAlbums);

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

        logger.debug(`[Discover] ${tracks.length} songs, ${unavailable.length} unavailable albums`);

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

/**
 * A like keeps the suggestion and an unlike gives it back, so the listener's plays of its songs are relabelled: a
 * kept suggestion's plays count as DISCOVERY_KEPT, a returned one's as DISCOVERY.
 */
async function relabelSuggestionPlays(
    userId: string,
    discoveryAlbumId: string,
    from: "DISCOVERY" | "DISCOVERY_KEPT",
    to: "DISCOVERY" | "DISCOVERY_KEPT",
): Promise<void> {
    const songs = await prisma.discoveryTrack.findMany({ where: { discoveryAlbumId }, select: { trackId: true } });
    const trackIds = songs.map((t) => t.trackId).filter((id): id is string => id !== null);
    if (trackIds.length === 0) return;
    await prisma.play.updateMany({ where: { userId, trackId: { in: trackIds }, source: from }, data: { source: to } });
}

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
                // Every artist of that name: removing the tag from a namesake only keeps it.
                const namedArtists = lidarrArtists.filter((a) => sameName(a.artistName, discoveryAlbum.artistName));

                if (namedArtists.length > 0) {
                    const tagId = await lidarrService.getOrCreateDiscoveryTag();
                    for (const lidarrArtist of namedArtists) {
                        if (!tagId || !lidarrArtist.tags?.includes(tagId)) continue;
                        await lidarrService.removeTagsFromArtist(lidarrArtist.id, [tagId]);
                        logger.debug(`   Removed discovery tag from ${lidarrArtist.artistName} (found by name)`);
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

        // Only Discover's copy: a listener's own library album of the same name must not take the like's mark, or an
        // unlike would send it to Discover.
        const dbAlbum = await findDiscoverAlbum(discoveryAlbum);

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

        await relabelSuggestionPlays(userId, discoveryAlbum.id, "DISCOVERY", "DISCOVERY_KEPT");

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

        await relabelSuggestionPlays(userId, discoveryAlbum.id, "DISCOVERY_KEPT", "DISCOVERY");

        res.json({ success: true });
    } catch (error) {
        logger.error("Unlike discovery album error:", error);
        res.status(500).json({ error: "Failed to unlike album" });
    }
});

router.post("/retry-unavailable", requireAcquirePermission, async (req, res) => {
    try {
        const userId = req.user!.id;

        const weekStart = (await viewWeekFor(userId)).weekStart;

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

        // Albums that turned up since are deleted, not downloaded again (a duplicate import); one a download is
        // already working on, from any batch, is left alone.
        const inFlight = new Set(
            (await prisma.downloadJob.findMany({
                where: { targetMbid: { in: unavailableAlbums.map((a) => a.albumMbid) }, status: { in: ["pending", "processing"] } },
                select: { targetMbid: true },
            })).map((j) => j.targetMbid)
        );
        const { missing, turnedUp } = await unavailableStillMissing(
            userId,
            weekStart,
            unavailableAlbums.filter((album) => !inFlight.has(album.albumMbid)),
        );
        const retriableAlbums = missing;
        const staleIds = turnedUp.map((album) => album.id);

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

        const musicPath = config.music.musicPath;

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

        // A listener with no settings yet gets the schema's defaults.
        const config =
            (await prisma.userDiscoverConfig.findUnique({ where: { userId } })) ??
            (await prisma.userDiscoverConfig.create({ data: { userId } }));

        res.json(config);
    } catch (error) {
        logger.error("Get Discover Weekly config error:", error);
        res.status(500).json({ error: "Failed to get configuration" });
    }
});

router.patch("/config", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { playlistSize, maxRetryAttempts, exclusionMonths, downloadRatio, enabled } = req.body;
        const changes: {
            playlistSize?: number;
            maxRetryAttempts?: number;
            exclusionMonths?: number;
            downloadRatio?: number;
            enabled?: boolean;
        } = {};

        if (playlistSize !== undefined) {
            const size = parseInt(playlistSize, 10);
            if (isNaN(size) || size < 5 || size > 50 || size % 5 !== 0) {
                return res.status(400).json({
                    error: "Invalid playlist size. Must be between 5-50 in increments of 5.",
                });
            }
            changes.playlistSize = size;
        }

        if (maxRetryAttempts !== undefined) {
            const retries = parseInt(maxRetryAttempts, 10);
            if (isNaN(retries) || retries < 1 || retries > 10) {
                return res.status(400).json({
                    error: "Invalid retry attempts. Must be between 1-10.",
                });
            }
            changes.maxRetryAttempts = retries;
        }

        if (exclusionMonths !== undefined) {
            const months = parseInt(exclusionMonths, 10);
            if (isNaN(months) || months < 0 || months > 12) {
                return res.status(400).json({
                    error: "Invalid exclusion months. Must be between 0-12.",
                });
            }
            changes.exclusionMonths = months;
        }

        if (downloadRatio !== undefined) {
            const ratio = parseFloat(downloadRatio);
            if (isNaN(ratio) || ratio < 1.0 || ratio > 2.0) {
                return res.status(400).json({
                    error: "Invalid download ratio. Must be between 1.0-2.0.",
                });
            }
            changes.downloadRatio = ratio;
        }

        if (enabled !== undefined) {
            if (typeof enabled !== "boolean") {
                return res.status(400).json({ error: "Invalid enabled value. Must be true or false." });
            }
            changes.enabled = enabled;
        }

        // A first save fills whatever it leaves out with the schema's defaults.
        const config = await prisma.userDiscoverConfig.upsert({
            where: { userId },
            create: { userId, ...changes },
            update: changes,
        });

        res.json(config);
    } catch (error) {
        logger.error("Update Discover Weekly config error:", error);
        res.status(500).json({ error: "Failed to update configuration" });
    }
});

router.get("/popular-artists", async (req, res) => {
    try {
        const limit = parseLimit(req.query.limit, 20);

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
        logger.debug(`[Discover Clear] Clearing the playlist of user ${userId}`);

        const hadSuggestions = (await prisma.discoveryAlbum.count({ where: { userId, status: { in: ["ACTIVE", "LIKED"] } } })) > 0;
        const result = await discoveryAlbumLifecycle.clearDiscover(userId);

        try {
            await requestScan({ userId, source: "discover-cleanup" });
        } catch (scanError: any) {
            logger.warn(`[Discover Clear] Library scan could not be queued: ${scanError.message}`);
        }

        logger.debug(
            `[Discover Clear] Done: ${result.moved} moved to library, ${result.deleted} deleted, ${result.orphansCleared} orphans cleaned, ${result.lidarrArtistsRemoved} Lidarr artists removed`
        );

        // This clear tried every Lidarr album Discover holds, so it writes the listener's
        // tray row when any failed and clears the row when none did.
        await reportLidarrFailures(userId, result.lidarrFailed, { complete: true, renotify: true });

        res.json({
            success: true,
            message: hadSuggestions ? "Discovery playlist cleared" : "No discovery albums to clear",
            likedMoved: result.moved,
            activeDeleted: result.deleted,
            orphanedAlbumsDeleted: result.orphansCleared,
            lidarrArtistsRemoved: result.lidarrArtistsRemoved,
            lidarrFailed: [...result.lidarrFailed, ...result.unnamedFailed],
        });
    } catch (error: any) {
        logger.error(`Clear discovery playlist error: ${error?.message ?? String(error)}`);
        res.status(500).json({ error: "Failed to clear discovery playlist" });
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
                    ? ["delete", "forget"].includes(await discoveryArtistVerdict(lidarrArtist))
                    : await removeDiscoveryArtist(lidarrArtist);
                if (removable) artistsRemoved.push(artistName);
                else artistsKept.push(`${artistName} (library, liked, in a current Discover week, or files Discover did not fetch)`);
            } catch (error: any) {
                errors.push(`Failed to process ${artistName}: ${error.message}`);
            }
        }

        logger.debug(`[CLEANUP] ${artistsRemoved.length} removed, ${artistsKept.length} kept, ${errors.length} errors`);

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
        logger.error(`[CLEANUP] Lidarr cleanup error: ${error?.message ?? String(error)}`);
        res.status(500).json({ error: "Failed to cleanup Lidarr" });
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
        logger.error(`[FIX-TAGGING] Error: ${error?.message ?? String(error)}`);
        res.status(500).json({ error: "Failed to fix album tagging" });
    }
});

export default router;
