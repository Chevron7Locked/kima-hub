/**
 * Weekly discovery playlists: similar-artist recommendations by tier, albums
 * acquired through Lidarr or Soulseek, and tracks shown only once imported.
 */

import { logger } from "../utils/logger";
import { artistNamed, normalizeArtistName } from "./artistIdentity";
import { sameName } from "./discovery/discoverEvidence";
import { isMbid } from "./artistIdentity";
import { titlesAgree } from "./albumIdentity";
import { nameWords } from "./nameFold";
import type { SeedArtist } from "./discovery/discoverySeeding";
import { prisma } from "../utils/db";
import { removeFailedDownload } from "./lidarrFailures";
import {
    getSimilarArtists,
    type SimilarArtist,
} from "./artistSimilarity";
import { musicBrainzService } from "./musicbrainz";
import { failureCause } from "../utils/outcome";
import { sourcePauseController } from "./sourcePauseController";
import { updateBatchStatus } from "./discovery/optimisticBatchUpdate";
import { removeDiscoveryArtist } from "./discovery/lidarrRemoval";
import { lidarrService } from "./lidarr";
import { isLidarrConfigured } from "./lidarrClient";
import { requestScan } from "../workers/scanRequest";
import { resolveGenerationWeekStart, weekStartKey } from "../lib/discoveryWeek";
import { getSystemSettings } from "../utils/systemSettings";
import { discoveryLogger } from "./discoveryLogger";
import { acquisitionService } from "./acquisitionService";
import {
    discoveryBatchLogger,
    discoveryAlbumLifecycle,
    discoverySeeding,
    createDiscoveryDownloadJob,
} from "./discovery";
import { shuffleArray } from "../utils/shuffle";
import { config as appConfig } from "../config";
import { eventBus } from "./eventBus";
import { NOT_MISSING } from "../utils/libraryEligibility";

interface RecommendedAlbum {
    artistName: string;
    artistMbid?: string;
    albumTitle: string;
    albumMbid: string;
    similarity: number;
    tier?: "high" | "medium" | "explore" | "wildcard";
}

// Share of each playlist taken from each similarity tier.
const TIER_DISTRIBUTION = {
    high: 0.3, // 30% from very similar artists (>=65% match)
    medium: 0.4, // 40% from moderately similar (50-65% match)
    explore: 0.2, // 20% from stretch picks (35-50% match)
    wildcard: 0.1, // 10% from deep cuts (variety)
};

// Tier thresholds over similar-artist scores (0.5 to 0.95 from the sources, moved at most 0.1 by the
// library's re-rank; artistSimilarity.ts).
const TIER_THRESHOLDS = {
    high: 0.65,       // >=65% match
    medium: 0.50,     // 50-65% match
    explore: 0.35,    // 35-50% match
    deepCutMin: 0.20, // Deep cuts: 20-35% (exploratory wildcard picks)
    deepCutMax: 0.35,
    minimum: 0.20,    // Don't recommend anything below this (allows deep cuts)
};

/** The tier a similar-artist score falls in (TIER_THRESHOLDS). */
function getTierFromSimilarity(
    similarity: number
): "high" | "medium" | "explore" | "wildcard" {
    if (similarity >= TIER_THRESHOLDS.high) return "high";
    if (similarity >= TIER_THRESHOLDS.medium) return "medium";
    if (similarity >= TIER_THRESHOLDS.explore) return "explore";
    return "wildcard";
}

class DiscoverWeeklyService {
    /** The playable songs of the DISCOVER album an artist and title name, ignoring case and accents (nameKey). */
    private async findDiscoverTracksByName(artistName: string, albumTitle: string) {
        const albums = await prisma.album.findMany({
            where: { location: "DISCOVER", artist: artistNamed(artistName) },
            select: { id: true, title: true },
        });
        const albumIds = albums.filter((a) => sameName(a.title, albumTitle)).map((a) => a.id);
        if (albumIds.length === 0) return [];
        return prisma.track.findMany({
            where: { ...NOT_MISSING, albumId: { in: albumIds } },
            include: { album: { include: { artist: true } } },
        });
    }

    async generatePlaylist(userId: string, jobId?: number) {
        const logPath = discoveryLogger.start(userId, jobId);
        discoveryLogger.info(`Log file: ${logPath}`);

        try {
            discoveryLogger.section("CONFIGURATION CHECK");
            const settings = await getSystemSettings();

            const weekStart = resolveGenerationWeekStart(new Date());

            const config = await prisma.userDiscoverConfig.findUnique({
                where: { userId },
            });

            if (!config || !config.enabled) {
                discoveryLogger.error("Discovery Weekly not enabled for user");
                discoveryLogger.end(false, "Not enabled");
                throw new Error("Discovery Weekly not enabled");
            }

            const downloadRatio = config.downloadRatio ?? 1.3;

            discoveryLogger.table({
                "Target Songs": config.playlistSize,
                "Download Ratio": `${downloadRatio}x`,
                "Week Start": weekStartKey(weekStart),
            });

            // Likes from last week decide which albums stay before new ones are picked.
            discoveryLogger.section("PROCESSING PREVIOUS WEEK");
            await discoveryAlbumLifecycle.processBeforeGeneration(userId);

            const targetCount = config.playlistSize;

            discoveryLogger.section("STEP 1: SEED ARTISTS");
            const seeds = await discoverySeeding.getSeedArtists(userId);
            if (seeds.length === 0) {
                discoveryLogger.error(
                    "No seed artists found - need listening history"
                );
                discoveryLogger.end(false, "No seed artists");
                throw new Error(
                    "No seed artists found - need listening history"
                );
            }
            discoveryLogger.success(`Found ${seeds.length} seed artists:`);
            discoveryLogger.list(
                seeds.map(
                    (s) => `${s.name}${s.mbid ? ` (${s.mbid})` : " (no MBID)"}`
                )
            );

            discoveryLogger.section("STEP 2: SIMILAR ARTISTS");
            const similarArtistsMap = await this.prefetchSimilarArtists(seeds);
            discoveryLogger.success(
                `Cached ${similarArtistsMap.size} similar artist sets`
            );
            for (const [key, similar] of similarArtistsMap.entries()) {
                const seedName =
                    seeds.find((s) => s.mbid === key || s.name === key)?.name ||
                    key;
                discoveryLogger.write(
                    `  ${seedName}: ${similar.length} similar artists`,
                    1
                );
            }

            // Request more albums than the target: some downloads fail.
            const albumsToRequest = Math.ceil(targetCount * downloadRatio);

            discoveryLogger.section(
                "STEP 3: ALBUM RECOMMENDATIONS (Multi-Strategy)"
            );
            discoveryLogger.info(
                `Requesting ${albumsToRequest} albums (${downloadRatio}x target of ${targetCount}) to account for failures`
            );

            const recommended = await this.findRecommendedAlbumsMultiStrategy(
                seeds,
                similarArtistsMap,
                albumsToRequest, // Request more albums!
                userId
            );

            if (recommended.length === 0) {
                discoveryLogger.error(
                    "No recommendations found after filtering"
                );
                discoveryLogger.end(false, "No recommendations found");
                throw new Error("No recommendations found");
            }

            const minRecommendations = targetCount;
            if (recommended.length < minRecommendations) {
                discoveryLogger.warn(
                    `Only ${recommended.length} recommendations found, need at least ${minRecommendations} for ${targetCount} unique albums`
                );
                discoveryLogger.warn(
                    "Consider expanding seed artists or playing more music"
                );
                await discoveryBatchLogger.warn(
                    "threshold-check",
                    `Low recommendations: ${recommended.length}/${minRecommendations} minimum (target: ${targetCount} unique albums)`
                );
            }

            discoveryLogger.success(
                `${recommended.length} albums recommended for download`
            );
            discoveryLogger.list(
                recommended.map(
                    (r) =>
                        `${r.artistName} - ${r.albumTitle} (similarity: ${(
                            r.similarity * 100
                        ).toFixed(0)}%)`
                )
            );

            discoveryLogger.section("STEP 4: CREATE BATCH & JOBS");

            const musicPath = settings?.musicPath || appConfig.music.musicPath;

            const batch = await prisma.$transaction(async (tx) => {
                const newBatch = await tx.discoveryBatch.create({
                    data: {
                        userId,
                        weekStart,
                        targetSongCount: targetCount,
                        status: "downloading",
                        totalAlbums: recommended.length,
                        completedAlbums: 0,
                        failedAlbums: 0,
                        logs: [
                            {
                                timestamp: new Date().toISOString(),
                                level: "info",
                                message: `Started with ${recommended.length} albums to download`,
                            },
                        ] as any,
                    },
                });
                discoveryLogger.success(`Created batch: ${newBatch.id}`);

                for (const album of recommended) {
                    const similarity =
                        typeof album.similarity === "number" &&
                        !isNaN(album.similarity)
                            ? album.similarity
                            : 0.5;

                    const existingJob = await tx.downloadJob.findFirst({
                        where: {
                            targetMbid: album.albumMbid,
                            status: { in: ["pending", "processing"] },
                        },
                    });

                    if (existingJob) {
                        logger.debug(
                            `   Skipping job: ${album.artistName} - ${album.albumTitle} (already in queue: ${existingJob.id})`
                        );
                        continue;
                    }

                    logger.debug(
                        `   Creating job: ${album.artistName} - ${album.albumTitle} (similarity: ${similarity}, tier: ${album.tier})`
                    );

                    await createDiscoveryDownloadJob(tx, {
                        userId,
                        batchId: newBatch.id,
                        musicPath,
                        album,
                        similarity,
                    });
                }

                return newBatch;
            });
            discoveryLogger.success(
                `Created ${recommended.length} download jobs`
            );

            discoveryLogger.section("STEP 5: START DOWNLOADS");
            let downloadsStarted = 0;
            let downloadsFailed = 0;

            const jobs = await prisma.downloadJob.findMany({
                where: { discoveryBatchId: batch.id },
            });

            // The acquisition service's queue enforces soulseekConcurrentDownloads.
            discoveryLogger.info(
                `Processing ${jobs.length} albums (concurrency controlled by acquisition service)`,
                1
            );

            const processJob = async (job: any, index: number) => {
                const metadata = job.metadata as any;

                discoveryLogger.info(
                    `[${index + 1}/${jobs.length}] Acquiring: ${metadata.artistName} - ${metadata.albumTitle}`,
                    1
                );

                try {
                    const result = await acquisitionService.acquireAlbum(
                        {
                            albumTitle: metadata.albumTitle,
                            artistName: metadata.artistName,
                            mbid: metadata.albumMbid,
                        },
                        {
                            userId: userId,
                            discoveryBatchId: batch.id,
                            existingJobId: job.id,
                        }
                    );

                    if (result.success) {
                        downloadsStarted++;
                        discoveryLogger.success(
                            `Acquired via ${result.source}: ${metadata.artistName} - ${metadata.albumTitle}`,
                            1
                        );

                        const newStatus = result.source === "soulseek" ? "completed" : "processing";
                        await prisma.downloadJob.update({
                            where: { id: job.id },
                            data: {
                                status: newStatus,
                                lidarrRef: result.correlationId || null,
                                completedAt: newStatus === "completed" ? new Date() : null,
                            },
                        });
                    } else {
                        downloadsFailed++;
                        discoveryLogger.error(
                            `Failed to acquire: ${metadata.albumTitle} - ${result.error}`,
                            1
                        );

                        await prisma.downloadJob.update({
                            where: { id: job.id },
                            data: {
                                status: "failed",
                                error: result.error,
                                completedAt: new Date(),
                            },
                        });

                        await discoveryBatchLogger.error(
                            batch.id,
                            `Failed to acquire ${metadata.albumTitle}: ${result.error}`
                        );
                    }
                } catch (error: any) {
                    downloadsFailed++;
                    const errorMsg = error?.message || String(error);
                    discoveryLogger.error(
                        `Exception acquiring ${metadata.albumTitle}: ${errorMsg}`,
                        1
                    );

                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: "failed",
                            error: errorMsg,
                            completedAt: new Date(),
                        },
                    });

                    await discoveryBatchLogger.error(
                        batch.id,
                        `Exception acquiring ${metadata.albumTitle}: ${errorMsg}`
                    );
                }
            };

            const promises = jobs.map((job, index) => processJob(job, index));
            await Promise.allSettled(promises);

            logger.info(`[Discover] Batch complete: ${downloadsStarted} succeeded, ${downloadsFailed} failed`);

            // Soulseek downloads complete synchronously, so the batch is checked here.
            logger.debug(`[Discovery] Checking batch completion (started: ${downloadsStarted}, failed: ${downloadsFailed})`);
            await this.checkBatchCompletion(batch.id);

            discoveryLogger.section("GENERATION COMPLETE");
            discoveryLogger.table({
                "Downloads Started": downloadsStarted,
                "Downloads Failed": downloadsFailed,
                "Total Albums": recommended.length,
                "Batch ID": batch.id,
            });

            await discoveryBatchLogger.info(
                batch.id,
                `${downloadsStarted} downloads started, waiting for webhooks`
            );

            discoveryLogger.end(
                true,
                `${downloadsStarted}/${recommended.length} downloads queued`
            );

            // The playlist is built once the downloads land and the scan finishes (checkBatchCompletion).
            return { success: true, batchId: batch.id, downloadsQueued: downloadsStarted };
        } catch (error: any) {
            discoveryLogger.error(`Generation failed: ${error.message}`);
            discoveryLogger.end(false, error.message);
            throw error;
        }
    }

    /**
     * Similar artists for every seed, fetched in small parallel batches.
     */
    private async prefetchSimilarArtists(
        seeds: SeedArtist[]
    ): Promise<Map<string, any[]>> {
        const cache = new Map<string, any[]>();

        // artistSimilarity never throws; it returns [] when it has nothing, and the
        // seed falls through to the next strategy. While ListenBrainz is paused even
        // the local-first call is skipped until the pause lifts.
        const fetchSimilar = async (
            seed: SeedArtist
        ): Promise<SimilarArtist[]> => {
            if (await sourcePauseController.isPaused("listenbrainz")) {
                return [];
            }
            return getSimilarArtists(seed.mbid || "", seed.name, 20);
        };

        const batchSize = 3;
        for (let i = 0; i < seeds.length; i += batchSize) {
            const seedBatch = seeds.slice(i, i + batchSize);

            const results = await Promise.all(
                seedBatch.map(async (seed) => {
                    const similar = await fetchSimilar(seed);
                    return { key: seed.mbid || seed.name, similar };
                })
            );

            for (const { key, similar } of results) {
                cache.set(key, similar);
            }

            if (i + batchSize < seeds.length) {
                await new Promise((r) => setTimeout(r, 300));
            }
        }

        return cache;
    }

    /** Fails batches stuck in "downloading" or "scanning" for too long; the queue cleaner calls it. */
    async checkStuckBatches(): Promise<number> {
        const BATCH_TIMEOUT_WITH_COMPLETIONS = 30 * 60 * 1000; // 30 minutes
        const BATCH_TIMEOUT_NO_COMPLETIONS = 60 * 60 * 1000; // 60 minutes
        const ABSOLUTE_MAX_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours - force fail any batch older than this
        const SCANNING_RETRY_TIMEOUT = 10 * 60 * 1000; // 10 minutes - retry scan
        const SCANNING_FAIL_TIMEOUT = 30 * 60 * 1000; // 30 minutes - force fail scanning batch

        const stuckBatches = await prisma.discoveryBatch.findMany({
            where: {
                status: { in: ["downloading", "scanning"] },
            },
            include: { jobs: true },
        });

        let forcedCount = 0;

        for (const batch of stuckBatches) {
            const batchAge = Date.now() - batch.createdAt.getTime();
            const completedJobs = batch.jobs.filter(
                (j) => j.status === "completed"
            );
            const pendingJobs = batch.jobs.filter(
                (j) => j.status === "pending" || j.status === "processing"
            );

            if (batchAge > ABSOLUTE_MAX_TIMEOUT) {
                logger.debug(
                    `\n[BATCH FORCE FAIL] Batch ${batch.id} is ${Math.round(
                        batchAge / 3600000
                    )}h old - force failing`
                );

                await updateBatchStatus(batch.id, {
                    status: "failed",
                    errorMessage: "Batch timed out after 2 hours",
                    completedAt: new Date(),
                });

                await prisma.downloadJob.updateMany({
                    where: {
                        discoveryBatchId: batch.id,
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "failed",
                        error: "Batch force-failed due to timeout",
                        completedAt: new Date(),
                    },
                });

                forcedCount++;
                continue;
            }

            if (batch.status === "scanning") {
                if (batchAge > SCANNING_FAIL_TIMEOUT) {
                    logger.debug(
                        `\n[BATCH SCAN FAIL] Batch ${batch.id} stuck in scanning for ${Math.round(batchAge / 60000)}min - force failing`
                    );

                    await updateBatchStatus(batch.id, {
                        status: "failed",
                        errorMessage: "Scan timed out after 30 minutes",
                        completedAt: new Date(),
                    });

                    forcedCount++;
                } else if (batchAge > SCANNING_RETRY_TIMEOUT) {
                    logger.debug(
                        `\n[BATCH SCAN RETRY] Batch ${batch.id} stuck in scanning for ${Math.round(batchAge / 60000)}min - re-queuing scan`
                    );

                    if (batch.errorMessage === "scan-retry-queued") {
                        continue;
                    }

                    await requestScan({
                        userId: batch.userId,
                        source: "discover-weekly-completion",
                        discoveryBatchId: batch.id,
                    });

                    // Mark as retried to prevent re-queuing every 30s
                    await prisma.discoveryBatch.update({
                        where: { id: batch.id },
                        data: { errorMessage: "scan-retry-queued" },
                    });

                    forcedCount++;
                }
                continue;
            }

            const hasCompletions = completedJobs.length > 0;
            const timeout = hasCompletions
                ? BATCH_TIMEOUT_WITH_COMPLETIONS
                : BATCH_TIMEOUT_NO_COMPLETIONS;

            if (batchAge > timeout && pendingJobs.length > 0) {
                logger.debug(
                    `\n[BATCH TIMEOUT] Batch ${
                        batch.id
                    } stuck for ${Math.round(batchAge / 60000)}min`
                );
                logger.debug(
                    `   Completed: ${completedJobs.length}, Pending: ${pendingJobs.length}`
                );

                await prisma.downloadJob.updateMany({
                    where: {
                        discoveryBatchId: batch.id,
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "failed",
                        error: "Batch timeout - download took too long",
                        completedAt: new Date(),
                    },
                });

                logger.debug(
                    `   Marked ${pendingJobs.length} pending jobs as failed`
                );

                await this.checkBatchCompletion(batch.id);
                forcedCount++;
            }
        }

        return forcedCount;
    }

    async checkBatchCompletion(batchId: string) {
        logger.debug(`\n[BATCH ${batchId}] Checking completion...`);

        const batch = await prisma.discoveryBatch.findUnique({
            where: { id: batchId },
            include: { jobs: true },
        });

        if (!batch) {
            logger.debug(`[BATCH ${batchId}] Not found - skipping`);
            return;
        }

        if (
            batch.status === "completed" ||
            batch.status === "failed" ||
            batch.status === "scanning"
        ) {
            logger.debug(
                `[BATCH ${batchId}] Already ${batch.status} - skipping`
            );
            return;
        }

        const completedJobs = batch.jobs.filter(
            (j) => j.status === "completed"
        );
        const failedJobs = batch.jobs.filter(
            (j) => j.status === "failed" || j.status === "exhausted"
        );
        const pendingJobs = batch.jobs.filter(
            (j) => j.status === "pending" || j.status === "processing"
        );

        const completed = completedJobs.length;
        const failed = failedJobs.length;
        const total = batch.jobs.length;

        eventBus.emit({
            type: "discover:progress",
            userId: batch.userId,
            payload: { batchId, status: "downloading", completed, failed, total, progress: Math.round(((completed + failed) / total) * 100) },
        });

        logger.debug(
            `[BATCH ${batchId}] Status: ${completed} completed, ${failed} failed, ${pendingJobs.length} pending (total: ${total})`
        );

        if (pendingJobs.length > 0) {
            logger.debug(
                `[BATCH ${batchId}] Still waiting for ${pendingJobs.length} downloads`
            );
            return;
        }

        // Only wait for Lidarr import if any jobs used Lidarr (have lidarrRef)
        const hasLidarrJobs = batch.jobs.some((j) => j.lidarrRef != null);
        if (hasLidarrJobs) {
            logger.debug(`[BATCH ${batchId}] All jobs done! Waiting 60s for Lidarr to finish importing...`);
            await new Promise(resolve => setTimeout(resolve, 60000));
        } else {
            logger.debug(`[BATCH ${batchId}] All jobs done via Soulseek, no Lidarr wait needed`);
        }

        // Another caller may have finished the batch while this one waited
        const freshBatch = await prisma.discoveryBatch.findUnique({
            where: { id: batchId },
            select: { status: true },
        });
        if (!freshBatch || freshBatch.status !== "downloading") {
            logger.debug(
                `\n[BATCH ${batchId}] Status changed to ${freshBatch?.status} during wait, aborting (handled by other caller)`
            );
            return;
        }

        logger.debug(`[BATCH ${batchId}] Transitioning to scan phase...`);

        await prisma.$transaction(async (tx) => {
            for (const job of failedJobs.filter((j) => j.targetMbid)) {
                const metadata = job.metadata as any;
                await tx.unavailableAlbum.upsert({
                    where: {
                        userId_weekStartDate_albumMbid: {
                            userId: batch.userId,
                            weekStartDate: batch.weekStart,
                            albumMbid: job.targetMbid!,
                        },
                    },
                    create: {
                        userId: batch.userId,
                        albumMbid: job.targetMbid!,
                        artistName: metadata?.artistName || "Unknown",
                        albumTitle: metadata?.albumTitle || "Unknown",
                        similarity: metadata?.similarity || 0.5,
                        tier:
                            metadata?.tier ||
                            getTierFromSimilarity(
                                metadata?.similarity || 0.5
                            ),
                        attemptNumber: 1,
                        weekStartDate: batch.weekStart,
                    },
                    update: {
                        attemptNumber: { increment: 1 },
                    },
                });
            }

            if (completed === 0) {
                await updateBatchStatus(
                    batchId,
                    {
                        status: "failed",
                        expectedStatus: "downloading",
                        completedAlbums: 0,
                        failedAlbums: failed,
                        errorMessage: "All downloads failed",
                        completedAt: new Date(),
                    },
                    {},
                    tx
                );
            } else {
                await updateBatchStatus(
                    batchId,
                    {
                        status: "scanning",
                        expectedStatus: "downloading",
                        completedAlbums: completed,
                        failedAlbums: failed,
                    },
                    {},
                    tx
                );
            }
        });

        if (completed === 0) {
            logger.debug(`   All downloads failed`);
            await discoveryBatchLogger.error(batchId, "All downloads failed");

            eventBus.emit({
                type: "discover:complete",
                userId: batch.userId,
                payload: { batchId, status: "failed" },
            });

            await this.cleanupFailedArtists(batchId);
            return;
        }

        logger.debug(
            `   ${completed} albums ready for playlist. Triggering scan...`
        );
        await discoveryBatchLogger.info(
            batchId,
            `${completed} completed, ${failed} failed. All successful downloads will be in playlist.`
        );

        await requestScan({
            userId: batch.userId,
            source: "discover-weekly-completion",
            discoveryBatchId: batchId,
        });

        eventBus.emit({
            type: "discover:progress",
            userId: batch.userId,
            payload: { batchId, status: "scanning", completed, failed, total, progress: 100 },
        });

        logger.debug(
            `   Scan queued - will build playlist after scan completes`
        );
    }

    async buildFinalPlaylist(batchId: string) {
        logger.debug(`\nBuilding final playlist for batch ${batchId}...`);

        const batch = await prisma.discoveryBatch.findUnique({
            where: { id: batchId },
        });

        if (!batch) {
            logger.debug(`   Batch not found`);
            return;
        }

        if (batch.status === "completed" || batch.status === "failed") {
            logger.debug(`   Batch already ${batch.status} (finalSongCount=${batch.finalSongCount}) - skipping duplicate buildFinalPlaylist`);
            return;
        }

        const completedJobs = await prisma.downloadJob.findMany({
            where: {
                discoveryBatchId: batchId,
                status: "completed",
            },
        });

        logger.debug(`   Found ${completedJobs.length} completed downloads`);
        await discoveryBatchLogger.info(
            batchId,
            `Building playlist from ${completedJobs.length} completed downloads`
        );

        const searchCriteria = completedJobs
            .map((j) => {
                const metadata = j.metadata as any;
                return {
                    artistName: metadata?.artistName || "",
                    albumTitle: metadata?.albumTitle || "",
                    albumMbid: metadata?.albumMbid || j.targetMbid || "",
                };
            })
            .filter((c) => c.artistName && c.albumTitle);

        logger.debug(
            `   Searching for tracks using MBID (primary) + name fallback:`
        );
        for (const c of searchCriteria) {
            logger.debug(
                `     - "${c.albumTitle}" by "${c.artistName}" (MBID: ${
                    c.albumMbid || "none"
                })`
            );
        }

        // Only albums filed as Discover: a library album of the same name is the listener's own.
        let allTracks: any[] = [];
        for (const criteria of searchCriteria) {
            let tracks: any[] = [];

            // By release-group MBID
            if (criteria.albumMbid) {
                tracks = await prisma.track.findMany({
                    where: {
                    ...NOT_MISSING,
                        album: { rgMbid: criteria.albumMbid, location: "DISCOVER" },
                    },
                    include: {
                        album: { include: { artist: true } },
                    },
                });
                if (tracks.length > 0) {
                    logger.debug(
                        `     [MBID] Found ${tracks.length} tracks for "${criteria.albumTitle}"`
                    );
                }
            }

            // By artist name and album title, ignoring case and accents
            if (tracks.length === 0) {
                tracks = await this.findDiscoverTracksByName(criteria.artistName, criteria.albumTitle);
                if (tracks.length > 0) {
                    logger.debug(
                        `     [NAME] Found ${tracks.length} tracks for "${criteria.albumTitle}"`
                    );
                }
            }

            // By normalised name, for Unicode and special characters
            if (tracks.length === 0) {
                const normalizedArtist = nameWords(criteria.artistName);

                // Albums by this artist, matched on the full normalised name when it
                // has several words: a first word like "the" or "dj" matches too much.
                const artistTokens = normalizedArtist.split(" ").filter(Boolean);
                const artistSearchTerm =
                    artistTokens.length > 1 ? normalizedArtist : artistTokens[0];

                // The artist's name is compared in TypeScript: the database folds case for ASCII only.
                const discoverAlbums = artistSearchTerm
                    ? await prisma.album.findMany({
                          where: { location: "DISCOVER" },
                          select: { id: true, title: true, artist: { select: { name: true } } },
                          orderBy: { title: "asc" },
                      })
                    : [];
                const artistAlbumIds = discoverAlbums
                    .filter((a) => nameWords(a.artist.name).includes(artistSearchTerm))
                    .slice(0, 20)
                    .map((a) => a.id);
                const artistAlbums = await prisma.album.findMany({
                    where: { id: { in: artistAlbumIds } },
                    include: { artist: true, tracks: true },
                    orderBy: { title: "asc" },
                });

                for (const album of artistAlbums) {
                    if (titlesAgree(album.title, criteria.albumTitle)) {
                        tracks = album.tracks.map((t: any) => ({
                            ...t,
                            album: { ...album, artist: album.artist },
                        }));
                        if (tracks.length > 0) {
                            logger.debug(
                                `     [NORMALIZED] Found ${tracks.length} tracks for "${criteria.albumTitle}"`
                            );
                            break;
                        }
                    }
                }
            }

            if (tracks.length === 0) {
                logger.debug(
                    `     [MISS] No tracks found for "${criteria.albumTitle}" by "${criteria.artistName}"`
                );
            }

            allTracks.push(...tracks);
        }

        const uniqueTracks = Array.from(
            new Map(allTracks.map((t) => [t.id, t])).values()
        );
        allTracks = uniqueTracks;

        logger.debug(`   Found ${allTracks.length} tracks from imported albums`);

        if (allTracks.length === 0) {
            logger.debug(
                `   No tracks found after scan - albums may not have imported yet`
            );
            await updateBatchStatus(batchId, {
                status: "failed",
                errorMessage: "No tracks found after scan",
                completedAt: new Date(),
            });
            await discoveryBatchLogger.error(
                batchId,
                "No tracks found after scan"
            );
            return;
        }

        // One random track per album
        const tracksByAlbum = new Map<string, typeof allTracks>();
        for (const track of allTracks) {
            const albumId = track.album.id;
            if (!tracksByAlbum.has(albumId)) {
                tracksByAlbum.set(albumId, []);
            }
            tracksByAlbum.get(albumId)!.push(track);
        }

        const onePerAlbum: typeof allTracks = [];
        for (const tracks of tracksByAlbum.values()) {
            const randomTrack =
                tracks[Math.floor(Math.random() * tracks.length)];
            onePerAlbum.push(randomTrack);
        }

        // Only the albums Discover downloaded: library songs are never mixed into Discover.
        const selected = shuffleArray(onePerAlbum);

        await discoveryBatchLogger.info(
            batchId,
            `Playlist built: ${selected.length} albums`
        );

        const target = batch.targetSongCount; // For logging purposes only
        if (selected.length === 0) {
            logger.debug(`   FAILED: No tracks available for playlist`);
            await discoveryBatchLogger.error(
                batchId,
                `No tracks available for playlist`
            );
        } else if (selected.length < target) {
            logger.debug(
                `   NOTE: Got ${selected.length} tracks (target was ${target}, including ALL successful downloads)`
            );
            await discoveryBatchLogger.info(
                batchId,
                `Got ${selected.length} tracks (target was ${target})`
            );
        } else {
            logger.debug(
                `   SUCCESS: Got ${selected.length} tracks`
            );
        }

        // userId is fixed for the whole build, so read the config once outside the
        // interactive transaction instead of per album, keeping the transaction well
        // inside Postgres's 5 s default.
        const userConfig = await prisma.userDiscoverConfig.findUnique({
            where: { userId: batch.userId },
        });
        const exclusionMonths = userConfig?.exclusionMonths ?? 6;

        let result: { albumCount: number; trackCount: number } | null = null;
        try {
            result = await prisma.$transaction(async (tx) => {
                const createdAlbums = new Map<string, string>();
                let trackCount = 0;

                for (const track of selected) {
                    // Use album ID as the key for deduplication (not MBID)
                    const albumKey = track.album.id;
                    let discoveryAlbumId = createdAlbums.get(albumKey);

                    if (!discoveryAlbumId) {
                        const job = completedJobs.find((j) => {
                            const metadata = j.metadata as any;
                            const jobArtist = (metadata?.artistName || "")
                                .toLowerCase()
                                .trim();
                            const jobAlbum = (metadata?.albumTitle || "")
                                .toLowerCase()
                                .trim();
                            const trackArtist = track.album.artist.name
                                .toLowerCase()
                                .trim();
                            const trackAlbum = track.album.title
                                .toLowerCase()
                                .trim();
                            return (
                                jobArtist === trackArtist &&
                                jobAlbum === trackAlbum
                            );
                        });

                        const metadata = job?.metadata as any;

                        // Keep the tier chosen at selection time; recomputing it from similarity would
                        // turn wildcards back into whatever tier their score falls in.
                        const storedTier =
                            metadata?.tier ||
                            getTierFromSimilarity(metadata?.similarity || 0.5);
                        const storedSimilarity = metadata?.similarity || 0.5;

                        if (!job) {
                            logger.debug(
                                `   [WARN] No job match for: ${track.album.artist.name} - ${track.album.title}`
                            );
                            logger.debug(
                                `     Available jobs: ${completedJobs
                                    .map(
                                        (j) =>
                                            `${
                                                (j.metadata as any)?.artistName
                                            } - ${
                                                (j.metadata as any)?.albumTitle
                                            }`
                                    )
                                    .slice(0, 5)
                                    .join(", ")}...`
                            );
                        } else {
                            logger.debug(
                                `   ✓ Job matched: ${
                                    track.album.artist.name
                                } - ${
                                    track.album.title
                                } (tier: ${storedTier}, similarity: ${(
                                    storedSimilarity * 100
                                ).toFixed(0)}%)`
                            );
                        }

                        const discoveryAlbum = await tx.discoveryAlbum.upsert({
                            where: {
                                userId_weekStartDate_rgMbid: {
                                    userId: batch.userId,
                                    weekStartDate: batch.weekStart,
                                    rgMbid: track.album.rgMbid,
                                },
                            },
                            create: {
                                userId: batch.userId,
                                rgMbid: track.album.rgMbid,
                                artistName: track.album.artist.name,
                                artistMbid: track.album.artist.mbid,
                                albumTitle: track.album.title,
                                lidarrAlbumId: job?.lidarrAlbumId,
                                similarity: storedSimilarity,
                                tier: storedTier,
                                weekStartDate: batch.weekStart,
                                downloadedAt: new Date(),
                                status: "ACTIVE",
                            },
                            update: {
                                artistName: track.album.artist.name,
                                artistMbid: track.album.artist.mbid,
                                albumTitle: track.album.title,
                                lidarrAlbumId: job?.lidarrAlbumId,
                                similarity: storedSimilarity,
                                tier: storedTier,
                                downloadedAt: new Date(),
                            },
                        });

                        discoveryAlbumId = discoveryAlbum.id;
                        createdAlbums.set(albumKey, discoveryAlbumId);

                        if (exclusionMonths > 0) {
                            const expiresAt = new Date();
                            expiresAt.setMonth(
                                expiresAt.getMonth() + exclusionMonths
                            );

                            await tx.discoverExclusion.upsert({
                                where: {
                                    userId_albumMbid: {
                                        userId: batch.userId,
                                        albumMbid: track.album.rgMbid,
                                    },
                                },
                                create: {
                                    userId: batch.userId,
                                    albumMbid: track.album.rgMbid,
                                    artistName: track.album.artist.name,
                                    albumTitle: track.album.title,
                                    expiresAt,
                                },
                                update: {
                                    lastSuggestedAt: new Date(),
                                    expiresAt,
                                },
                            });
                        }
                    }

                    await tx.discoveryTrack.create({
                        data: {
                            discoveryAlbumId,
                            trackId: track.id,
                            fileName: track.filePath.split("/").pop() || "",
                            filePath: track.filePath,
                        },
                    });

                    trackCount++;
                }

                await updateBatchStatus(
                    batchId,
                    {
                        status: "completed",
                        finalSongCount: trackCount,
                        completedAt: new Date(),
                    },
                    {},
                    tx
                );

                return { albumCount: createdAlbums.size, trackCount };
            });
        } catch (txError: any) {
            logger.error(`   ERROR: Transaction failed:`, txError.message);
            logger.error(`   Stack:`, txError.stack);
            await discoveryBatchLogger.error(
                batchId,
                `Transaction failed: ${txError.message}`
            );
            await updateBatchStatus(batchId, {
                status: "failed",
                errorMessage: `Playlist build failed: ${txError.message}`,
                completedAt: new Date(),
            });
        }

        if (result) {
            logger.debug(
                `   Playlist complete: ${result.trackCount} tracks from ${result.albumCount} albums`
            );
            await discoveryBatchLogger.info(
                batchId,
                `Playlist complete: ${result.trackCount} tracks from ${result.albumCount} albums`
            );
        } else {
            logger.error(
                `   ERROR: Transaction returned null - no records created`
            );
            await discoveryBatchLogger.error(
                batchId,
                "Transaction failed - no records created"
            );
        }

        eventBus.emit({
            type: "discover:complete",
            userId: batch.userId,
            payload: { batchId, status: result ? "completed" : "failed" },
        });

        // Runs even when the playlist could not be built.
        await this.cleanupFailedArtists(batchId);

        await this.cleanupOrphanedLidarrQueue(batchId);
    }

    /**
     * Backfill the last 7 days' completed batches with albums that finished
     * downloading after the playlist was built: creates the missing DiscoveryAlbum
     * and DiscoveryTrack rows for albums now in the library.
     */
    async reconcileDiscoveryTracks(): Promise<{
        batchesChecked: number;
        tracksAdded: number;
    }> {
        logger.debug(
            `\n[Discovery Weekly] Reconciling tracks across completed batches...`
        );

        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const completedBatches = await prisma.discoveryBatch.findMany({
            where: {
                status: "completed",
                completedAt: { gte: sevenDaysAgo },
            },
            orderBy: { completedAt: "desc" },
        });

        if (completedBatches.length === 0) {
            logger.debug(`   No completed batches in last 7 days to reconcile`);
            return { batchesChecked: 0, tracksAdded: 0 };
        }

        logger.debug(
            `   Found ${completedBatches.length} completed batch(es) from last 7 days`
        );

        let totalTracksAdded = 0;
        let batchesChecked = 0;

        for (const batch of completedBatches) {
            logger.debug(`   Checking batch ${batch.id}...`);
            batchesChecked++;

            const completedJobs = await prisma.downloadJob.findMany({
                where: {
                    discoveryBatchId: batch.id,
                    status: "completed",
                },
            });

            if (completedJobs.length === 0) {
                logger.debug(`     No completed jobs in batch ${batch.id}`);
                continue;
            }

            logger.debug(
                `     Found ${completedJobs.length} completed download job(s)`
            );

            for (const job of completedJobs) {
                const metadata = job.metadata as any;
                const albumMbid = metadata?.albumMbid || job.targetMbid;
                const artistName = metadata?.artistName;
                const albumTitle = metadata?.albumTitle;

                if (!albumMbid) {
                    logger.debug(
                        `     Skipping job ${job.id} - no album MBID`
                    );
                    continue;
                }

                const existingDiscoveryAlbum =
                    await prisma.discoveryAlbum.findFirst({
                        where: {
                            userId: batch.userId,
                            weekStartDate: batch.weekStart,
                            rgMbid: albumMbid,
                        },
                    });

                if (existingDiscoveryAlbum) {
                    continue;
                }

                logger.debug(
                    `     Album "${albumTitle}" by "${artistName}" missing from Discovery - checking library...`
                );

                // By release-group MBID
                let tracks: any[] = [];
                if (albumMbid) {
                    // Only albums filed as Discover, as in buildFinalPlaylist: a library album is the listener's own.
                    tracks = await prisma.track.findMany({
                        where: {
                        ...NOT_MISSING,
                            album: { rgMbid: albumMbid, location: "DISCOVER" },
                        },
                        include: {
                            album: { include: { artist: true } },
                        },
                    });
                    if (tracks.length > 0) {
                        logger.debug(
                            `       [MBID] Found ${tracks.length} tracks in library`
                        );
                    }
                }

                // By artist name and album title, ignoring case and accents
                if (tracks.length === 0 && artistName && albumTitle) {
                    logger.debug(
                        `       [NAME] Trying name-based search: "${artistName}" - "${albumTitle}"`
                    );
                    tracks = await this.findDiscoverTracksByName(artistName, albumTitle);
                    if (tracks.length > 0) {
                        logger.debug(
                            `       [NAME] Found ${tracks.length} tracks in library`
                        );
                    }
                }

                if (tracks.length === 0) {
                    logger.debug(
                        `       No tracks found in library - album may not have imported yet`
                    );
                    continue;
                }

                const album = tracks[0].album;
                const similarity = metadata?.similarity || 0.5;
                const tier =
                    metadata?.tier || getTierFromSimilarity(similarity);

                logger.debug(
                    `       ✓ Creating Discovery records for ${tracks.length} track(s)...`
                );

                try {
                    await prisma.$transaction(async (tx) => {
                        // Scan completion and reconciliation can both reach the same album in one week;
                        // upsert keeps the unique constraint from rolling back the whole transaction.
                        // An existing row keeps its status and downloadedAt; the loop below adds missing tracks.
                        const discoveryAlbum = await tx.discoveryAlbum.upsert({
                            where: {
                                userId_weekStartDate_rgMbid: {
                                    userId: batch.userId,
                                    weekStartDate: batch.weekStart,
                                    rgMbid: album.rgMbid,
                                },
                            },
                            create: {
                                userId: batch.userId,
                                rgMbid: album.rgMbid,
                                artistName: album.artist.name,
                                artistMbid: album.artist.mbid,
                                albumTitle: album.title,
                                lidarrAlbumId: job.lidarrAlbumId,
                                similarity,
                                tier,
                                weekStartDate: batch.weekStart,
                                downloadedAt: new Date(),
                                status: "ACTIVE",
                            },
                            update: {},
                        });

                        for (const track of tracks) {
                            const existingTrack =
                                await tx.discoveryTrack.findFirst({
                                    where: {
                                        discoveryAlbumId: discoveryAlbum.id,
                                        trackId: track.id,
                                    },
                                });

                            if (!existingTrack) {
                                await tx.discoveryTrack.create({
                                    data: {
                                        discoveryAlbumId: discoveryAlbum.id,
                                        trackId: track.id,
                                        fileName:
                                            track.filePath.split("/").pop() ||
                                            "",
                                        filePath: track.filePath,
                                    },
                                });
                                totalTracksAdded++;
                            }
                        }
                    });

                    logger.debug(
                        `       ✓ Added ${tracks.length} track(s) to Discovery Weekly`
                    );
                } catch (error: any) {
                    logger.error(
                        `       ✗ Failed to create Discovery records: ${error.message}`
                    );
                }
            }
        }

        logger.debug(
            `   Reconciliation complete: ${totalTracksAdded} tracks added across ${batchesChecked} batches`
        );

        return {
            batchesChecked,
            tracksAdded: totalTracksAdded,
        };
    }

    /** Remove this batch's Lidarr queue items whose albums did not make the final playlist. */
    private async cleanupOrphanedLidarrQueue(batchId: string): Promise<void> {
        logger.debug(`\n[CLEANUP] Checking for orphaned Lidarr queue items...`);

        try {
            const batch = await prisma.discoveryBatch.findUnique({
                where: { id: batchId },
                include: { jobs: true },
            });

            if (!batch) return;

            const settings = await getSystemSettings();
            if (!isLidarrConfigured(settings)) {
                return;
            }

            const ourDownloadIds = new Set<string>();
            for (const job of batch.jobs) {
                if (job.lidarrRef) {
                    ourDownloadIds.add(job.lidarrRef);
                }
            }

            if (ourDownloadIds.size === 0) {
                logger.debug(`   No download IDs to check`);
                return;
            }

            let removed = 0;
            for (const item of await lidarrService.getQueueItems()) {
                if (!ourDownloadIds.has(item.downloadId)) continue;
                const stuck =
                    item.status === "warning" ||
                    item.status === "failed" ||
                    item.trackedDownloadState === "importFailed" ||
                    item.trackedDownloadState === "importBlocked";
                if (
                    stuck &&
                    (await removeFailedDownload(item.downloadId, "Discover batch finished", {
                        searchAgain: false,
                        item,
                    }))
                ) {
                    removed++;
                }
            }

            if (removed > 0) {
                logger.debug(`   Cleaned up ${removed} orphaned queue item(s)`);
            } else {
                logger.debug(`   No orphaned queue items found`);
            }
        } catch (error: any) {
            logger.error(
                `[CLEANUP] Error cleaning orphaned queue:`,
                error.message
            );
        }
    }

    /**
     * Remove from Lidarr the Discover-tagged artists with no successful download in
     * this batch and no active album from another week; lidarrRemoval decides files.
     */
    private async cleanupFailedArtists(batchId: string): Promise<void> {
        logger.debug(
            `\n[CLEANUP] Tag-based cleanup for failed discovery artists...`
        );

        const batch = await prisma.discoveryBatch.findUnique({
            where: { id: batchId },
            include: { jobs: true },
        });

        if (!batch) return;

        const successfulArtistMbids = new Set<string>();
        for (const job of batch.jobs) {
            if (job.status === "completed") {
                const metadata = job.metadata as any;
                if (metadata?.artistMbid) {
                    successfulArtistMbids.add(metadata.artistMbid);
                }
            }
        }

        logger.debug(
            `   ${successfulArtistMbids.size} artists had successful downloads`
        );

        const discoveryArtists = await lidarrService.getDiscoveryArtists();
        logger.debug(
            `   ${discoveryArtists.length} artists in Lidarr have discovery tag`
        );

        let removed = 0;
        let kept = 0;

        for (const lidarrArtist of discoveryArtists) {
            const artistMbid = lidarrArtist.foreignArtistId;
            const artistName = lidarrArtist.artistName;

            if (!artistMbid) continue;

            if (successfulArtistMbids.has(artistMbid)) {
                kept++;
                continue;
            }

            const hasActiveOther = await prisma.discoveryAlbum.findFirst({
                where: {
                    artistMbid,
                    status: "ACTIVE",
                    weekStartDate: { not: batch.weekStart },
                },
            });

            if (hasActiveOther) {
                logger.debug(
                    `   Keeping ${artistName} - has active albums from other batches`
                );
                kept++;
                continue;
            }

            if (await removeDiscoveryArtist(lidarrArtist)) {
                logger.debug(`Removed: ${artistName}`);
                removed++;
            } else {
                kept++;
            }
        }

        logger.debug(`   Cleanup complete: ${removed} removed, ${kept} kept`);
        await discoveryBatchLogger.info(
            batchId,
            `Lidarr cleanup: ${removed} failed artists removed`
        );
    }

    /** Discovery looks for new artists, so one already in the user's library is skipped. */
    private async isArtistInLibrary(
        artistName: string,
        artistMbid: string | undefined
    ): Promise<boolean> {
        if (isMbid(artistMbid)) {
            const byMbid = await prisma.artist.findFirst({
                where: { mbid: artistMbid },
                include: { albums: { take: 1 } },
            });
            if (byMbid && byMbid.albums.length > 0) {
                logger.debug(
                    `     [LIBRARY] ${artistName} IN LIBRARY (matched by MBID, ${byMbid.albums.length} album(s))`
                );
                return true;
            }
        }

        const byName = await prisma.artist.findFirst({
            where: artistNamed(artistName),
            include: { albums: { take: 1 } },
        });

        if (byName !== null && byName.albums.length > 0) {
            logger.debug(
                `     [LIBRARY] ${artistName} IN LIBRARY (matched by name, ${byName.albums.length} album(s))`
            );
            return true;
        }

        return false;
    }

    /** Owned under another id: same artist name once folded, and agreeing titles. */
    private async isAlbumOwnedByName(
        artistName: string,
        albumTitle: string
    ): Promise<boolean> {
        const wantedArtist = normalizeArtistName(artistName);
        if (!wantedArtist) return false;
        const sameArtist = (name: string) => normalizeArtistName(name) === wantedArtist;

        const { albums, ownedAlbumArtists, albumTitleByRgMbid } =
            await discoverySeeding.getOwnedAlbumIndex();

        const owned =
            albums.some((a) => sameArtist(a.artistName) && titlesAgree(a.title, albumTitle)) ||
            ownedAlbumArtists.some((o) => {
                const title = albumTitleByRgMbid.get(o.rgMbid);
                return !!title && sameArtist(o.artistName) && titlesAgree(title, albumTitle);
            });
        if (owned) {
            logger.debug(`     [OWNED-NAME] Found "${albumTitle}" by "${artistName}"`);
        }
        return owned;
    }

    /** Whether the album was recommended in the last six months. */
    private async isAlbumExcluded(
        albumMbid: string,
        userId: string
    ): Promise<boolean> {
        const exclusion = await prisma.discoverExclusion.findFirst({
            where: {
                userId,
                albumMbid,
                expiresAt: { gt: new Date() },
            },
        });
        return !!exclusion;
    }

    /**
     * Whether an album is a valid, not-owned, not-excluded candidate. The three
     * independent lookups run concurrently; a check that throws means "not valid".
     */
    private async isValidUnownedAlbum(
        albumMbid: string,
        userId: string,
        artistName: string,
        albumTitle: string
    ): Promise<{ valid: boolean; reason: "owned" | "excluded" | "error" | null }> {
        const ERROR = Symbol("error");
        const [owned, ownedByName, excluded] = await Promise.all([
            discoverySeeding
                .isAlbumOwned(albumMbid, userId, artistName, albumTitle)
                .catch(() => ERROR),
            this.isAlbumOwnedByName(artistName, albumTitle).catch(() => ERROR),
            this.isAlbumExcluded(albumMbid, userId).catch(() => ERROR),
        ]);

        if (owned === ERROR || ownedByName === ERROR || excluded === ERROR) {
            return { valid: false, reason: "error" };
        }
        if (owned || ownedByName) {
            return { valid: false, reason: "owned" };
        }
        if (excluded) {
            return { valid: false, reason: "excluded" };
        }
        return { valid: true, reason: null };
    }

    private async findValidAlbumForArtist(
        artist: any,
        userId: string,
        seenAlbums: Set<string>
    ): Promise<{
        recommendation: RecommendedAlbum | null;
        albumsChecked: number;
        skippedNoMbid: number;
        skippedOwned: number;
        skippedExcluded: number;
        skippedDuplicate: number;
    }> {
        const MIN_TRACK_COUNT = 7; // Filter out EPs
        const RECENT_YEARS = 5; // Prefer albums from last 5 years
        const currentYear = new Date().getFullYear();

        let albumsChecked = 0;
        let skippedNoMbid = 0;
        let skippedOwned = 0;
        let skippedExcluded = 0;
        let skippedDuplicate = 0;

        try {
            // Albums from MusicBrainz release groups, browsed by MBID; no MBID, no albums.
            let topAlbums: Array<{ name: string; mbid: string }> = [];
            if (artist.mbid) {
                const rgs = await musicBrainzService.getReleaseGroups(
                    artist.mbid,
                    ["album"],
                    10
                );
                if (rgs.kind === "answered") {
                    topAlbums = rgs.value.map((rg) => ({
                        name: rg.title,
                        mbid: rg.id,
                    }));
                } else if (rgs.kind !== "absent") {
                    logger.debug(
                        `      [SKIP] ${artist.name}: ${failureCause(rgs)}`
                    );
                }
            }

            if (topAlbums.length === 0) {
                return {
                    recommendation: null,
                    albumsChecked: 0,
                    skippedNoMbid: 0,
                    skippedOwned: 0,
                    skippedExcluded: 0,
                    skippedDuplicate: 0,
                };
            }

            const scoredAlbums: Array<{
                albumName: string;
                albumMbid: string;
                score: number;
                releaseYear: number;
                trackCount: number;
            }> = [];

            for (const album of topAlbums) {
                albumsChecked++;

                const mbAlbum = { id: album.mbid, title: album.name };

                if (seenAlbums.has(mbAlbum.id)) {
                    skippedDuplicate++;
                    continue;
                }

                const details = await musicBrainzService.getAlbumDetails(mbAlbum.id);
                if (details.kind !== "answered") {
                    // "Absent" is the honest no-data case; a failed
                    // lookup is logged with its cause. Both skip this
                    // album — the next one gets asked.
                    skippedNoMbid++;
                    if (details.kind !== "absent") {
                        logger.debug(
                            `      [SKIP] ${album.name}: ${failureCause(details)}`
                        );
                    }
                    continue;
                }

                if (details.value.primaryType !== 'Album') {
                    continue;
                }
                if (details.value.secondaryTypes?.includes('Live')) {
                    continue;
                }
                if (details.value.secondaryTypes?.includes('Compilation')) {
                    continue;
                }

                if (
                    details.value.trackCount &&
                    details.value.trackCount < MIN_TRACK_COUNT
                ) {
                    logger.debug(`      [SKIP] ${album.name} - only ${details.value.trackCount} tracks (EP)`);
                    continue;
                }

                const candidate = await this.isValidUnownedAlbum(
                    mbAlbum.id,
                    userId,
                    artist.name,
                    album.name
                );
                if (!candidate.valid) {
                    if (candidate.reason === "owned") {
                        skippedOwned++;
                    } else if (candidate.reason === "excluded") {
                        skippedExcluded++;
                    }
                    continue;
                }

                let score = 0;

                // Recent albums get bonus (last 5 years)
                const releaseYear = details.value.releaseDate
                    ? parseInt(details.value.releaseDate.split('-')[0])
                    : 0;
                if (releaseYear >= currentYear - RECENT_YEARS) {
                    score += 10;
                }

                scoredAlbums.push({
                    albumName: album.name,
                    albumMbid: mbAlbum.id,
                    score,
                    releaseYear,
                    trackCount: details.value.trackCount || 0,
                });
            }

            if (scoredAlbums.length === 0) {
                return {
                    recommendation: null,
                    albumsChecked,
                    skippedNoMbid,
                    skippedOwned,
                    skippedExcluded,
                    skippedDuplicate,
                };
            }

            scoredAlbums.sort((a, b) => b.score - a.score);

            const best = scoredAlbums[0];
            seenAlbums.add(best.albumMbid);

            logger.debug(`      [SELECTED] ${best.albumName} (${best.releaseYear}, ${best.trackCount} tracks, score: ${best.score.toFixed(1)})`);

            return {
                recommendation: {
                    artistName: artist.name,
                    artistMbid: artist.mbid,
                    albumTitle: best.albumName,
                    albumMbid: best.albumMbid,
                    similarity: artist.avgMatch || artist.match || 0.5,
                },
                albumsChecked,
                skippedNoMbid,
                skippedOwned,
                skippedExcluded,
                skippedDuplicate,
            };
        } catch (error: any) {
            logger.warn(
                `   Failed to get albums for ${artist.name}: ${error.message}`
            );
        }

        return {
            recommendation: null,
            albumsChecked,
            skippedNoMbid,
            skippedOwned,
            skippedExcluded,
            skippedDuplicate,
        };
    }

    /** False when the recent picks and this candidate are all closely similar, so playlists do not run five shoegaze bands in a row. */
    private checkVariety(
        candidate: any,
        recentPicks: RecommendedAlbum[],
        lookbackWindow: number
    ): boolean {
        if (recentPicks.length < lookbackWindow) return true;

        const recentWindow = recentPicks.slice(-lookbackWindow);
        const avgRecentSimilarity = recentWindow.reduce((sum, p) => sum + p.similarity, 0) / recentWindow.length;

        const SIMILARITY_CLUSTER_THRESHOLD = 0.70;

        const recentAreClusteredHigh = avgRecentSimilarity >= SIMILARITY_CLUSTER_THRESHOLD;
        const candidateIsHigh = (candidate.avgMatch || candidate.match || 0) >= SIMILARITY_CLUSTER_THRESHOLD;

        if (recentAreClusteredHigh && candidateIsHigh) {
            logger.debug(`      [VARIETY] Skipping ${candidate.name} - too similar to recent picks (${(avgRecentSimilarity * 100).toFixed(0)}% avg)`);
            return false;
        }

        return true;
    }

    /**
     * Deep Cuts Strategy - Exploratory picks from seed adjacency.
     * Finds artists at 20-35% similarity - still connected but more adventurous.
     */
    private async deepCutsStrategy(
        seeds: SeedArtist[],
        targetCount: number,
        seenAlbums: Set<string>,
        userId: string
    ): Promise<RecommendedAlbum[]> {
        logger.debug(`\n[STRATEGY] Deep Cuts - finding adjacent artists from seeds`);

        const recommendations: RecommendedAlbum[] = [];
        const seenArtists = new Set<string>();

        for (const seed of seeds) {
            if (recommendations.length >= targetCount) break;

            try {
                const similar = await getSimilarArtists(
                    seed.mbid || '',
                    seed.name,
                    50 // Fetch more to find low-similarity matches
                );

                const deepCuts = similar.filter(
                    (a) => (a.match || 0) >= TIER_THRESHOLDS.deepCutMin && (a.match || 0) <= TIER_THRESHOLDS.deepCutMax
                );

                logger.debug(`   ${seed.name}: ${deepCuts.length} deep cuts found`);

                for (const artist of shuffleArray(deepCuts)) {
                    if (recommendations.length >= targetCount) break;

                    const key = artist.name.toLowerCase();
                    if (seenArtists.has(key)) continue;

                    const inLibrary = await this.isArtistInLibrary(artist.name, artist.mbid);
                    if (inLibrary) continue;

                    const result = await this.findValidAlbumForArtist(artist, userId, seenAlbums);

                    if (result.recommendation) {
                        seenArtists.add(key);
                        result.recommendation.tier = 'wildcard';
                        result.recommendation.similarity = artist.match || 0.25;
                        recommendations.push(result.recommendation);

                        logger.debug(`    ✓ [DEEP CUT] ${artist.name} - ${result.recommendation.albumTitle} (${((artist.match || 0) * 100).toFixed(0)}%)`);
                    }
                }
            } catch (error: any) {
                logger.error(`   Failed to get deep cuts for ${seed.name}: ${error.message}`);
            }

            if (recommendations.length < targetCount) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        logger.debug(`   Found ${recommendations.length} deep cut recommendations`);
        return recommendations;
    }

    /** Tier targets from the candidates available; a short tier's deficit moves to the tiers below it. */
    private calculateDynamicTierDistribution(
        targetCount: number,
        tierCandidates: {
            high: number;
            medium: number;
            explore: number;
        }
    ): {
        high: number;
        medium: number;
        explore: number;
        wildcard: number;
    } {
        const wildcardCount = Math.max(1, Math.ceil(targetCount * TIER_DISTRIBUTION.wildcard));
        const similarArtistTarget = targetCount - wildcardCount;

        let highTarget = Math.ceil(similarArtistTarget * (TIER_DISTRIBUTION.high / 0.9));
        let mediumTarget = Math.ceil(similarArtistTarget * (TIER_DISTRIBUTION.medium / 0.9));
        let exploreTarget = similarArtistTarget - highTarget - mediumTarget;

        const adjustments = { high: 0, medium: 0, explore: 0 };

        if (tierCandidates.high < highTarget) {
            const deficit = highTarget - tierCandidates.high;
            adjustments.high = -deficit;
            highTarget = tierCandidates.high;

            // Redistribute to medium (60%) and explore (40%)
            adjustments.medium += Math.floor(deficit * 0.6);
            adjustments.explore += Math.ceil(deficit * 0.4);
        }

        const adjustedMediumTarget = mediumTarget + adjustments.medium;
        if (tierCandidates.medium < adjustedMediumTarget) {
            const deficit = adjustedMediumTarget - tierCandidates.medium;
            adjustments.medium = tierCandidates.medium - mediumTarget;

            // Redistribute to explore
            adjustments.explore += deficit;
        }

        mediumTarget = Math.max(0, mediumTarget + adjustments.medium);
        exploreTarget = Math.max(0, exploreTarget + adjustments.explore);

        exploreTarget = Math.min(exploreTarget, tierCandidates.explore);

        logger.debug(`[DISCOVERY] Dynamic distribution: ${highTarget} high, ${mediumTarget} medium, ${exploreTarget} explore, ${wildcardCount} wildcard`);
        if (adjustments.high !== 0 || adjustments.medium !== 0 || adjustments.explore !== 0) {
            logger.debug(`   Adjustments made due to insufficient candidates`);
        }

        return {
            high: highTarget,
            medium: mediumTarget,
            explore: exploreTarget,
            wildcard: wildcardCount,
        };
    }

    /** Scores an artist by how many seeds list it: several seeds recommending it is the stronger signal. */
    private scoreArtistsByCrossSeedFrequency(
        similarCache: Map<string, any[]>
    ): Array<{
        name: string;
        mbid?: string;
        avgMatch: number;
        crossSeedCount: number;
        maxMatch: number;
    }> {
        const artistFrequency = new Map<string, {
            name: string;
            mbid?: string;
            matches: number[];
        }>();

        for (const [, similar] of similarCache.entries()) {
            for (const artist of similar) {
                const key = artist.mbid || artist.name.toLowerCase();

                if (!artistFrequency.has(key)) {
                    artistFrequency.set(key, {
                        name: artist.name,
                        mbid: artist.mbid,
                        matches: [],
                    });
                }

                artistFrequency.get(key)!.matches.push(artist.match || 0.5);
            }
        }

        const scored = Array.from(artistFrequency.values()).map(artist => ({
            name: artist.name,
            mbid: artist.mbid,
            avgMatch: artist.matches.reduce((sum, m) => sum + m, 0) / artist.matches.length,
            maxMatch: Math.max(...artist.matches),
            crossSeedCount: artist.matches.length,
        }));

        scored.sort((a, b) => {
            if (b.crossSeedCount !== a.crossSeedCount) {
                return b.crossSeedCount - a.crossSeedCount;
            }
            return b.avgMatch - a.avgMatch;
        });

        logger.debug(`[DISCOVERY] Cross-seed scored ${scored.length} unique artists`);
        if (scored.length > 0) {
            logger.debug(`   Top artist: ${scored[0].name} (${scored[0].crossSeedCount} seeds, ${(scored[0].avgMatch * 100).toFixed(0)}% avg match)`);
        }

        return scored;
    }

    /**
     * Tier-based recommendations: 30% High, 40% Medium, 20% Explore from similar
     * artists, and 10% deep-cut wildcards.
     */
    async findRecommendedAlbumsMultiStrategy(
        seeds: SeedArtist[],
        similarCache: Map<string, any[]>,
        targetCount: number,
        userId: string
    ): Promise<RecommendedAlbum[]> {
        const seenAlbums = new Set<string>();
        const seenArtists = new Set<string>();
        const recommendations: RecommendedAlbum[] = [];

        logger.debug(`\n[DISCOVERY] Cross-Seed + Tier-Based Selection`);
        logger.debug(`   Target: ${targetCount} albums`);
        logger.debug(
            `   Distribution: 30% high, 40% medium, 20% explore, 10% wildcard`
        );

        const scoredArtists = this.scoreArtistsByCrossSeedFrequency(similarCache);

        // Tier by average match across all seeds
        const byTier = {
            high: scoredArtists.filter((a) => a.avgMatch >= TIER_THRESHOLDS.high),
            medium: scoredArtists.filter(
                (a) => a.avgMatch >= TIER_THRESHOLDS.medium && a.avgMatch < TIER_THRESHOLDS.high
            ),
            explore: scoredArtists.filter(
                (a) => a.avgMatch >= TIER_THRESHOLDS.explore && a.avgMatch < TIER_THRESHOLDS.medium
            ),
        };

        logger.debug(`[DISCOVERY] Filtered to artists above ${TIER_THRESHOLDS.minimum} minimum threshold`);

        logger.debug(
            `   Available: ${byTier.high.length} high, ${byTier.medium.length} medium, ${byTier.explore.length} explore`
        );

        const distribution = this.calculateDynamicTierDistribution(targetCount, {
            high: byTier.high.length,
            medium: byTier.medium.length,
            explore: byTier.explore.length,
        });

        const highCount = distribution.high;
        const mediumCount = distribution.medium;
        const exploreCount = distribution.explore;
        const wildcardCount = distribution.wildcard;
        const similarArtistTarget = targetCount - wildcardCount;

        for (const [tierName, artists] of Object.entries(byTier)) {
            if (artists.length === 0) continue;
            const sample = artists
                .slice(0, 3)
                .map((a) => `${a.name}(${(a.avgMatch * 100).toFixed(0)}%,${a.crossSeedCount}x)`)
                .join(", ");
            logger.debug(`   ${tierName.toUpperCase()} tier sample: ${sample}`);
        }

        // Shuffle each tier for variety week-to-week
        byTier.high = shuffleArray(byTier.high);
        byTier.medium = shuffleArray(byTier.medium);
        byTier.explore = shuffleArray(byTier.explore);

        const VARIETY_LOOKBACK = 2;

        const isOwnedArtist = async (artist: any): Promise<boolean> => {
            try {
                return await this.isArtistInLibrary(artist.name, artist.mbid);
            } catch {
                // A failed lookup counts as not owned, so the candidate stays in the pool.
                return false;
            }
        };

        const selectFromTier = async (
            tier: any[],
            count: number,
            tierName: "high" | "medium" | "explore"
        ): Promise<RecommendedAlbum[]> => {
            const selected: RecommendedAlbum[] = [];

            for (const artist of tier) {
                if (selected.length >= count) break;

                const key = artist.name.toLowerCase();
                if (seenArtists.has(key)) continue;

                if (!this.checkVariety(artist, [...recommendations, ...selected], VARIETY_LOOKBACK)) {
                    continue;
                }

                if (await isOwnedArtist(artist)) {
                    logger.debug(`      [SKIP] ${artist.name} - in library`);
                    continue;
                }

                const result = await this.findValidAlbumForArtist(
                    artist,
                    userId,
                    seenAlbums
                );

                if (result.recommendation) {
                    seenArtists.add(key);
                    result.recommendation.tier = tierName;
                    result.recommendation.similarity =
                        artist.avgMatch || result.recommendation.similarity;
                    selected.push(result.recommendation);
                    logger.debug(
                        `    ✓ [${tierName.toUpperCase()}] ${artist.name} - ${
                            result.recommendation.albumTitle
                        } (${((artist.avgMatch || 0) * 100).toFixed(0)}%, ${artist.crossSeedCount}x)`
                    );
                }
            }

            return selected;
        };

        const fillFromRemaining = async (
            label: string,
            skipOwnedArtists: boolean
        ): Promise<void> => {
            const remaining = [
                ...byTier.high,
                ...byTier.medium,
                ...byTier.explore,
            ].filter((a) => !seenArtists.has(a.name.toLowerCase()));

            for (const artist of shuffleArray(remaining)) {
                if (recommendations.length >= similarArtistTarget) break;

                const key = artist.name.toLowerCase();
                if (seenArtists.has(key)) continue;

                if (skipOwnedArtists && (await isOwnedArtist(artist))) {
                    logger.debug(`      [SKIP] ${artist.name} - in library`);
                    continue;
                }

                const result = await this.findValidAlbumForArtist(
                    artist,
                    userId,
                    seenAlbums
                );
                if (result.recommendation) {
                    seenArtists.add(key);
                    const similarity =
                        artist.avgMatch || result.recommendation.similarity;
                    result.recommendation.tier = getTierFromSimilarity(similarity);
                    result.recommendation.similarity = similarity;
                    recommendations.push(result.recommendation);
                    logger.debug(
                        `    ✓ [${label}] ${artist.name} - ${
                            result.recommendation.albumTitle
                        } (${((artist.avgMatch || 0) * 100).toFixed(0)}%, ${artist.crossSeedCount}x)`
                    );
                }
            }
        };

        logger.debug(`\n   === Selecting from HIGH tier ===`);
        const highPicks = await selectFromTier(byTier.high, highCount, "high");
        recommendations.push(...highPicks);

        logger.debug(`\n   === Selecting from MEDIUM tier ===`);
        const mediumPicks = await selectFromTier(
            byTier.medium,
            mediumCount,
            "medium"
        );
        recommendations.push(...mediumPicks);

        logger.debug(`\n   === Selecting from EXPLORE tier ===`);
        const explorePicks = await selectFromTier(
            byTier.explore,
            exploreCount,
            "explore"
        );
        recommendations.push(...explorePicks);

        if (recommendations.length < similarArtistTarget) {
            logger.debug(
                `\n   === Filling remaining slots (NEW artists only) ===`
            );
            await fillFromRemaining("FILL", true);
        }

        if (recommendations.length < similarArtistTarget) {
            logger.debug(
                `\n   === FALLBACK: Existing artists with NEW albums ===`
            );
            logger.debug(
                `   Need ${
                    similarArtistTarget - recommendations.length
                } more recommendations`
            );
            await fillFromRemaining("EXISTING", false);
        }

        logger.debug(
            `\n   === Adding ${wildcardCount} DEEP CUT picks ===`
        );
        const wildcards = await this.deepCutsStrategy(
            seeds,
            wildcardCount,
            seenAlbums,
            userId
        );
        for (const wc of wildcards) {
            wc.tier = "wildcard";
            recommendations.push(wc);
        }

        const tierCounts = {
            high: recommendations.filter((r) => r.tier === "high").length,
            medium: recommendations.filter((r) => r.tier === "medium").length,
            explore: recommendations.filter((r) => r.tier === "explore").length,
            wildcard: recommendations.filter((r) => r.tier === "wildcard")
                .length,
        };

        logger.debug(`\n[DISCOVERY] Final: ${recommendations.length} albums`);
        logger.debug(
            `   High: ${tierCounts.high}, Medium: ${tierCounts.medium}, Explore: ${tierCounts.explore}, Wildcard: ${tierCounts.wildcard}`
        );

        return recommendations.slice(0, targetCount);
    }
}

export const discoverWeeklyService = new DiscoverWeeklyService();
