import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import {
    cleanStuckDownloads,
    getRecentCompletedDownloads,
} from "../services/lidarr";
import { scanQueue } from "../workers/queues";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { yieldToEventLoop } from "../utils/async";

class QueueCleanerService {
    private isRunning = false;
    private checkInterval = 30000; // 30 seconds when active
    private emptyQueueChecks = 0;
    private maxEmptyChecks = 3; // Stop after 3 consecutive empty checks
    private timeoutId?: NodeJS.Timeout;

    // Cached dynamic imports (lazy-loaded once, reused on subsequent calls)
    private discoverWeeklyService: typeof import("../services/discoverWeekly")["discoverWeeklyService"] | null = null;
    private matchAlbum: typeof import("../utils/fuzzyMatch")["matchAlbum"] | null = null;
    private spotifyImportService: typeof import("../services/spotifyImport")["spotifyImportService"] | null = null;

    /**
     * Get discoverWeeklyService (lazy-loaded and cached)
     */
    private async getDiscoverWeeklyService() {
        if (!this.discoverWeeklyService) {
            const module = await import("../services/discoverWeekly");
            this.discoverWeeklyService = module.discoverWeeklyService;
        }
        return this.discoverWeeklyService;
    }

    /**
     * Get spotifyImportService (lazy-loaded and cached)
     */
    private async getSpotifyImportService() {
        if (!this.spotifyImportService) {
            const module = await import("../services/spotifyImport");
            this.spotifyImportService = module.spotifyImportService;
        }
        return this.spotifyImportService;
    }

    /**
     * Get matchAlbum function (lazy-loaded and cached)
     */
    private async getMatchAlbum() {
        if (!this.matchAlbum) {
            const module = await import("../utils/fuzzyMatch");
            this.matchAlbum = module.matchAlbum;
        }
        return this.matchAlbum;
    }

    /**
     * Start the polling loop
     * Safe to call multiple times - won't create duplicate loops
     */
    async start() {
        if (this.isRunning) {
            logger.debug(" Queue cleaner already running");
            return;
        }

        this.isRunning = true;
        this.emptyQueueChecks = 0;
        logger.debug(" Queue cleaner started (checking every 30s)");

        await this.runCleanup();
    }

    /**
     * Stop the polling loop
     */
    stop() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }
        this.isRunning = false;
        logger.debug(" Queue cleaner stopped (queue empty)");
    }

    /**
     * Main cleanup logic - runs every 30 seconds when active
     */
    private async runCleanup() {
        if (!this.isRunning) return;

        try {
            // Use getSystemSettings() to get decrypted API key
            const settings = await getSystemSettings();

            if (!settings?.lidarrUrl || !settings?.lidarrApiKey) {
                logger.debug(" Lidarr not configured, stopping queue cleaner");
                this.stop();
                return;
            }

            // PART 0: Check for stale downloads (timed out)
            const staleCount =
                await simpleDownloadManager.markStaleJobsAsFailed();
            if (staleCount > 0) {
                logger.debug(`⏰ Cleaned up ${staleCount} stale download(s)`);
                this.emptyQueueChecks = 0; // Reset counter
            }

            // PART 0.25: Reconcile processing jobs with Lidarr (fix missed webhooks)
            const reconcileResult =
                await simpleDownloadManager.reconcileWithLidarr();
            if (reconcileResult.reconciled > 0) {
                logger.debug(
                    `✓ Reconciled ${reconcileResult.reconciled} job(s) with Lidarr`
                );
                this.emptyQueueChecks = 0; // Reset counter
            }

            // PART 0.26: Sync with Lidarr queue (detect cancelled downloads)
            const queueSyncResult = await simpleDownloadManager.syncWithLidarrQueue();
            if (queueSyncResult.cancelled > 0) {
                logger.debug(
                    `✓ Synced ${queueSyncResult.cancelled} job(s) with Lidarr queue (cancelled/completed)`
                );
                this.emptyQueueChecks = 0; // Reset counter
            }

            // PART 0.3: Reconcile processing jobs with local library (critical fix for #31)
            // Check if albums already exist in Kima's database even if Lidarr webhooks were missed
            const localReconcileResult = await this.reconcileWithLocalLibrary();
            if (localReconcileResult.reconciled > 0) {
                logger.debug(
                    `✓ Reconciled ${localReconcileResult.reconciled} job(s) with local library`
                );
                this.emptyQueueChecks = 0; // Reset counter
            }

            // PART 0.5: Check for stuck discovery batches (batch-level timeout)
            const discoverWeeklyService = await this.getDiscoverWeeklyService();
            const stuckBatchCount =
                await discoverWeeklyService.checkStuckBatches();
            if (stuckBatchCount > 0) {
                logger.debug(
                    `⏰ Force-completed ${stuckBatchCount} stuck discovery batch(es)`
                );
                this.emptyQueueChecks = 0; // Reset counter
            }

            // PART 0.6: Check for stuck Spotify import jobs (scanning timeout)
            const stuckImportCount = await this.checkStuckSpotifyImports();
            if (stuckImportCount > 0) {
                logger.debug(
                    `Recovered ${stuckImportCount} stuck Spotify import job(s)`
                );
                this.emptyQueueChecks = 0;
            }

            // PART 1: Check for stuck downloads needing blocklist + retry
            const cleanResult = await cleanStuckDownloads(
                settings.lidarrUrl,
                settings.lidarrApiKey
            );

            if (cleanResult.removed > 0) {
                logger.debug(
                    `[CLEANUP] Removed ${cleanResult.removed} stuck download(s) - searching for alternatives`
                );
                this.emptyQueueChecks = 0; // Reset counter - queue had activity

                // Update retry count for jobs that might match these titles
                // Note: This is a best-effort match since we only have the title
                for (const title of cleanResult.items) {
                    // Try to extract artist and album from the title
                    // Typical format: "Artist - Album" or "Artist - Album (Year)"
                    const parts = title.split(" - ");
                    if (parts.length >= 2) {
                        const artistName = parts[0].trim();
                        const albumPart = parts.slice(1).join(" - ").trim();
                        // Remove year in parentheses if present
                        const albumTitle = albumPart
                            .replace(/\s*\(\d{4}\)\s*$/, "")
                            .trim();

                        // Find matching processing jobs
                        const matchingJobs = await prisma.downloadJob.findMany({
                            where: {
                                status: "processing",
                                subject: {
                                    contains: albumTitle,
                                    mode: "insensitive",
                                },
                            },
                        });

                        for (const job of matchingJobs) {
                            const metadata = (job.metadata as any) || {};
                            const currentRetryCount = metadata.retryCount || 0;

                            await prisma.downloadJob.update({
                                where: { id: job.id },
                                data: {
                                    metadata: {
                                        ...metadata,
                                        retryCount: currentRetryCount + 1,
                                        lastError:
                                            "Import failed - searching for alternative release",
                                    },
                                },
                            });

                            logger.debug(
                                `   Updated job ${job.id}: retry ${
                                    currentRetryCount + 1
                                }`
                            );
                        }
                    }
                }
            }

            // PART 2: Check for completed downloads (missing webhooks)
            const completedDownloads = await getRecentCompletedDownloads(
                settings.lidarrUrl,
                settings.lidarrApiKey,
                5 // Only check last 5 minutes since we're running frequently
            );

            let recoveredCount = 0;
            let skippedCount = 0;

            for (const download of completedDownloads) {
                // Skip records without album data (can happen with certain event types)
                if (!download.album?.foreignAlbumId) {
                    skippedCount++;
                    continue;
                }

                const mbid = download.album.foreignAlbumId;

                // Find matching job(s) in database by MBID or downloadId
                const orphanedJobs = await prisma.downloadJob.findMany({
                    where: {
                        status: { in: ["processing", "pending"] },
                        OR: [
                            { targetMbid: mbid },
                            { lidarrRef: download.downloadId },
                        ],
                    },
                });

                if (orphanedJobs.length > 0) {
                    const artistName =
                        download.artist?.name || "Unknown Artist";
                    const albumTitle = download.album?.title || "Unknown Album";
                    logger.debug(
                        `Recovered orphaned job: ${artistName} - ${albumTitle}`
                    );
                    logger.debug(`   Download ID: ${download.downloadId}`);
                    this.emptyQueueChecks = 0; // Reset counter - found work to do
                    recoveredCount += orphanedJobs.length;

                    // Mark all matching jobs as complete
                    await prisma.downloadJob.updateMany({
                        where: {
                            id: {
                                in: orphanedJobs.map(
                                    (j: { id: string }) => j.id
                                ),
                            },
                        },
                        data: {
                            status: "completed",
                            completedAt: new Date(),
                        },
                    });

                    // Check batch completion for any Discovery jobs
                    // Use proper checkBatchCompletion() instead of manual logic
                    const discoveryBatchIds = new Set<string>();
                    for (const job of orphanedJobs) {
                        if (job.discoveryBatchId) {
                            discoveryBatchIds.add(job.discoveryBatchId);
                        }
                    }

                    if (discoveryBatchIds.size > 0) {
                        const discoverWeeklyService = await this.getDiscoverWeeklyService();
                        for (const batchId of discoveryBatchIds) {
                            logger.debug(
                                `    Checking Discovery batch completion: ${batchId}`
                            );
                            await discoverWeeklyService.checkBatchCompletion(
                                batchId
                            );
                        }
                    }

                    // Trigger library scan for non-discovery jobs
                    const nonDiscoveryJobs = orphanedJobs.filter(
                        (j: { discoveryBatchId: string | null }) =>
                            !j.discoveryBatchId
                    );
                    if (nonDiscoveryJobs.length > 0) {
                        logger.debug(
                            `    Triggering library scan for recovered job(s)...`
                        );
                        await scanQueue.add("scan", {
                            type: "full",
                            source: "queue-cleaner-recovery",
                        });
                    }
                }
            }

            if (recoveredCount > 0) {
                logger.debug(`Recovered ${recoveredCount} orphaned job(s)`);
            }

            // Only log skipped count occasionally to reduce noise
            if (skippedCount > 0 && this.emptyQueueChecks === 0) {
                logger.debug(
                    `   (Skipped ${skippedCount} incomplete download records)`
                );
            }

            // PART 3: Check if we should stop (no activity)
            const activeJobs = await prisma.downloadJob.count({
                where: {
                    status: { in: ["pending", "processing"] },
                },
            });

            const hadActivity =
                cleanResult.removed > 0 || recoveredCount > 0 || activeJobs > 0;

            if (!hadActivity) {
                this.emptyQueueChecks++;
                logger.debug(
                    ` Queue empty (${this.emptyQueueChecks}/${this.maxEmptyChecks})`
                );

                if (this.emptyQueueChecks >= this.maxEmptyChecks) {
                    logger.debug(
                        ` No activity for ${this.maxEmptyChecks} checks - stopping cleaner`
                    );
                    this.stop();
                    return;
                }
            } else {
                this.emptyQueueChecks = 0;
            }

            // Schedule next check
            this.timeoutId = setTimeout(
                () => this.runCleanup(),
                this.checkInterval
            );
        } catch (error) {
            logger.error(" Queue cleanup error:", error);
            // Still schedule next check even on error
            this.timeoutId = setTimeout(
                () => this.runCleanup(),
                this.checkInterval
            );
        }
    }

    /**
     * Check for Spotify import jobs stuck in "scanning" or "downloading" status.
     * Re-triggers scan for jobs stuck scanning, or forces completion check
     * for jobs stuck downloading.
     */
    async checkStuckSpotifyImports(): Promise<number> {
        const SCANNING_RETRY_TIMEOUT = 10 * 60 * 1000; // 10 minutes - retry scan
        const SCANNING_FAIL_TIMEOUT = 30 * 60 * 1000; // 30 minutes - force fail
        const DOWNLOADING_TIMEOUT = 30 * 60 * 1000; // 30 minutes - force completion check

        const stuckJobs = await prisma.spotifyImportJob.findMany({
            where: {
                status: { in: ["scanning", "downloading"] },
            },
        });

        if (stuckJobs.length === 0) return 0;

        let recoveredCount = 0;

        for (const job of stuckJobs) {
            const jobAge = Date.now() - job.updatedAt.getTime();

            if (job.status === "scanning") {
                if (jobAge > SCANNING_FAIL_TIMEOUT) {
                    logger.debug(
                        `[IMPORT STUCK] Job ${job.id} stuck in scanning for ${Math.round(jobAge / 60000)}min - force failing`
                    );

                    await prisma.spotifyImportJob.update({
                        where: { id: job.id },
                        data: {
                            status: "failed",
                            error: "Scan timed out after 30 minutes",
                        },
                    });
                    recoveredCount++;
                } else if (jobAge > SCANNING_RETRY_TIMEOUT) {
                    logger.debug(
                        `[IMPORT STUCK] Job ${job.id} stuck in scanning for ${Math.round(jobAge / 60000)}min - re-queuing scan`
                    );

                    await scanQueue.add("scan", {
                        userId: job.userId,
                        source: "spotify-import",
                        spotifyImportJobId: job.id,
                    });

                    // Touch updatedAt to prevent re-queuing every 30s
                    await prisma.spotifyImportJob.update({
                        where: { id: job.id },
                        data: { progress: job.progress },
                    });
                    recoveredCount++;
                }
            } else if (job.status === "downloading" && jobAge > DOWNLOADING_TIMEOUT) {
                logger.debug(
                    `[IMPORT STUCK] Job ${job.id} stuck in downloading for ${Math.round(jobAge / 60000)}min - forcing completion check`
                );

                try {
                    const spotifyImportService = await this.getSpotifyImportService();
                    await spotifyImportService.checkImportCompletion(job.id);
                    recoveredCount++;
                } catch (err: any) {
                    logger.debug(
                        `[IMPORT STUCK] Failed to force completion check for ${job.id}: ${err.message}`
                    );
                }
            }
        }

        return recoveredCount;
    }

    /**
     * Reconcile processing jobs with local library (Phase 1 & 3 fix for #31)
     * Checks if albums already exist in Kima's database and marks matching jobs as complete
     * This handles cases where:
     * - Lidarr webhooks were missed
     * - MBID mismatches between MusicBrainz and Lidarr
     * - Album/artist name differences prevent webhook matching
     *
     * Phase 3 enhancement: Uses fuzzy matching to catch more name variations
     *
     * PUBLIC: Called by periodic reconciliation in workers/index.ts
     */
    /**
     * Reconcile processing jobs with local library using batch snapshot approach.
     * Fetches all local albums once, then checks jobs against in-memory data.
     */
    async reconcileWithLocalLibrary(): Promise<{ reconciled: number }> {
        const processingJobs = await prisma.downloadJob.findMany({
            where: { status: { in: ["pending", "processing"] } },
        });

        if (processingJobs.length === 0) {
            return { reconciled: 0 };
        }

        logger.debug(
            `[LOCAL-RECONCILE] Checking ${processingJobs.length} job(s) against local library...`
        );

        // Extract jobs with valid artist/album metadata
        const jobsToCheck = processingJobs
            .map((job) => {
                const metadata = (job.metadata as any) || {};
                return {
                    job,
                    artistName: metadata?.artistName as string | undefined,
                    albumTitle: metadata?.albumTitle as string | undefined,
                };
            })
            .filter((x) => x.artistName && x.albumTitle);

        if (jobsToCheck.length === 0) {
            return { reconciled: 0 };
        }

        // Fetch ALL local albums with tracks in ONE query
        const localAlbums = await prisma.album.findMany({
            where: {
                tracks: { some: {} }, // Only albums with at least one track
            },
            select: {
                id: true,
                title: true,
                artist: { select: { name: true } },
            },
        });

        logger.debug(
            `[LOCAL-RECONCILE] Loaded ${localAlbums.length} local albums for matching`
        );

        // Build normalized lookup index for O(1) exact matching
        const exactIndex = new Map<string, boolean>();
        for (const album of localAlbums) {
            const key = `${album.artist.name.toLowerCase().trim()}|${album.title.toLowerCase().trim()}`;
            exactIndex.set(key, true);
        }

        // Get fuzzy matcher (lazy loaded)
        const matchAlbum = await this.getMatchAlbum();

        // Check all jobs against index
        const toComplete: string[] = [];
        const discoveryBatchIds = new Set<string>();

        for (const { job, artistName, albumTitle } of jobsToCheck) {
            const normalizedArtist = artistName!.toLowerCase().trim();
            const normalizedAlbum = albumTitle!.toLowerCase().trim();
            const exactKey = `${normalizedArtist}|${normalizedAlbum}`;

            let matched = false;

            // Strategy 1: Exact match (O(1))
            if (exactIndex.has(exactKey)) {
                matched = true;
                logger.debug(
                    `[LOCAL-RECONCILE] ✓ Exact match for "${artistName} - ${albumTitle}"`
                );
            }

            // Strategy 2: Contains match (check if album title contains or is contained)
            if (!matched) {
                for (const album of localAlbums) {
                    const libArtist = album.artist.name.toLowerCase().trim();
                    const libAlbum = album.title.toLowerCase().trim();

                    if (
                        libArtist.includes(normalizedArtist) ||
                        normalizedArtist.includes(libArtist)
                    ) {
                        if (
                            libAlbum.includes(normalizedAlbum) ||
                            normalizedAlbum.includes(libAlbum)
                        ) {
                            matched = true;
                            logger.debug(
                                `[LOCAL-RECONCILE] ✓ Contains match "${artistName} - ${albumTitle}" -> "${album.artist.name} - ${album.title}"`
                            );
                            break;
                        }
                    }
                }
            }

            // Strategy 3: Fuzzy match (more expensive, last resort)
            if (!matched) {
                const fuzzyMatch = localAlbums.find((album) =>
                    matchAlbum(
                        artistName!,
                        albumTitle!,
                        album.artist.name,
                        album.title,
                        0.75
                    )
                );

                if (fuzzyMatch) {
                    matched = true;
                    logger.debug(
                        `[LOCAL-RECONCILE] ✓ Fuzzy match "${artistName} - ${albumTitle}" -> "${fuzzyMatch.artist.name} - ${fuzzyMatch.title}"`
                    );
                }
            }

            if (matched) {
                toComplete.push(job.id);
                if (job.discoveryBatchId) {
                    discoveryBatchIds.add(job.discoveryBatchId);
                }
            }
        }

        // Batch update all matched jobs
        if (toComplete.length > 0) {
            await prisma.downloadJob.updateMany({
                where: { id: { in: toComplete } },
                data: {
                    status: "completed",
                    completedAt: new Date(),
                    error: null,
                },
            });
            logger.debug(
                `[LOCAL-RECONCILE] Batch updated ${toComplete.length} job(s) to completed`
            );
        }

        // Check discovery batch completions (deduplicated, with yielding)
        if (discoveryBatchIds.size > 0) {
            const discoverWeeklyService = await this.getDiscoverWeeklyService();
            for (const batchId of discoveryBatchIds) {
                await discoverWeeklyService.checkBatchCompletion(batchId);
                await yieldToEventLoop();
            }
        }

        return { reconciled: toComplete.length };
    }

    /**
     * Get current status (for debugging/monitoring)
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            emptyQueueChecks: this.emptyQueueChecks,
            nextCheckIn: this.isRunning
                ? `${this.checkInterval / 1000}s`
                : "stopped",
        };
    }
}

// Export singleton instance
export const queueCleaner = new QueueCleanerService();
