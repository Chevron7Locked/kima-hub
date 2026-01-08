import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";
import {
    cleanStuckDownloads,
    getRecentCompletedDownloads,
} from "../services/lidarr";
import { scanQueue } from "../workers/queues";
import { simpleDownloadManager } from "../services/simpleDownloadManager";

class QueueCleanerService {
    private isRunning = false;
    private checkInterval = 30000; // 30 seconds when active
    private emptyQueueChecks = 0;
    private maxEmptyChecks = 3; // Stop after 3 consecutive empty checks
    private timeoutId?: NodeJS.Timeout;

    // Cached dynamic imports (lazy-loaded once, reused on subsequent calls)
    private discoverWeeklyService: typeof import("../services/discoverWeekly")["discoverWeeklyService"] | null = null;
    private matchAlbum: typeof import("../utils/fuzzyMatch")["matchAlbum"] | null = null;

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
            // Check if albums already exist in Lidify's database even if Lidarr webhooks were missed
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
     * Reconcile processing jobs with local library (Phase 1 & 3 fix for #31)
     * Checks if albums already exist in Lidify's database and marks matching jobs as complete
     * This handles cases where:
     * - Lidarr webhooks were missed
     * - MBID mismatches between MusicBrainz and Lidarr
     * - Album/artist name differences prevent webhook matching
     *
     * Phase 3 enhancement: Uses fuzzy matching to catch more name variations
     *
     * PUBLIC: Called by periodic reconciliation in workers/index.ts
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

        let reconciled = 0;

        for (const job of processingJobs) {
            const metadata = (job.metadata as any) || {};
            const artistName = metadata?.artistName;
            const albumTitle = metadata?.albumTitle;

            if (!artistName || !albumTitle) {
                continue;
            }

            try {
                // First try: Exact/contains match (fast)
                let localAlbum = await prisma.album.findFirst({
                    where: {
                        AND: [
                            {
                                artist: {
                                    name: {
                                        contains: artistName,
                                        mode: "insensitive",
                                    },
                                },
                            },
                            {
                                title: {
                                    contains: albumTitle,
                                    mode: "insensitive",
                                },
                            },
                        ],
                    },
                    include: {
                        tracks: {
                            select: { id: true },
                            take: 1,
                        },
                        artist: {
                            select: { name: true },
                        },
                    },
                });

                // Second try: Fuzzy match if exact match failed (slower but more thorough)
                if (!localAlbum || localAlbum.tracks.length === 0) {
                    const matchAlbum = await this.getMatchAlbum();

                    // Get all albums from artists with similar names
                    const candidateAlbums = await prisma.album.findMany({
                        where: {
                            artist: {
                                name: {
                                    contains: artistName.substring(0, 5),
                                    mode: "insensitive",
                                },
                            },
                        },
                        include: {
                            tracks: {
                                select: { id: true },
                                take: 1,
                            },
                            artist: {
                                select: { name: true },
                            },
                        },
                        take: 50, // Limit to prevent performance issues
                    });

                    // Find best fuzzy match
                    const fuzzyMatch = candidateAlbums.find(
                        (album) =>
                            album.tracks.length > 0 &&
                            matchAlbum(
                                artistName,
                                albumTitle,
                                album.artist.name,
                                album.title,
                                0.75
                            )
                    );

                    if (fuzzyMatch) {
                        localAlbum = fuzzyMatch;
                    }

                    if (localAlbum) {
                        logger.debug(
                            `[LOCAL-RECONCILE] Fuzzy matched "${artistName} - ${albumTitle}" to "${localAlbum.artist.name} - ${localAlbum.title}"`
                        );
                    }
                }

                if (localAlbum && localAlbum.tracks.length > 0) {
                    logger.debug(
                        `[LOCAL-RECONCILE] ✓ Found "${localAlbum.artist.name} - ${localAlbum.title}" in library for job ${job.id}`
                    );

                    // Album exists with tracks - mark job complete
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: "completed",
                            completedAt: new Date(),
                            error: null,
                            metadata: {
                                ...metadata,
                                completedAt: new Date().toISOString(),
                                reconciledFromLocalLibrary: true,
                            },
                        },
                    });

                    reconciled++;

                    // Check batch completion for discovery jobs
                    if (job.discoveryBatchId) {
                        const discoverWeeklyService = await this.getDiscoverWeeklyService();
                        await discoverWeeklyService.checkBatchCompletion(
                            job.discoveryBatchId
                        );
                    }
                }
            } catch (error: any) {
                logger.error(
                    `[LOCAL-RECONCILE] Error checking job ${job.id}:`,
                    error.message
                );
            }
        }

        if (reconciled > 0) {
            logger.debug(
                `[LOCAL-RECONCILE] Marked ${reconciled} job(s) complete from local library`
            );
        }

        return { reconciled };
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
