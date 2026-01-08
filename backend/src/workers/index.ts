import { logger } from "../utils/logger";
import {
    scanQueue,
    discoverQueue,
    imageQueue,
    validationQueue,
} from "./queues";
import { processScan } from "./processors/scanProcessor";
import { processDiscoverWeekly } from "./processors/discoverProcessor";
import { processImageOptimization } from "./processors/imageProcessor";
import { processValidation } from "./processors/validationProcessor";
import {
    startUnifiedEnrichmentWorker,
    stopUnifiedEnrichmentWorker,
} from "./unifiedEnrichment";
import {
    startMoodBucketWorker,
    stopMoodBucketWorker,
} from "./moodBucketWorker";
import { downloadQueueManager } from "../services/downloadQueue";
import { prisma } from "../utils/db";
import {
    startDiscoverWeeklyCron,
    stopDiscoverWeeklyCron,
} from "./discoverCron";
import { runDataIntegrityCheck } from "./dataIntegrity";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { queueCleaner } from "../jobs/queueCleaner";

// Track intervals and timeouts for cleanup
const intervals: NodeJS.Timeout[] = [];
const timeouts: NodeJS.Timeout[] = [];

// Register processors with named job types
scanQueue.process("scan", processScan);
discoverQueue.process(processDiscoverWeekly);
imageQueue.process(processImageOptimization);
validationQueue.process(processValidation);

// Register download queue callback for unavailable albums
downloadQueueManager.onUnavailableAlbum(async (info) => {
    logger.debug(
        ` Recording unavailable album: ${info.artistName} - ${info.albumTitle}`
    );

    if (!info.userId) {
        logger.debug(` No userId provided, skipping database record`);
        return;
    }

    try {
        // Get week start date from discovery album if it exists
        const discoveryAlbum = await prisma.discoveryAlbum.findFirst({
            where: { rgMbid: info.albumMbid },
            orderBy: { downloadedAt: "desc" },
        });

        await prisma.unavailableAlbum.create({
            data: {
                userId: info.userId,
                artistName: info.artistName,
                albumTitle: info.albumTitle,
                albumMbid: info.albumMbid,
                artistMbid: info.artistMbid,
                similarity: info.similarity || 0,
                tier: info.tier || "unknown",
                weekStartDate: discoveryAlbum?.weekStartDate || new Date(),
                attemptNumber: 0,
            },
        });

        logger.debug(`   Recorded in database`);
    } catch (error: any) {
        // Handle duplicate entries (album already marked as unavailable)
        if (error.code === "P2002") {
            logger.debug(`     Album already marked as unavailable`);
        } else {
            logger.error(
                ` Failed to record unavailable album:`,
                error.message
            );
        }
    }
});

// Start unified enrichment worker
// Handles: artist metadata, track tags (Last.fm), audio analysis queueing (Essentia)
startUnifiedEnrichmentWorker().catch((err) => {
    logger.error("Failed to start unified enrichment worker:", err);
});

// Start mood bucket worker
// Assigns newly analyzed tracks to mood buckets for fast mood mix generation
startMoodBucketWorker().catch((err) => {
    logger.error("Failed to start mood bucket worker:", err);
});

// Event handlers for scan queue
scanQueue.on("completed", (job, result) => {
    logger.debug(
        `Scan job ${job.id} completed: +${result.tracksAdded} ~${result.tracksUpdated} -${result.tracksRemoved}`
    );
});

scanQueue.on("failed", (job, err) => {
    logger.error(`Scan job ${job.id} failed:`, err.message);
});

scanQueue.on("active", (job) => {
    logger.debug(` Scan job ${job.id} started`);
});

// Event handlers for discover queue
discoverQueue.on("completed", (job, result) => {
    if (result.success) {
        logger.debug(
            `Discover job ${job.id} completed: ${result.playlistName} (${result.songCount} songs)`
        );
    } else {
        logger.debug(`Discover job ${job.id} failed: ${result.error}`);
    }
});

discoverQueue.on("failed", (job, err) => {
    logger.error(`Discover job ${job.id} failed:`, err.message);
});

discoverQueue.on("active", (job) => {
    logger.debug(` Discover job ${job.id} started for user ${job.data.userId}`);
});

// Event handlers for image queue
imageQueue.on("completed", (job, result) => {
    logger.debug(
        `Image job ${job.id} completed: ${
            result.success ? "success" : result.error
        }`
    );
});

imageQueue.on("failed", (job, err) => {
    logger.error(`Image job ${job.id} failed:`, err.message);
});

// Event handlers for validation queue
validationQueue.on("completed", (job, result) => {
    logger.debug(
        `Validation job ${job.id} completed: ${result.tracksChecked} checked, ${result.tracksRemoved} removed`
    );
});

validationQueue.on("failed", (job, err) => {
    logger.error(` Validation job ${job.id} failed:`, err.message);
});

validationQueue.on("active", (job) => {
    logger.debug(` Validation job ${job.id} started`);
});

logger.debug("Worker processors registered and event handlers attached");

// Start Discovery Weekly cron scheduler (Sundays at 8 PM)
startDiscoverWeeklyCron();

// Run data integrity check on startup and then every 24 hours
timeouts.push(
    setTimeout(() => {
        runDataIntegrityCheck().catch((err) => {
            logger.error("Data integrity check failed:", err);
        });
    }, 10000) // Run 10 seconds after startup
);

intervals.push(
    setInterval(() => {
        runDataIntegrityCheck().catch((err) => {
            logger.error("Data integrity check failed:", err);
        });
    }, 24 * 60 * 60 * 1000) // Run every 24 hours
);

logger.debug("Data integrity check scheduled (every 24 hours)");

// Run stale download cleanup every 2 minutes
// This catches downloads that timed out even if the queue cleaner isn't running
// Also runs reconciliation to catch missed webhooks (fix for #31)
intervals.push(
    setInterval(async () => {
        try {
            // Mark stale/timed out downloads as failed
            const staleCount =
                await simpleDownloadManager.markStaleJobsAsFailed();
            if (staleCount > 0) {
                logger.debug(
                    `⏰ Periodic cleanup: marked ${staleCount} stale download(s) as failed`
                );
            }

            // Reconcile with Lidarr (catches missed completion webhooks)
            const lidarrResult =
                await simpleDownloadManager.reconcileWithLidarr();
            if (lidarrResult.reconciled > 0) {
                logger.debug(
                    `✓ Periodic reconcile: ${lidarrResult.reconciled} job(s) matched in Lidarr`
                );
            }

            // Reconcile with local library (catches direct Soulseek downloads)
            // Fix for #31: Active downloads not resolving
            const localResult = await queueCleaner.reconcileWithLocalLibrary();
            if (localResult.reconciled > 0) {
                logger.debug(
                    `✓ Periodic reconcile: ${localResult.reconciled} job(s) matched in local library`
                );
            }
        } catch (err) {
            logger.error(
                "Periodic download cleanup/reconciliation failed:",
                err
            );
        }
    }, 2 * 60 * 1000) // Every 2 minutes
);

logger.debug("Stale download cleanup scheduled (every 2 minutes)");

// Run Lidarr queue cleanup every 5 minutes
// This catches stuck/failed imports even if webhooks fail
intervals.push(
    setInterval(async () => {
        try {
            const result = await simpleDownloadManager.clearLidarrQueue();
            if (result.removed > 0) {
                logger.debug(
                    `Periodic Lidarr cleanup: removed ${result.removed} stuck download(s)`
                );
            }
        } catch (err) {
            logger.error("Lidarr queue cleanup failed:", err);
        }
    }, 5 * 60 * 1000) // Every 5 minutes
);

logger.debug("Lidarr queue cleanup scheduled (every 5 minutes)");

// Run initial Lidarr cleanup 30 seconds after startup (to catch any stuck items)
timeouts.push(
    setTimeout(async () => {
        try {
            logger.debug("Running initial Lidarr queue cleanup...");
            const result = await simpleDownloadManager.clearLidarrQueue();
            if (result.removed > 0) {
                logger.debug(
                    `Initial cleanup: removed ${result.removed} stuck download(s)`
                );
            } else {
                logger.debug("Initial cleanup: queue is clean");
            }
        } catch (err) {
            logger.error("Initial Lidarr cleanup failed:", err);
        }
    }, 30 * 1000) // 30 seconds after startup
);

/**
 * Gracefully shutdown all workers and cleanup resources
 */
export async function shutdownWorkers(): Promise<void> {
    logger.debug("Shutting down workers...");

    // Stop unified enrichment worker
    stopUnifiedEnrichmentWorker();

    // Stop mood bucket worker
    stopMoodBucketWorker();

    // Stop discover weekly cron
    stopDiscoverWeeklyCron();

    // Shutdown download queue manager
    downloadQueueManager.shutdown();

    // Clear all intervals
    for (const interval of intervals) {
        clearInterval(interval);
    }
    intervals.length = 0;

    // Clear all timeouts
    for (const timeout of timeouts) {
        clearTimeout(timeout);
    }
    timeouts.length = 0;

    // Remove all event listeners to prevent memory leaks
    scanQueue.removeAllListeners();
    discoverQueue.removeAllListeners();
    imageQueue.removeAllListeners();
    validationQueue.removeAllListeners();

    // Close all queues gracefully
    await Promise.all([
        scanQueue.close(),
        discoverQueue.close(),
        imageQueue.close(),
        validationQueue.close(),
    ]);

    logger.debug("Workers shutdown complete");
}

// Export queues for use in other modules
export { scanQueue, discoverQueue, imageQueue, validationQueue };
