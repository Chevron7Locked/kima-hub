/**
 * Discovery Weekly Service (Refactored)
 *
 * Generates weekly discovery playlists using Last.fm recommendations,
 * downloads via Lidarr, and only shows songs after successful import.
 *
 * Key improvements:
 * - Prisma transactions for atomic operations
 * - Pre-fetched and cached recommendations
 * - Structured logging with batch logs field
 * - No dynamic imports
 */

import { logger } from "../utils/logger";
import { normalizeArtistName } from "../utils/artistNormalization";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import axios from "axios";
import { lastFmService } from "./lastfm";
import { musicBrainzService } from "./musicbrainz";
import { updateBatchStatus } from "./discovery/optimisticBatchUpdate";
import { lidarrService } from "./lidarr";
import { scanQueue } from "../workers/queues";
import { startOfWeek, subWeeks } from "date-fns";
import { getSystemSettings } from "../utils/systemSettings";
import { discoveryLogger } from "./discoveryLogger";
import { acquisitionService } from "./acquisitionService";
import {
    discoveryBatchLogger,
    discoveryAlbumLifecycle,
    discoverySeeding,
} from "./discovery";
import { shuffleArray } from "../utils/shuffle";
import { updateArtistCounts } from "./artistCountsService";
import { config as appConfig } from "../config";
import { eventBus } from "./eventBus";

interface SeedArtist {
    name: string;
    mbid?: string;
}

interface RecommendedAlbum {
    artistName: string;
    artistMbid?: string;
    albumTitle: string;
    albumMbid: string;
    similarity: number;
    tier?: "high" | "medium" | "explore" | "wildcard";
}

// Tier distribution for variety in recommendations
// This ensures each playlist has a mix of similarity levels
const TIER_DISTRIBUTION = {
    high: 0.3, // 30% from very similar artists (>=65% match)
    medium: 0.4, // 40% from moderately similar (50-65% match)
    explore: 0.2, // 20% from stretch picks (35-50% match)
    wildcard: 0.1, // 10% from deep cuts (variety)
};

// Tier thresholds calibrated to Last.fm's actual score distribution (typically 0.5-0.7 range)
const TIER_THRESHOLDS = {
    high: 0.65,    // >=65% match
    medium: 0.50,  // 50-65% match
    explore: 0.35, // 35-50% match
    minimum: 0.35, // Don't recommend anything below this
};

interface BatchLogEntry {
    timestamp: string;
    level: "info" | "warn" | "error";
    message: string;
}

/**
 * Calculate tier from Last.fm similarity score
 * Last.fm typically returns scores in 0.5-0.7 range for similar artists
 * Adjusted thresholds calibrated to actual Last.fm distribution:
 * - High Match: >=65% (0.65-1.0)
 * - Medium Match: 50-65% (0.50-0.64)
 * - Explore: 35-50% (0.35-0.49)
 * - Wild Card: <35% (0-0.34) or explicitly set
 */
function getTierFromSimilarity(
    similarity: number
): "high" | "medium" | "explore" | "wildcard" {
    if (similarity >= TIER_THRESHOLDS.high) return "high";
    if (similarity >= TIER_THRESHOLDS.medium) return "medium";
    if (similarity >= TIER_THRESHOLDS.explore) return "explore";
    return "wildcard";
}

export class DiscoverWeeklyService {
    /**
     * Main entry: Generate Discovery Weekly
     */
    async generatePlaylist(userId: string, jobId?: number) {
        // Start a dedicated log file for this generation
        const logPath = discoveryLogger.start(userId, jobId);
        discoveryLogger.info(`Log file: ${logPath}`);

        try {
            discoveryLogger.section("CONFIGURATION CHECK");
            const settings = await getSystemSettings();

            const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });

            // Get user config
            const config = await prisma.userDiscoverConfig.findUnique({
                where: { userId },
            });

            if (!config || !config.enabled) {
                discoveryLogger.error("Discovery Weekly not enabled for user");
                discoveryLogger.end(false, "Not enabled");
                throw new Error("Discovery Weekly not enabled");
            }

            // Get download ratio from config (default 1.3)
            const downloadRatio = config.downloadRatio ?? 1.3;

            discoveryLogger.table({
                "Target Songs": config.playlistSize,
                "Download Ratio": `${downloadRatio}x`,
                "Week Start": weekStart.toISOString().split("T")[0],
            });

            // CRITICAL: Process previous week's liked albums before generating new ones
            discoveryLogger.section("PROCESSING PREVIOUS WEEK");
            await discoveryAlbumLifecycle.processBeforeGeneration(userId, settings);

            const targetCount = config.playlistSize;

            // Step 1: Get seed artists
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

            // Step 2: Pre-fetch and cache similar artists (parallel with rate limiting)
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

            // Step 3: Find recommended albums using multi-strategy discovery
            // REQUEST MORE ALBUMS than target to account for download failures
            // User configurable ratio (default 1.3x) to control bandwidth usage
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

            // MINIMUM THRESHOLD CHECK: Ensure we have enough candidates
            // We need at least targetCount albums, ideally more for variety
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

            // Step 4: Create batch and jobs in a transaction
            discoveryLogger.section("STEP 4: CREATE BATCH & JOBS");

            // Get music path from settings (already fetched at line 276) with fallback to app config
            const musicPath = settings?.musicPath || appConfig.music.musicPath;

            const batch = await prisma.$transaction(async (tx) => {
                // Create discovery batch
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

                // Create all download jobs in the same transaction
                for (const album of recommended) {
                    // Ensure similarity is a valid number
                    const similarity =
                        typeof album.similarity === "number" &&
                        !isNaN(album.similarity)
                            ? album.similarity
                            : 0.5;

                    // Check for existing pending/processing job to avoid duplicates
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
                                rootFolderPath: musicPath,
                                artistName: album.artistName,
                                artistMbid: album.artistMbid,
                                albumTitle: album.albumTitle,
                                albumMbid: album.albumMbid,
                                similarity: similarity,
                                tier: album.tier,
                            },
                        },
                    });
                }

                return newBatch;
            });
            discoveryLogger.success(
                `Created ${recommended.length} download jobs`
            );

            // Step 5: Start downloads outside transaction (they involve external APIs)
            discoveryLogger.section("STEP 5: START DOWNLOADS");
            let downloadsStarted = 0;
            let downloadsFailed = 0;

            const jobs = await prisma.downloadJob.findMany({
                where: { discoveryBatchId: batch.id },
            });

            // Process albums through acquisition service queue
            // The acquisitionService has an internal queue that respects the user's soulseekConcurrentDownloads setting
            discoveryLogger.info(
                `Processing ${jobs.length} albums (concurrency controlled by acquisition service)`,
                1
            );

            // Helper to process a single job
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
                            lastfmUrl: undefined,
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

            // Process all jobs - acquisitionService internal queue handles concurrency
            const promises = jobs.map((job, index) => processJob(job, index));
            await Promise.allSettled(promises);

            // Log batch completion summary
            logger.info(`[Discover] Batch complete: ${downloadsStarted} succeeded, ${downloadsFailed} failed`);

            // After all download attempts, check if batch should be completed
            // This handles cases where downloads fail before webhooks are triggered
            if (downloadsStarted === 0 || downloadsFailed > 0) {
                logger.debug(`[Discovery] Checking batch completion (started: ${downloadsStarted}, failed: ${downloadsFailed})`);
                await this.checkBatchCompletion(batch.id);
            }

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

            return {
                success: true,
                playlistName: `Discover Weekly (Week of ${weekStart.toLocaleDateString()})`,
                songCount: 0,
                batchId: batch.id,
            };
        } catch (error: any) {
            discoveryLogger.error(`Generation failed: ${error.message}`);
            discoveryLogger.end(false, error.message);
            throw error;
        }
    }

    /**
     * Pre-fetch similar artists for all seeds (parallel with rate limiting)
     * Now includes exponential backoff retry for API failures
     */
    private async prefetchSimilarArtists(
        seeds: SeedArtist[]
    ): Promise<Map<string, any[]>> {
        const cache = new Map<string, any[]>();

        // Helper: fetch with exponential backoff retry
        const fetchWithRetry = async (
            seed: SeedArtist,
            maxRetries = 3
        ): Promise<any[]> => {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const similar = await lastFmService.getSimilarArtists(
                        seed.mbid || "",
                        seed.name,
                        20
                    );
                    return similar;
                } catch (error: any) {
                    const isRetryable =
                        error.response?.status === 429 ||
                        error.response?.status >= 500 ||
                        error.code === "ECONNRESET" ||
                        error.code === "ETIMEDOUT";

                    if (isRetryable && attempt < maxRetries) {
                        const delay = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
                        logger.warn(
                            `   Retry ${attempt}/${maxRetries} for ${seed.name} in ${delay}ms (${error.message})`
                        );
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }

                    logger.warn(
                        `   Failed to get similar artists for ${seed.name}: ${error.message}`
                    );
                    return [];
                }
            }
            return [];
        };

        // Process seeds in smaller batches to avoid overwhelming APIs
        const batchSize = 3;
        for (let i = 0; i < seeds.length; i += batchSize) {
            const seedBatch = seeds.slice(i, i + batchSize);

            const results = await Promise.all(
                seedBatch.map(async (seed) => {
                    const similar = await fetchWithRetry(seed);
                    return { key: seed.mbid || seed.name, similar };
                })
            );

            for (const { key, similar } of results) {
                cache.set(key, similar);
            }

            // Small delay between batches
            if (i + batchSize < seeds.length) {
                await new Promise((r) => setTimeout(r, 300));
            }
        }

        return cache;
    }

    /**
     * Check for batches stuck in "downloading" or "scanning" status for too long
     * Called periodically from queue cleaner
     */
    async checkStuckBatches(): Promise<number> {
        const BATCH_TIMEOUT_WITH_COMPLETIONS = 30 * 60 * 1000; // 30 minutes
        const BATCH_TIMEOUT_NO_COMPLETIONS = 60 * 60 * 1000; // 60 minutes
        const ABSOLUTE_MAX_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours - force fail any batch older than this

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

            // Absolute timeout - fail any batch older than 2 hours regardless of state
            if (batchAge > ABSOLUTE_MAX_TIMEOUT) {
                logger.debug(
                    `\n⏰ [BATCH FORCE FAIL] Batch ${batch.id} is ${Math.round(
                        batchAge / 3600000
                    )}h old - force failing`
                );

                await updateBatchStatus(batch.id, {
                    status: "failed",
                    errorMessage: "Batch timed out after 2 hours",
                    completedAt: new Date(),
                });

                // Mark any remaining pending/processing jobs as failed
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

            // Check if batch should be force-completed
            const hasCompletions = completedJobs.length > 0;
            const timeout = hasCompletions
                ? BATCH_TIMEOUT_WITH_COMPLETIONS
                : BATCH_TIMEOUT_NO_COMPLETIONS;

            if (batchAge > timeout && pendingJobs.length > 0) {
                logger.debug(
                    `\n⏰ [BATCH TIMEOUT] Batch ${
                        batch.id
                    } stuck for ${Math.round(batchAge / 60000)}min`
                );
                logger.debug(
                    `   Completed: ${completedJobs.length}, Pending: ${pendingJobs.length}`
                );

                // Mark all pending jobs as failed (timed out)
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

                // Now trigger batch completion check
                await this.checkBatchCompletion(batch.id);
                forcedCount++;
            }
        }

        return forcedCount;
    }

    /**
     * Check if discovery batch is complete and trigger final steps
     */
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

        // Skip if already completed/failed/scanning
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

        // Emit progress via SSE
        eventBus.emit({
            type: "discover:progress",
            userId: batch.userId,
            payload: { batchId, status: "downloading", completed, failed, total, progress: Math.round(((completed + failed) / total) * 100) },
        });

        logger.debug(
            `[BATCH ${batchId}] Status: ${completed} completed, ${failed} failed, ${pendingJobs.length} pending (total: ${total})`
        );

        // Wait for ALL downloads to complete/fail
        if (pendingJobs.length > 0) {
            logger.debug(
                `[BATCH ${batchId}] Still waiting for ${pendingJobs.length} downloads`
            );
            return;
        }

        // Wait for Lidarr to finish importing files
        logger.debug(`[BATCH ${batchId}] All jobs done! Waiting 60s for Lidarr to finish importing...`);
        await new Promise(resolve => setTimeout(resolve, 60000));
        logger.debug(`[BATCH ${batchId}] Transitioning to scan phase...`);

        // All jobs finished - use transaction to update batch and create unavailable records
        await prisma.$transaction(async (tx) => {
            // Create UnavailableAlbum records for failed downloads
            for (const job of failedJobs) {
                const metadata = job.metadata as any;
                try {
                    await tx.unavailableAlbum.upsert({
                        where: {
                            userId_weekStartDate_albumMbid: {
                                userId: batch.userId,
                                weekStartDate: batch.weekStart,
                                albumMbid: job.targetMbid,
                            },
                        },
                        create: {
                            userId: batch.userId,
                            albumMbid: job.targetMbid,
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
                } catch (e) {
                    // Ignore duplicate errors
                }
            }

            // Update batch status with optimistic locking
            if (completed === 0) {
                await updateBatchStatus(
                    batchId,
                    {
                        status: "failed",
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

            // Cleanup failed artists from Lidarr
            await this.cleanupFailedArtists(batchId);
            return;
        }

        // All successful downloads will be included in the playlist
        logger.debug(
            `   ${completed} albums ready for playlist. Triggering scan...`
        );
        await discoveryBatchLogger.info(
            batchId,
            `${completed} completed, ${failed} failed. All successful downloads will be in playlist.`
        );

        // Trigger ONE scan with batch ID
        await scanQueue.add("scan", {
            userId: batch.userId,
            type: "full",
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

    /**
     * Build final playlist after scan completes (atomic transaction)
     */
    async buildFinalPlaylist(batchId: string) {
        logger.debug(`\n Building final playlist for batch ${batchId}...`);

        const batch = await prisma.discoveryBatch.findUnique({
            where: { id: batchId },
        });

        if (!batch) {
            logger.debug(`   Batch not found`);
            return;
        }

        // Get completed download jobs
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

        // Build search criteria from completed jobs - use MBID (primary) + artist/album name (fallback)
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

        // Find tracks - try MBID first (most accurate), then fall back to name matching
        let allTracks: any[] = [];
        for (const criteria of searchCriteria) {
            let tracks: any[] = [];

            // PRIMARY: Search by rgMbid (most accurate)
            if (criteria.albumMbid) {
                tracks = await prisma.track.findMany({
                    where: {
                        album: { rgMbid: criteria.albumMbid },
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

            // FALLBACK: Search by artist name + album title (case-insensitive)
            if (tracks.length === 0) {
                tracks = await prisma.track.findMany({
                    where: {
                        album: {
                            title: {
                                equals: criteria.albumTitle,
                                mode: "insensitive",
                            },
                            artist: {
                                name: {
                                    equals: criteria.artistName,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                    include: {
                        album: { include: { artist: true } },
                    },
                });
                if (tracks.length > 0) {
                    logger.debug(
                        `     [NAME] Found ${tracks.length} tracks for "${criteria.albumTitle}"`
                    );
                }
            }

            // FALLBACK 2: Normalized name search (handles Unicode/special chars)
            if (tracks.length === 0) {
                // Normalize for comparison
                const normalizeStr = (s: string) =>
                    s
                        .toLowerCase()
                        .normalize("NFKD") // Decompose Unicode
                        .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
                        .replace(/[^\w\s]/g, " ") // Replace punctuation with space
                        .replace(/\s+/g, " ") // Normalize whitespace
                        .trim();

                const normalizedAlbum = normalizeStr(criteria.albumTitle);
                const normalizedArtist = normalizeStr(criteria.artistName);

                // Get all albums from this artist (by normalized name)
                const artistAlbums = await prisma.album.findMany({
                    where: {
                        artist: {
                            name: {
                                mode: "insensitive",
                                contains: normalizedArtist.split(" ")[0],
                            },
                        },
                    },
                    include: { artist: true, tracks: true },
                });

                // Find matching album by normalized title
                for (const album of artistAlbums) {
                    if (
                        normalizeStr(album.title) === normalizedAlbum ||
                        normalizeStr(album.title).includes(normalizedAlbum) ||
                        normalizedAlbum.includes(normalizeStr(album.title))
                    ) {
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

        // Remove duplicates (same track ID)
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

        // Group tracks by album ID and pick ONE random track per album
        const tracksByAlbum = new Map<string, typeof allTracks>();
        for (const track of allTracks) {
            const albumId = track.album.id;
            if (!tracksByAlbum.has(albumId)) {
                tracksByAlbum.set(albumId, []);
            }
            tracksByAlbum.get(albumId)!.push(track);
        }

        // Select 1 random track from each album
        const onePerAlbum: typeof allTracks = [];
        for (const [albumId, tracks] of tracksByAlbum) {
            const randomTrack =
                tracks[Math.floor(Math.random() * tracks.length)];
            onePerAlbum.push(randomTrack);
        }

        const availableAlbums = onePerAlbum.length;
        const anchorCount = Math.ceil(availableAlbums * 0.2); // Add 20% anchors on top

        logger.debug(
            `   Unique albums available: ${availableAlbums} (from ${allTracks.length} total tracks)`
        );
        logger.debug(
            `   Target composition: ${availableAlbums} discovery + ${anchorCount} anchors = ${
                availableAlbums + anchorCount
            } total`
        );

        // Shuffle the unique album tracks
        const shuffled = shuffleArray(onePerAlbum);

        // Step 1: Get ALL discovery tracks (1 per album) - no limit!
        let discoverySelected = [...shuffled];
        logger.debug(
            `   Discovery tracks: ${discoverySelected.length} (ALL available, 1 per album)`
        );

        // Step 2: ALWAYS add library anchor tracks (20%)
        // Get seed artists for this user
        const seeds = await discoverySeeding.getSeedArtists(batch.userId);
        const seedArtistNames = seeds.slice(0, 10).map((s) => s.name);
        const seedArtistMbids = seeds
            .slice(0, 10)
            .map((s) => s.mbid)
            .filter(Boolean) as string[];

        let libraryAnchors: any[] = [];
        // Get existing track IDs to avoid duplicates
        const existingTrackIds = new Set(discoverySelected.map((t) => t.id));

        // First, try to find library tracks from seed artists (by name or mbid)
        // Also exclude albums already used in discovery
        const usedAlbumIds = new Set(discoverySelected.map((t) => t.album.id));

        if (seedArtistNames.length > 0 || seedArtistMbids.length > 0) {
            const libraryTracks = await prisma.track.findMany({
                where: {
                    album: {
                        artist: {
                            OR: [
                                { normalizedName: { in: seedArtistNames.map(n => normalizeArtistName(n)) } },
                                ...(seedArtistMbids.length > 0
                                    ? [{ mbid: { in: seedArtistMbids } }]
                                    : []),
                            ],
                        },
                        location: "LIBRARY",
                        id: { notIn: Array.from(usedAlbumIds) }, // Exclude albums already in discovery
                    },
                    id: { notIn: Array.from(existingTrackIds) },
                },
                include: {
                    album: { include: { artist: true } },
                },
                take: anchorCount * 10, // Get extra for 1-per-album selection
            });

            logger.debug(
                `   Found ${libraryTracks.length} candidate library tracks from ${seedArtistNames.length} seed artists`
            );

            if (libraryTracks.length > 0) {
                // Group by album and pick 1 per album
                const anchorsByAlbum = new Map<
                    string,
                    (typeof libraryTracks)[0]
                >();
                for (const track of libraryTracks) {
                    if (
                        !anchorsByAlbum.has(track.album.id) &&
                        !usedAlbumIds.has(track.album.id)
                    ) {
                        anchorsByAlbum.set(track.album.id, track);
                    }
                }

                // Shuffle and take what we need
                const uniqueAnchors = shuffleArray(Array.from(anchorsByAlbum.values()));
                libraryAnchors = uniqueAnchors.slice(0, anchorCount);

                // Mark these as library anchors and track used albums
                for (const track of libraryAnchors) {
                    (track as any).isLibraryAnchor = true;
                    usedAlbumIds.add(track.album.id);
                }
            }
        }

        // GUARANTEE: If we don't have enough anchors from seed artists, use ANY popular library tracks
        if (libraryAnchors.length < anchorCount) {
            const needed = anchorCount - libraryAnchors.length;
            logger.debug(
                `   Only ${libraryAnchors.length}/${anchorCount} anchors from seeds, adding ${needed} from popular library tracks`
            );

            // Get track IDs we already have (discovery + current anchors)
            const usedTrackIds = new Set([
                ...existingTrackIds,
                ...libraryAnchors.map((t) => t.id),
            ]);

            // Find popular library tracks (from artists with most plays or albums)
            // Exclude albums already used
            const popularLibraryTracks = await prisma.track.findMany({
                where: {
                    album: {
                        location: "LIBRARY",
                        id: { notIn: Array.from(usedAlbumIds) }, // 1 per album
                    },
                    id: { notIn: Array.from(usedTrackIds) },
                },
                include: {
                    album: { include: { artist: true } },
                },
                orderBy: {
                    // Order by album's artist name for variety, or you could add play count
                    album: { artist: { name: "asc" } },
                },
                take: needed * 10, // Get extra for 1-per-album selection
            });

            if (popularLibraryTracks.length > 0) {
                // Group by album and pick 1 per album
                const popByAlbum = new Map<
                    string,
                    (typeof popularLibraryTracks)[0]
                >();
                for (const track of popularLibraryTracks) {
                    if (
                        !popByAlbum.has(track.album.id) &&
                        !usedAlbumIds.has(track.album.id)
                    ) {
                        popByAlbum.set(track.album.id, track);
                    }
                }

                const shuffledPopular = shuffleArray(Array.from(popByAlbum.values()));
                const additionalAnchors = shuffledPopular.slice(0, needed);

                for (const track of additionalAnchors) {
                    (track as any).isLibraryAnchor = true;
                    usedAlbumIds.add(track.album.id);
                }

                libraryAnchors = [...libraryAnchors, ...additionalAnchors];
                logger.debug(
                    `   Added ${additionalAnchors.length} popular library tracks as anchors (1 per album)`
                );
            } else {
                logger.debug(
                    `   No additional library tracks available for anchors`
                );
            }
        }

        logger.debug(
            `   Library anchors: ${libraryAnchors.length}/${anchorCount}`
        );

        // Combine ALL discovery tracks with anchors
        let selected = [...discoverySelected, ...libraryAnchors];

        // Shuffle the final selection to mix anchors with discovery
        selected = shuffleArray(selected);

        await discoveryBatchLogger.info(
            batchId,
            `Playlist built: ${discoverySelected.length} discovery + ${libraryAnchors.length} anchors = ${selected.length} total`
        );

        // Log final result
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
                `   SUCCESS: Got ${selected.length} tracks (${discoverySelected.length} discovery + ${libraryAnchors.length} anchors)`
            );
        }

        // Create discovery records in transaction
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
                        // Find the job for this album by artist+album name (case-insensitive)
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

                        // Use upsert to handle regeneration (records may already exist)
                        // IMPORTANT: Use the tier from metadata directly, don't recalculate!
                        // This preserves "wildcard" and other tiers that don't match their similarity
                        const storedTier =
                            metadata?.tier ||
                            getTierFromSimilarity(metadata?.similarity || 0.5);
                        const storedSimilarity = metadata?.similarity || 0.5;

                        // Debug: Log if job wasn't matched
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
                                // Refresh data on regeneration
                                artistName: track.album.artist.name,
                                artistMbid: track.album.artist.mbid,
                                albumTitle: track.album.title,
                                lidarrAlbumId: job?.lidarrAlbumId,
                                similarity: storedSimilarity,
                                tier: storedTier,
                                downloadedAt: new Date(),
                                status: "ACTIVE", // Reset to active on regeneration
                            },
                        });

                        discoveryAlbumId = discoveryAlbum.id;
                        createdAlbums.set(albumKey, discoveryAlbumId);

                        // Add to exclusion list (if user has exclusions enabled)
                        const userConfig =
                            await tx.userDiscoverConfig.findUnique({
                                where: { userId: batch.userId },
                            });
                        const exclusionMonths =
                            userConfig?.exclusionMonths ?? 6;

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

                // Mark batch complete with optimistic locking
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

        // Emit discover:complete via SSE
        eventBus.emit({
            type: "discover:complete",
            userId: batch.userId,
            payload: { batchId, status: result ? "completed" : "failed" },
        });

        // ALWAYS cleanup failed artists from Lidarr (even if playlist creation failed)
        // This prevents accumulating unused artists in Lidarr over time
        await this.cleanupFailedArtists(batchId);

        // Also cleanup any orphaned Lidarr queue items from this batch
        await this.cleanupOrphanedLidarrQueue(batchId);
    }

    /**
     * Reconcile Discovery Weekly tracks after library scans
     * Backfills Discovery Weekly playlists with tracks from albums that downloaded after initial playlist creation
     *
     * Similar to Spotify Import's reconcilePendingTracks(), but for Discovery Weekly:
     * - Finds completed batches from last 7 days
     * - Checks if their downloaded albums are in the library
     * - Creates DiscoveryAlbum + DiscoveryTrack records for missing albums
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

        // Find completed batches from last 7 days
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

            // Get completed download jobs for this batch
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

            // Check each completed job to see if it has corresponding DiscoveryAlbum records
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

                // Check if this album already has DiscoveryAlbum record
                const existingDiscoveryAlbum =
                    await prisma.discoveryAlbum.findFirst({
                        where: {
                            userId: batch.userId,
                            weekStartDate: batch.weekStart,
                            rgMbid: albumMbid,
                        },
                    });

                if (existingDiscoveryAlbum) {
                    // Already has discovery record, skip
                    continue;
                }

                logger.debug(
                    `     Album "${albumTitle}" by "${artistName}" missing from Discovery - checking library...`
                );

                // PRIMARY: Search by rgMbid (most accurate)
                let tracks: any[] = [];
                if (albumMbid) {
                    tracks = await prisma.track.findMany({
                        where: {
                            album: { rgMbid: albumMbid },
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

                // FALLBACK: Search by artist name + album title (case-insensitive)
                if (tracks.length === 0 && artistName && albumTitle) {
                    logger.debug(
                        `       [NAME] Trying name-based search: "${artistName}" - "${albumTitle}"`
                    );
                    tracks = await prisma.track.findMany({
                        where: {
                            album: {
                                title: {
                                    equals: albumTitle,
                                    mode: "insensitive",
                                },
                                artist: {
                                    name: {
                                        equals: artistName,
                                        mode: "insensitive",
                                    },
                                },
                            },
                        },
                        include: {
                            album: { include: { artist: true } },
                        },
                    });
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

                // Album is in library! Create DiscoveryAlbum + DiscoveryTrack records
                const album = tracks[0].album;
                const similarity = metadata?.similarity || 0.5;
                const tier =
                    metadata?.tier || getTierFromSimilarity(similarity);

                logger.debug(
                    `       ✓ Creating Discovery records for ${tracks.length} track(s)...`
                );

                try {
                    await prisma.$transaction(async (tx) => {
                        // Create DiscoveryAlbum
                        const discoveryAlbum = await tx.discoveryAlbum.create({
                            data: {
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
                        });

                        // Create DiscoveryTrack for each track
                        for (const track of tracks) {
                            // Check if track already exists (prevent duplicates)
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

    /**
     * Cleanup orphaned Lidarr queue items that belong to this discovery batch
     * but are no longer needed (download completed but album not in final playlist)
     */
    private async cleanupOrphanedLidarrQueue(batchId: string): Promise<void> {
        logger.debug(`\n[CLEANUP] Checking for orphaned Lidarr queue items...`);

        try {
            const batch = await prisma.discoveryBatch.findUnique({
                where: { id: batchId },
                include: { jobs: true },
            });

            if (!batch) return;

            const settings = await getSystemSettings();
            if (
                !settings?.lidarrEnabled ||
                !settings?.lidarrUrl ||
                !settings?.lidarrApiKey
            ) {
                return;
            }

            // Get all download IDs from our batch jobs
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

            // Get Lidarr queue
            const queueResponse = await axios.get(
                `${settings.lidarrUrl}/api/v1/queue`,
                {
                    params: { pageSize: 500 },
                    headers: { "X-Api-Key": settings.lidarrApiKey },
                    timeout: 30000,
                }
            );

            const queueItems = queueResponse.data?.records || [];
            let removed = 0;

            for (const item of queueItems) {
                const downloadId = item.downloadId;

                // Check if this is one of our downloads
                if (downloadId && ourDownloadIds.has(downloadId)) {
                    // Check if it's in a stuck state
                    const isStuck =
                        item.status === "warning" ||
                        item.status === "failed" ||
                        item.trackedDownloadState === "importFailed" ||
                        item.trackedDownloadState === "importBlocked";

                    if (isStuck) {
                        try {
                            await axios.delete(
                                `${settings.lidarrUrl}/api/v1/queue/${item.id}`,
                                {
                                    params: {
                                        removeFromClient: true,
                                        blocklist: true,
                                    },
                                    headers: {
                                        "X-Api-Key": settings.lidarrApiKey,
                                    },
                                    timeout: 10000,
                                }
                            );
                            logger.debug(
                                `   Removed orphaned queue item: ${item.title}`
                            );
                            removed++;
                        } catch (e) {
                            // Ignore removal errors
                        }
                    }
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
     * Cleanup artists from Lidarr that failed during discovery
     * Only removes artists that:
     * - Had ALL their downloads fail in this batch
     * - Don't have any other music in the user's library
     *
     * NOTE: With tag-based tracking, we simply remove artists with the discovery tag
     * who don't have successful downloads. The tag is the source of truth.
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

        // Build set of artists with successful downloads in this batch
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

        // Get all artists with the discovery tag
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

            // Keep if artist had successful downloads in this batch
            if (successfulArtistMbids.has(artistMbid)) {
                kept++;
                continue;
            }

            // Keep if artist has liked/moved discovery albums
            const hasKept = await prisma.discoveryAlbum.findFirst({
                where: {
                    artistMbid,
                    status: { in: ["LIKED", "MOVED"] },
                },
            });

            if (hasKept) {
                logger.debug(
                    `   Keeping ${artistName} - has liked albums (removing tag)`
                );
                await lidarrService.removeDiscoveryTagByMbid(artistMbid);
                kept++;
                continue;
            }

            // Keep if artist has ACTIVE discovery albums from other weeks
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

            // Artist has discovery tag, no successful downloads, no liked albums = remove
            try {
                const result = await lidarrService.deleteArtistById(
                    lidarrArtist.id,
                    true
                );
                if (result.success) {
                    logger.debug(` Removed: ${artistName}`);
                    removed++;
                }
            } catch (error: any) {
                logger.error(
                    ` Failed to remove ${artistName}: ${error.message}`
                );
            }
        }

        logger.debug(`   Cleanup complete: ${removed} removed, ${kept} kept`);
        await discoveryBatchLogger.info(
            batchId,
            `Lidarr cleanup: ${removed} failed artists removed`
        );
    }

    /**
     * Check if an artist is already in the user's library
     * Discovery should find NEW artists, not more albums from artists they already own
     */
    private async isArtistInLibrary(
        artistName: string,
        artistMbid: string | undefined
    ): Promise<boolean> {
        // Check by MBID first (most accurate)
        if (artistMbid && !artistMbid.startsWith("temp-")) {
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

        // Check by name (case insensitive)
        const byName = await prisma.artist.findFirst({
            where: {
                name: { equals: artistName, mode: "insensitive" },
            },
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

    /**
     * Check if an album is owned by artist name + album title
     * This catches cases where the MBID doesn't match but the album exists
     */
    private async isAlbumOwnedByName(
        artistName: string,
        albumTitle: string
    ): Promise<boolean> {
        // Normalize for comparison
        const normalizedArtist = artistName.toLowerCase().trim();
        const normalizedAlbum = albumTitle
            .toLowerCase()
            .replace(/\(.*?\)/g, "") // Remove parenthetical content
            .replace(/\[.*?\]/g, "") // Remove bracketed content
            .replace(
                /[-–—]\s*(deluxe|remaster|bonus|special|anniversary|expanded|limited|collector).*$/i,
                ""
            )
            .trim();

        // Check Album table by name
        const album = await prisma.album.findFirst({
            where: {
                title: { contains: normalizedAlbum, mode: "insensitive" },
                artist: {
                    name: { contains: normalizedArtist, mode: "insensitive" },
                },
            },
        });
        if (album) {
            logger.debug(
                `     [OWNED-NAME] Found "${albumTitle}" by "${artistName}" in Album table`
            );
            return true;
        }

        // Check OwnedAlbum by looking up associated Album records through rgMbid
        const ownedAlbumRefs = await prisma.ownedAlbum.findMany({
            where: {
                artist: {
                    name: { contains: normalizedArtist, mode: "insensitive" },
                },
            },
            select: { rgMbid: true },
        });

        // Look up the actual album titles for these owned albums
        if (ownedAlbumRefs.length > 0) {
            const rgMbids = ownedAlbumRefs.map((o) => o.rgMbid);
            const ownedAlbumRecords = await prisma.album.findMany({
                where: { rgMbid: { in: rgMbids } },
                select: { title: true },
            });

            for (const owned of ownedAlbumRecords) {
                const ownedNormalized = owned.title
                    ?.toLowerCase()
                    .replace(/\(.*?\)/g, "")
                    .replace(/\[.*?\]/g, "")
                    .trim();
                if (
                    ownedNormalized &&
                    (ownedNormalized.includes(normalizedAlbum) ||
                        normalizedAlbum.includes(ownedNormalized))
                ) {
                    logger.debug(
                        `     [OWNED-NAME] Found "${albumTitle}" by "${artistName}" in OwnedAlbum table`
                    );
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Check if album was recommended recently (6 months)
     */
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
     * Find a replacement album when download fails after all retries.
     * Uses multi-tier fallback prioritizing ARTIST DIVERSITY:
     * - Tier 2: Album from DIFFERENT similar artist (prioritize diversity!)
     * - Tier 3: Another album from SAME artist (last resort fallback)
     */
    async findReplacementAlbum(
        failedJob: any,
        batch: any
    ): Promise<{
        artistName: string;
        artistMbid: string;
        albumTitle: string;
        albumMbid: string;
        similarity: number;
    } | null> {
        const metadata = failedJob.metadata as any;
        const failedArtistMbid = metadata?.artistMbid;

        logger.debug(
            `[Discovery] Finding replacement for: ${metadata?.artistName} - ${metadata?.albumTitle}`
        );

        // Get all MBIDs and ARTIST MBIDs already attempted in this batch (for diversity tracking)
        const attemptedMbids = new Set<string>();
        const attemptedArtistMbids = new Set<string>();
        const batchJobs = await prisma.downloadJob.findMany({
            where: { discoveryBatchId: batch.id },
        });
        for (const job of batchJobs) {
            attemptedMbids.add(job.targetMbid);
            const jobMeta = job.metadata as any;
            if (jobMeta?.artistMbid) {
                attemptedArtistMbids.add(jobMeta.artistMbid);
            }
        }

        logger.debug(
            `[Discovery]   Already have ${attemptedArtistMbids.size} artists in batch, prioritizing new artists`
        );

        // Tier 2: Try album from DIFFERENT similar artist - search ALL seeds with more similar artists
        // IMPORTANT: Never pick same artist twice for diversity!
        logger.debug(
            `[Discovery]   Tier 2: Searching ALL seeds for albums from NEW artists (diversity enforced)`
        );
        const seeds = await discoverySeeding.getSeedArtists(batch.userId);

        // Search ALL seeds (not just 5) to maximize chances of finding new artists
        for (const seed of seeds) {
            if (!seed.mbid) continue;

            try {
                // Get MORE similar artists per seed (30 instead of 15)
                const similarArtists = await lastFmService.getSimilarArtists(
                    seed.mbid,
                    seed.name,
                    30
                );

                for (const similar of similarArtists) {
                    // Skip artists we already have in this batch (including the failed artist)
                    if (!similar.mbid) continue;
                    if (similar.mbid === failedArtistMbid) continue;
                    if (attemptedArtistMbids.has(similar.mbid)) {
                        continue; // Skip - we already have an album from this artist
                    }

                    // Get more albums to increase chances of finding available one
                    const albums = await lastFmService.getArtistTopAlbums(
                        similar.mbid,
                        similar.name,
                        5
                    );

                    for (const album of albums) {
                        // Get MBID from MusicBrainz
                        const mbAlbum = await musicBrainzService.searchAlbum(
                            album.name,
                            similar.name
                        );

                        if (mbAlbum && !attemptedMbids.has(mbAlbum.id)) {
                            // Check if artist is already in library (Discovery = NEW artists only!)
                            try {
                                const artistInLibrary =
                                    await this.isArtistInLibrary(
                                        similar.name,
                                        similar.mbid
                                    );
                                if (artistInLibrary) {
                                    logger.debug(
                                        `[Discovery]   Skipping ${similar.name} - already in library`
                                    );
                                    continue;
                                }
                            } catch (e: any) {
                                logger.error(
                                    `[Discovery]   isArtistInLibrary error for ${similar.name}: ${e.message}`
                                );
                                // Continue anyway - assume not in library if check fails
                            }

                            // Check if owned (with fuzzy matching)
                            try {
                                const owned = await discoverySeeding.isAlbumOwned(
                                    mbAlbum.id,
                                    batch.userId,
                                    similar.name,
                                    album.name
                                );
                                if (owned) continue;
                            } catch (e: any) {
                                logger.error(
                                    `[Discovery]   isAlbumOwned error: ${e.message}`
                                );
                                continue; // Skip on error
                            }

                            // Check if excluded
                            try {
                                const excluded = await this.isAlbumExcluded(
                                    mbAlbum.id,
                                    batch.userId
                                );
                                if (excluded) continue;
                            } catch (e: any) {
                                logger.error(
                                    `[Discovery]   isAlbumExcluded error: ${e.message}`
                                );
                                continue; // Skip on error
                            }

                            logger.debug(
                                `[Discovery]   Tier 2 replacement found: ${album.name} by ${similar.name} (NEW artist!)`
                            );
                            return {
                                artistName: similar.name,
                                artistMbid: similar.mbid,
                                albumTitle: album.name,
                                albumMbid: mbAlbum.id,
                                similarity: similar.match || 0.5,
                            };
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }

        // NOTE: Same-artist fallback REMOVED - we enforce strict one-album-per-artist
        // If we can't find a new artist, go straight to library anchor
        logger.debug(
            `[Discovery]   No new artists found, using library anchor (diversity enforced)`
        );

        // Tier 3: Use track from user's library as anchor (related to discovery seeds)
        logger.debug(
            `[Discovery]   Tier 3: Selecting anchor track from user's library (seed artists)`
        );
        try {
            // Get a random album from seed artists that user already owns
            for (const seed of seeds.slice(0, 5)) {
                const ownedAlbum = await prisma.album.findFirst({
                    where: {
                        artist: {
                            OR: [
                                { mbid: seed.mbid || "___none___" },
                                {
                                    name: {
                                        equals: seed.name,
                                        mode: "insensitive",
                                    },
                                },
                            ],
                        },
                        tracks: { some: {} }, // Has tracks
                    },
                    include: { artist: true },
                });

                if (
                    ownedAlbum &&
                    ownedAlbum.rgMbid &&
                    !attemptedMbids.has(ownedAlbum.rgMbid)
                ) {
                    logger.debug(
                        `[Discovery]   Tier 3 anchor found: ${ownedAlbum.artist.name} - ${ownedAlbum.title} (from library)`
                    );
                    return {
                        artistName: ownedAlbum.artist.name,
                        artistMbid: ownedAlbum.artist.mbid,
                        albumTitle: ownedAlbum.title,
                        albumMbid: ownedAlbum.rgMbid,
                        similarity: 1.0, // Library = perfect match
                        isLibraryAnchor: true, // Flag so we know not to download
                    } as any;
                }
            }
        } catch (e) {
            logger.debug(
                `[Discovery]   Tier 3 search failed: ${(e as Error).message}`
            );
        }

        logger.debug(`[Discovery]   No replacement found`);
        return null;
    }

    /**
     * Helper: Find a valid album for a given artist
     * Returns the first album that passes all checks (owned, excluded, etc.)
     */
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
            // Get 10 albums per artist to increase chances of finding good representative content
            const topAlbums = await lastFmService.getArtistTopAlbums(
                artist.mbid || "",
                artist.name,
                10
            );

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

            // Collect and score all valid albums
            const scoredAlbums: Array<{
                albumName: string;
                albumMbid: string;
                score: number;
                releaseYear: number;
                trackCount: number;
            }> = [];

            for (const album of topAlbums) {
                albumsChecked++;

                // Get MBID from MusicBrainz
                const mbAlbum = await musicBrainzService.searchAlbum(
                    album.name,
                    artist.name
                );

                if (!mbAlbum) {
                    skippedNoMbid++;
                    continue;
                }

                // Skip duplicates
                if (seenAlbums.has(mbAlbum.id)) {
                    skippedDuplicate++;
                    continue;
                }

                // Get detailed album information
                const details = await musicBrainzService.getAlbumDetails(mbAlbum.id);
                if (!details) {
                    skippedNoMbid++;
                    continue;
                }

                // Skip non-studio albums (use MusicBrainz metadata instead of regex)
                if (details.primaryType !== 'Album') {
                    continue;
                }
                if (details.secondaryTypes?.includes('Live')) {
                    continue;
                }
                if (details.secondaryTypes?.includes('Compilation')) {
                    continue;
                }

                // Skip EPs (< 7 tracks)
                if (details.trackCount && details.trackCount < MIN_TRACK_COUNT) {
                    logger.debug(`      [SKIP] ${album.name} - only ${details.trackCount} tracks (EP)`);
                    continue;
                }

                // Skip if owned (with fuzzy matching)
                try {
                    const owned = await discoverySeeding.isAlbumOwned(
                        mbAlbum.id,
                        userId,
                        artist.name,
                        album.name
                    );
                    if (owned) {
                        skippedOwned++;
                        continue;
                    }
                } catch (e: any) {
                    continue;
                }

                // Skip if owned by name (catches MBID mismatches)
                try {
                    const ownedByName = await this.isAlbumOwnedByName(
                        artist.name,
                        album.name
                    );
                    if (ownedByName) {
                        skippedOwned++;
                        continue;
                    }
                } catch (e: any) {
                    continue;
                }

                // Check if album was recently recommended (exclusion period)
                try {
                    const excluded = await this.isAlbumExcluded(
                        mbAlbum.id,
                        userId
                    );
                    if (excluded) {
                        skippedExcluded++;
                        continue;
                    }
                } catch (e: any) {
                    continue;
                }

                // Calculate score for this valid album
                let score = 0;

                // Recent albums get bonus (last 5 years)
                const releaseYear = details.releaseDate ? parseInt(details.releaseDate.split('-')[0]) : 0;
                if (releaseYear >= currentYear - RECENT_YEARS) {
                    score += 10;
                }

                // Popularity score (normalized playcount from Last.fm)
                const playcount = album.playcount || 0;
                score += Math.log10(playcount + 1);

                scoredAlbums.push({
                    albumName: album.name,
                    albumMbid: mbAlbum.id,
                    score,
                    releaseYear,
                    trackCount: details.trackCount || 0,
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

            // Sort by score (recent + popular = best)
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

    /**
     * Get user's top genres from listening history
     */
    private async getUserTopGenres(userId: string): Promise<string[]> {
        try {
            // Get recent plays with artist info
            const recentPlays = await prisma.play.findMany({
                where: {
                    userId,
                    playedAt: { gte: subWeeks(new Date(), 12) }, // Last 3 months
                },
                include: {
                    track: {
                        include: {
                            album: {
                                include: { artist: true },
                            },
                        },
                    },
                },
                take: 500,
            });

            // Collect genres from artists (stored as tags)
            // MERGE canonical genres + user-added genres
            const genreCounts = new Map<string, number>();

            for (const play of recentPlays) {
                const artist = play.track?.album?.artist;
                if (!artist) continue;

                // Collect canonical genres
                if (artist.genres) {
                    const genres = Array.isArray(artist.genres)
                        ? artist.genres
                        : ((artist.genres as string) || "")
                              .split(",")
                              .map((g: string) => g.trim());

                    for (const genre of genres) {
                        if (genre && typeof genre === "string") {
                            genreCounts.set(
                                genre.toLowerCase(),
                                (genreCounts.get(genre.toLowerCase()) || 0) + 1
                            );
                        }
                    }
                }

                // Also collect user-added genres (metadata override system)
                if (artist.userGenres) {
                    const userGenres = Array.isArray(artist.userGenres)
                        ? artist.userGenres
                        : [];

                    for (const genre of userGenres) {
                        if (genre && typeof genre === "string") {
                            genreCounts.set(
                                genre.toLowerCase(),
                                (genreCounts.get(genre.toLowerCase()) || 0) + 1
                            );
                        }
                    }
                }
            }

            // Sort by count and return top genres
            return Array.from(genreCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([genre]) => genre);
        } catch (error) {
            logger.error("Error getting user genres:", error);
            return [];
        }
    }

    /**
     * TAG EXPLORATION STRATEGY
     * Find albums by the user's top genre tags via Last.fm
     */
    private async tagExplorationStrategy(
        userId: string,
        targetCount: number,
        seenAlbums: Set<string>
    ): Promise<RecommendedAlbum[]> {
        logger.debug(
            `\n[STRATEGY] Tag Exploration - finding studio albums by genre`
        );

        const recommendations: RecommendedAlbum[] = [];
        const genres = await this.getUserTopGenres(userId);

        // Patterns to exclude non-studio releases
        const EXCLUDE_PATTERNS = [
            /\blive\b/i,
            /\bep\b$/i,
            /\bacoustic\b/i,
            /\bsession[s]?\b/i,
            /\bcompilation\b/i,
            /\bgreatest\s*hits\b/i,
            /\bbest\s*of\b/i,
            /\bremix(es|ed)?\b/i,
            /\bunplugged\b/i,
            /\bcollection\b/i,
            /\banthology\b/i,
            /\bdemo[s]?\b/i,
        ];

        const isStudioAlbum = (title: string): boolean => {
            return !EXCLUDE_PATTERNS.some((pattern) => pattern.test(title));
        };

        if (genres.length === 0) {
            logger.debug(`   No genres found for user, using fallback tags`);
            genres.push("rock", "indie", "alternative"); // Fallback
        }

        logger.debug(`   User's top genres: ${genres.slice(0, 5).join(", ")}`);

        for (const genre of genres.slice(0, 5)) {
            if (recommendations.length >= targetCount) break;

            try {
                // Use Last.fm's getTopAlbumsByTag
                const tagAlbums = await lastFmService.getTopAlbumsByTag(
                    genre,
                    30
                );

                for (const album of tagAlbums) {
                    if (recommendations.length >= targetCount) break;

                    const artistName = album.artist?.name || album.artist;
                    if (!artistName || !album.name) continue;

                    // Skip non-studio albums
                    if (!isStudioAlbum(album.name)) continue;

                    // Get MBID from MusicBrainz
                    const mbAlbum = await musicBrainzService.searchAlbum(
                        album.name,
                        artistName
                    );
                    if (!mbAlbum || seenAlbums.has(mbAlbum.id)) continue;

                    // Check if owned (with fuzzy matching)
                    const owned = await discoverySeeding.isAlbumOwned(
                        mbAlbum.id,
                        userId,
                        artistName,
                        album.name
                    );
                    if (owned) continue;

                    // Check if owned by name (catches MBID mismatches)
                    const ownedByName = await this.isAlbumOwnedByName(
                        artistName,
                        album.name
                    );
                    if (ownedByName) continue;

                    // Check if album was recently recommended (exclusion period)
                    const excluded = await this.isAlbumExcluded(
                        mbAlbum.id,
                        userId
                    );
                    if (excluded) continue;

                    // Check if artist is in library (prefer new artists)
                    const inLibrary = await this.isArtistInLibrary(
                        artistName,
                        undefined
                    );
                    if (inLibrary) continue;

                    seenAlbums.add(mbAlbum.id);
                    recommendations.push({
                        artistName,
                        albumTitle: album.name,
                        albumMbid: mbAlbum.id,
                        similarity: 0.7, // Tag-based discovery
                        tier: "wildcard",
                    });
                    logger.debug(
                        `   ✓ TAG: ${artistName} - ${album.name} (${genre})`
                    );
                }
            } catch (error: any) {
                logger.warn(
                    `   Tag search failed for ${genre}: ${error.message}`
                );
            }
        }

        logger.debug(
            `   Tag exploration found ${recommendations.length} albums`
        );
        return recommendations;
    }

    /**
     * Score artists by how many seed lists they appear in
     * Artists recommended by multiple seeds = stronger signal
     */
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

        // Collect all artist occurrences across seed lists
        for (const [seedKey, similar] of similarCache.entries()) {
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

        // Calculate scores
        const scored = Array.from(artistFrequency.values()).map(artist => ({
            name: artist.name,
            mbid: artist.mbid,
            avgMatch: artist.matches.reduce((sum, m) => sum + m, 0) / artist.matches.length,
            maxMatch: Math.max(...artist.matches),
            crossSeedCount: artist.matches.length,
        }));

        // Sort by cross-seed count (more seeds = higher) then by avg match
        scored.sort((a, b) => {
            if (b.crossSeedCount !== a.crossSeedCount) {
                return b.crossSeedCount - a.crossSeedCount;
            }
            return b.avgMatch - a.avgMatch;
        });

        logger.debug(`[DISCOVERY] Cross-seed scored ${scored.length} unique artists`);
        logger.debug(`   Top artist: ${scored[0]?.name} (${scored[0]?.crossSeedCount} seeds, ${(scored[0]?.avgMatch * 100).toFixed(0)}% avg match)`);

        return scored;
    }

    /**
     * Main recommendation engine with tier-based selection
     * Combines similar artists (by tier) + genre wildcards for variety
     *
     * Distribution:
     * - 30% HIGH tier (>70% similar)
     * - 40% MEDIUM tier (50-70% similar)
     * - 20% EXPLORE tier (30-50% similar)
     * - 10% WILDCARD (genre tags)
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

        // Calculate counts for each tier
        const wildcardCount = Math.max(
            1,
            Math.ceil(targetCount * TIER_DISTRIBUTION.wildcard)
        );
        const similarArtistTarget = targetCount - wildcardCount;

        const highCount = Math.ceil(
            similarArtistTarget * (TIER_DISTRIBUTION.high / 0.9)
        );
        const mediumCount = Math.ceil(
            similarArtistTarget * (TIER_DISTRIBUTION.medium / 0.9)
        );
        const exploreCount = similarArtistTarget - highCount - mediumCount;

        logger.debug(
            `   Targets: ${highCount} high, ${mediumCount} medium, ${exploreCount} explore, ${wildcardCount} wildcard`
        );

        // Score artists by cross-seed frequency (appears in multiple seed lists = stronger signal)
        const scoredArtists = this.scoreArtistsByCrossSeedFrequency(similarCache);

        // Group similar artists by tier (based on avgMatch across all seeds)
        // Thresholds calibrated to Last.fm's actual distribution (0.5-0.7 range typically)
        // Filter out low-quality matches below minimum threshold
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

        // Debug: Show top artists from each tier with their avgMatch scores and cross-seed counts
        if (byTier.high.length > 0) {
            logger.debug(
                `   HIGH tier sample: ${byTier.high
                    .slice(0, 3)
                    .map((a) => `${a.name}(${(a.avgMatch * 100).toFixed(0)}%,${a.crossSeedCount}x)`)
                    .join(", ")}`
            );
        }
        if (byTier.medium.length > 0) {
            logger.debug(
                `   MEDIUM tier sample: ${byTier.medium
                    .slice(0, 3)
                    .map((a) => `${a.name}(${(a.avgMatch * 100).toFixed(0)}%,${a.crossSeedCount}x)`)
                    .join(", ")}`
            );
        }
        if (byTier.explore.length > 0) {
            logger.debug(
                `   EXPLORE tier sample: ${byTier.explore
                    .slice(0, 3)
                    .map((a) => `${a.name}(${(a.avgMatch * 100).toFixed(0)}%,${a.crossSeedCount}x)`)
                    .join(", ")}`
            );
        }

        // Shuffle each tier for variety week-to-week
        byTier.high = shuffleArray(byTier.high);
        byTier.medium = shuffleArray(byTier.medium);
        byTier.explore = shuffleArray(byTier.explore);

        // Helper to select from a tier
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

                // Check if artist is in library (prefer NEW artists)
                let artistInLibrary = false;
                try {
                    artistInLibrary = await this.isArtistInLibrary(
                        artist.name,
                        artist.mbid
                    );
                } catch (e) {
                    // Continue on error
                }

                if (artistInLibrary) {
                    logger.debug(`      [SKIP] ${artist.name} - in library`);
                    continue;
                }

                // Find a valid album for this artist
                const result = await this.findValidAlbumForArtist(
                    artist,
                    userId,
                    seenAlbums
                );

                if (result.recommendation) {
                    seenArtists.add(key);
                    result.recommendation.tier = tierName;
                    // Use the artist's avgMatch score (cross-seed average) for similarity
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

        // Select from each tier
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

        // If we didn't get enough from tiered selection, fill with any available NEW artists
        if (recommendations.length < similarArtistTarget) {
            logger.debug(
                `\n   === Filling remaining slots (NEW artists only) ===`
            );
            const remaining = similarArtistTarget - recommendations.length;
            const allRemaining = [
                ...byTier.high,
                ...byTier.medium,
                ...byTier.explore,
            ].filter((a) => !seenArtists.has(a.name.toLowerCase()));

            for (const artist of shuffleArray(allRemaining)) {
                if (recommendations.length >= similarArtistTarget) break;

                const key = artist.name.toLowerCase();
                if (seenArtists.has(key)) continue;

                // Check if artist is in library (same as tier selection)
                let artistInLibrary = false;
                try {
                    artistInLibrary = await this.isArtistInLibrary(
                        artist.name,
                        artist.mbid
                    );
                } catch (e) {
                    // Continue on error
                }

                if (artistInLibrary) {
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
                    // Use the artist's avgMatch score (cross-seed average) for tier assignment
                    result.recommendation.tier = getTierFromSimilarity(
                        artist.avgMatch || result.recommendation.similarity
                    );
                    // Also update similarity to use avgMatch score
                    result.recommendation.similarity =
                        artist.avgMatch || result.recommendation.similarity;
                    recommendations.push(result.recommendation);
                    logger.debug(
                        `    ✓ [FILL] ${artist.name} - ${
                            result.recommendation.albumTitle
                        } (${(artist.avgMatch * 100).toFixed(0)}%, ${artist.crossSeedCount}x)`
                    );
                }
            }
        }

        // FALLBACK: If still not enough, allow existing artists with NEW albums
        if (recommendations.length < similarArtistTarget) {
            logger.debug(
                `\n   === FALLBACK: Existing artists with NEW albums ===`
            );
            logger.debug(
                `   Need ${
                    similarArtistTarget - recommendations.length
                } more recommendations`
            );

            const allRemaining = [
                ...byTier.high,
                ...byTier.medium,
                ...byTier.explore,
            ].filter((a) => !seenArtists.has(a.name.toLowerCase()));

            for (const artist of shuffleArray(allRemaining)) {
                if (recommendations.length >= similarArtistTarget) break;

                const key = artist.name.toLowerCase();
                if (seenArtists.has(key)) continue;

                // This time we ALLOW artists in library - we just want NEW albums from them
                const result = await this.findValidAlbumForArtist(
                    artist,
                    userId,
                    seenAlbums
                );
                if (result.recommendation) {
                    seenArtists.add(key);
                    result.recommendation.tier = getTierFromSimilarity(
                        artist.avgMatch || result.recommendation.similarity
                    );
                    result.recommendation.similarity =
                        artist.avgMatch || result.recommendation.similarity;
                    recommendations.push(result.recommendation);
                    logger.debug(
                        `    ✓ [EXISTING] ${artist.name} - ${
                            result.recommendation.albumTitle
                        } (${((artist.avgMatch || 0) * 100).toFixed(0)}%, ${artist.crossSeedCount}x)`
                    );
                }
            }
        }

        // Add genre wildcards for variety
        logger.debug(
            `\n   === Adding ${wildcardCount} WILDCARD picks from genre tags ===`
        );
        const wildcards = await this.tagExplorationStrategy(
            userId,
            wildcardCount,
            seenAlbums
        );
        for (const wc of wildcards) {
            wc.tier = "wildcard";
            recommendations.push(wc);
        }

        // Summary
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
