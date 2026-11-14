import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAcquirePermission } from "../middleware/auth";
import { prisma } from "../utils/db";
import { listenBrainzService } from "../services/listenBrainz";
import { startOfWeek, endOfWeek } from "date-fns";
import { resolveViewWeek, resolveGenerationWeekStart, weekStartKey, weekBoundaryIso, WEEK_STARTS_ON } from "../lib/discoveryWeek";
import { isLidarrConfigured } from "../services/lidarrClient";

import { discoverQueue } from "../workers/queues";
import { requestScan } from "../workers/scanRequest";
import { getSystemSettings } from "../utils/systemSettings";
import { lidarrService } from "../services/lidarr";
import { discoveryArtistVerdict, otherSuggestionNeedsTag, removeDiscoveryArtist } from "../services/discovery/lidarrRemoval";
import { createDiscoveryDownloadJob } from "../services/discovery/discoveryDownloadJob";
import { discoveryAlbumLifecycle, returnToDiscover, takeIntoLibrary } from "../services/discovery/discoveryAlbumLifecycle";
import { findDiscoverAlbum, findScannedAlbum, recordedLidarrAlbumId, reportLidarrFailures } from "../services/discovery/discoverClearing";
import { NameIndex, relocateDiscoverAlbums } from "../services/discovery/discoverEvidence";
import { distributedLock } from '../utils/distributedLock';
import { withArtistArtwork } from "../services/artwork";
import { parseLimit } from "./library/paging";
import { config } from "../config";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import * as downloadJobs from "../services/downloads/jobs";
import type { Prisma } from "@prisma/client";
import { PLAYABLE_DISCOVER_SONG, PLAYABLE_SONG } from "../utils/playableSong";

const router = Router();

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

            // The batch is marked failed first: cancelling its jobs tells it, and a batch
            // that is already over takes no further completion work.
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

            const unfinished = batch.jobs.filter((j) => j.status === "pending" || j.status === "processing");
            try {
                await simpleDownloadManager.cancelJobs(unfinished);
            } catch (lidarrError) {
                logger.warn(`[Discover Cancel] Could not stop the Lidarr side for batch ${batch.id}:`, lidarrError);
            }
            const cancelled = await downloadJobs.cancel(unfinished);
            downloadJobsCancelled += cancelled.length;
            logger.debug(`[Discover Cancel] Cancelled ${cancelled.length} download jobs for batch ${batch.id}`);

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
 * week downloaded the release, an album with its release id exists, or an album of the same artist (sameArtist: a
 * namesake under another MusicBrainz id is not) and title by the name fold exists. Another edition is not the album asked for.
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
        prisma.album.findMany({ select: { title: true, artist: { select: { name: true, mbid: true } } } }),
    ]);
    const suggestedMbids = new Set(suggested.map((a) => a.rgMbid));
    const existingMbids = new Set(withMbid.map((a) => a.rgMbid));
    const byName = new NameIndex();
    for (const a of everyAlbum) byName.add(a.artist.name, a.artist.mbid, a.title);

    const missing: UnavailableRow[] = [];
    const turnedUp: UnavailableRow[] = [];
    for (const album of albums) {
        const found =
            suggestedMbids.has(album.albumMbid) ||
            existingMbids.has(album.albumMbid) ||
            byName.has(album.artistName, album.artistMbid, album.albumTitle);
        (found ? turnedUp : missing).push(album);
    }
    return { missing, turnedUp };
}

/**
 * The playable-song rule for a suggestion's songs: a liked suggestion's album is in the library now, any other's is
 * still a Discover album.
 */
const suggestionSongRule = (status: string) => (status === "LIKED" ? PLAYABLE_SONG : PLAYABLE_DISCOVER_SONG);

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

type SuggestionWithSongs = Prisma.DiscoveryAlbumGetPayload<{ include: { tracks: true } }>;
type RecordedSong = Awaited<ReturnType<typeof recordedSongs>>[number];
type StandIn = { song: { id: string; title: string; duration: number }; coverUrl: string | null };

/**
 * The songs GET /current lists for a week's suggestions, in suggestion order, in a fixed number of queries. A
 * suggestion lists its recorded songs that are playable; with none, one stand-in: the first playable song in track
 * order of its album, found by release id (title and artist only when it has no release id); with no album or no
 * playable song yet, a pending placeholder.
 */
async function suggestionSongs(suggestions: SuggestionWithSongs[]) {
    // A liked suggestion's album is in the library now; any other's is a Discover album, never a library album of the
    // same name, so each kind is looked up under its own rule.
    const found = new Map<string, ReturnType<typeof suggestionSong>[]>();
    for (const liked of [true, false]) {
        const group = suggestions.filter((s) => (s.status === "LIKED") === liked);
        if (group.length > 0) for (const [id, songs] of await songsOfGroup(group, liked)) found.set(id, songs);
    }

    return suggestions.flatMap((s) => {
        const songs = found.get(s.id);
        if (songs && songs.length > 0) return songs;
        // The album is not in the library yet (downloading or pending), or none of its songs can play.
        return [
            {
                ...suggestionSong(s, {
                    id: `pending-${s.id}`,
                    title: `${s.albumTitle} (pending import)`,
                    duration: 0,
                    coverUrl: null,
                }),
                available: false,
                isPending: true,
            },
        ];
    });
}

/** The playable songs of suggestions that are all liked, or all not, by suggestion id: recorded songs, else the stand-in. */
async function songsOfGroup(group: SuggestionWithSongs[], liked: boolean) {
    const rule = suggestionSongRule(liked ? "LIKED" : "ACTIVE");
    const ids = group.flatMap((s) => s.tracks.map((dt) => dt.trackId).filter((id): id is string => id !== null));
    const recorded = new Map<string, RecordedSong>((await recordedSongs(rule, ids)).map((song) => [song.id, song]));
    const recordedOf = (s: SuggestionWithSongs) =>
        s.tracks.flatMap((dt) => (dt.trackId && recorded.has(dt.trackId) ? [recorded.get(dt.trackId)!] : []));

    const needy = group.filter((s) => recordedOf(s).length === 0);
    const standIns = new Map<string, StandIn>();
    if (needy.length > 0) {
        const matches = [
            { rgMbid: { in: needy.filter((s) => s.rgMbid).map((s) => s.rgMbid) } },
            ...needy.filter((s) => !s.rgMbid).map((s) => ({ title: s.albumTitle, artist: { name: s.artistName } })),
        ];
        const albums = await prisma.album.findMany({
            where: { AND: [liked ? {} : { location: "DISCOVER" as const }, { OR: matches }] },
            include: {
                artist: { select: { name: true } },
                tracks: { where: rule, take: 1, orderBy: { trackNo: "asc" } },
            },
        });
        for (const s of needy) {
            const album = s.rgMbid
                ? albums.find((a) => a.rgMbid === s.rgMbid)
                : albums.find((a) => a.title === s.albumTitle && a.artist.name === s.artistName);
            if (album && album.tracks.length > 0) standIns.set(s.id, { song: album.tracks[0], coverUrl: album.coverUrl });
        }
    }

    return new Map(
        group.map((s) => {
            const standIn = standIns.get(s.id);
            return [
                s.id,
                standIn
                    ? [suggestionSong(s, { ...standIn.song, coverUrl: standIn.coverUrl })]
                    : recordedOf(s).map((song) => suggestionSong(s, { ...song, coverUrl: song.album?.coverUrl ?? null })),
            ] as const;
        }),
    );
}

/** The recorded songs among `ids` that satisfy the playable-song rule, each with its album. */
function recordedSongs(rule: ReturnType<typeof suggestionSongRule>, ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.track.findMany({
        where: { AND: [rule, { id: { in: ids } }] },
        include: { album: { include: { artist: true } } },
    });
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

        const tracks = await suggestionSongs(discoveryAlbums);

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
 * Takes Discover's tag off the Lidarr artist that owns the suggestion's Lidarr album record, and off no one else: the
 * album's Lidarr id is the stored one, else the one Discover's records name (a suggestion or Discover download job, by
 * release-group id or name; `rgMbids` are the ids the album is known by). The tag stays while another current suggestion
 * still needs it.
 */
async function untagAlbumOwner(
    suggestion: { id: string; artistName: string; artistMbid: string | null; albumTitle: string; rgMbid: string; lidarrAlbumId: number | null },
    rgMbids: string[],
): Promise<void> {
    const label = `${suggestion.artistName} - ${suggestion.albumTitle}`;
    try {
        const lidarrAlbumId = suggestion.lidarrAlbumId ?? (await recordedLidarrAlbumId(suggestion, rgMbids));
        const record = lidarrAlbumId === null ? null : await lidarrService.getAlbum(lidarrAlbumId);
        if (!record) {
            logger.warn(`[Discover] No Lidarr album record for ${label}; Discover's tag stays on every Lidarr artist`);
            return;
        }
        const tagId = await lidarrService.getOrCreateDiscoveryTag();
        if (tagId === null) {
            logger.warn(`[Discover] Lidarr has no Discover tag to remove for ${label}`);
            return;
        }
        const artist = await lidarrService.getArtistById(record.artistId);
        if (await otherSuggestionNeedsTag(suggestion, artist)) {
            logger.debug(`[Discover] Discover's tag stays on Lidarr artist ${record.artistId}: another current suggestion needs it (${label} kept)`);
            return;
        }
        if (await lidarrService.removeTagsFromArtist(record.artistId, [tagId])) {
            logger.debug(`   Removed discovery tag from Lidarr artist ${record.artistId} (owner of ${label})`);
        } else {
            logger.warn(`[Discover] Lidarr did not take Discover's tag off its artist ${record.artistId} for ${label}`);
        }
    } catch (e: any) {
        logger.warn(`[Discover] Discover's tag not removed for ${label}: ${e.message}`);
    }
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

        // Only Discover's copy: a listener's own library album of the same name must not take the like's mark, or an
        // unlike would send it to Discover.
        const dbAlbum = await findDiscoverAlbum(discoveryAlbum);

        // The album is the listener's first: Lidarr is slow and can fail, and neither undoes the like.
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

        // The Discover tag comes off the Lidarr artist that owns this album's record, so cleanup does not delete the
        // artist. Only that artist: Lidarr artists sharing its name are other people's. When no record names the
        // album's Lidarr id, or Lidarr cannot find it, nobody is untagged. A failure is logged and the like stands.
        await untagAlbumOwner(discoveryAlbum, [...new Set([discoveryAlbum.rgMbid, ...(dbAlbum ? [dbAlbum.rgMbid] : [])])]);

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

        // Everything after the reply is the background function's, so a failure in it marks the batch failed below
        // instead of reaching this route's catch, which would answer a second time.
        (async () => {
            const { acquisitionService } = await import("../services/acquisitionService");
            const jobs = await prisma.downloadJob.findMany({
                where: { discoveryBatchId: batch.id },
            });
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
                    await downloadJobs.fail([job], (error as any)?.message || "Acquisition failed").catch(() => {});
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
router.post("/cleanup-lidarr", async (req, res) => {
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
router.post("/fix-tagging", async (req, res) => {
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
