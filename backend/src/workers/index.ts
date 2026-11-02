import { Worker } from "bullmq";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import {
    scanQueue,
    discoverQueue,
    importQueue,
} from "./queues";
import { processScan } from "./processors/scanProcessor";
import { processRefile } from "./processors/refileProcessor";
import { processDiscoverWeekly } from "./processors/discoverProcessor";
import { processImportJob } from "./processors/importProcessor";
import { createWorkerConnection } from "./enrichmentQueues";
import { withTimeout } from "../utils/timeout";
import { spotifyImportService } from "../services/spotifyImport";
import {
    startUnifiedEnrichmentWorker,
    triggerEnrichmentNow,
    stopUnifiedEnrichmentWorker,
} from "./unifiedEnrichment";
import {
    startMoodSnapshotWorker,
    stopMoodSnapshotWorker,
} from "./moodSnapshotWorker";
import {
    startDiscoverWeeklyCron,
    stopDiscoverWeeklyCron,
} from "./discoverCron";
import {
    startDataCleanupCron,
    stopDataCleanupCron,
} from "./dataCleanup";
import {
    startLibrarySyncCron,
    stopLibrarySyncCron,
} from "./librarySyncCron";
import { runDataIntegrityCheck } from "./dataIntegrity";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { sweepFailedDownloads } from "../services/lidarrFailures";
import { queueCleaner } from "../jobs/queueCleaner";
import { enrichmentStateService } from "../services/enrichmentState";
import { warmRadioCovers } from "../services/mixes/radioRow";

// One pending timer per self-rescheduling cycle, so handles never pile up; shutdown clears them.
const timers = new Map<string, NodeJS.Timeout>();
function schedule(name: string, run: () => void, ms: number) {
    timers.set(name, setTimeout(run, ms));
}

// BullMQ workers for scan and discover queues
// The album re-file shares the scan queue so it never runs beside a scan.
const scanWorker = new Worker("library-scan-v2", (job) => (job.name === "refile" ? processRefile(job) : processScan(job)), {
    connection: createWorkerConnection(),
    concurrency: 1,
    lockDuration: 300000, // 5 minutes — scans can be slow
});

const discoverWorker = new Worker("discover-weekly-v2", processDiscoverWeekly, {
    connection: createWorkerConnection(),
    concurrency: 1,
    lockDuration: 120000,
});

const importWorker = new Worker("playlist-import", processImportJob, {
    connection: createWorkerConnection(),
    concurrency: 1,
    lockDuration: 600000, // 10 minutes -- imports with downloads can be slow
});

// The enrichment loop: identification, artist metadata, analysis and sound vectors, moods, similarity.
startUnifiedEnrichmentWorker().catch((err) => {
    logger.error("Failed to start unified enrichment worker:", err);
});

// Keeps the vibe map's and mood presets' song moods current
startMoodSnapshotWorker().catch((err) => {
    logger.error("Failed to start mood snapshot worker:", err);
});

// Event handlers for scan worker
scanWorker.on("completed", (job, result) => {
    if (job.name === "refile") {
        logger.debug(`Re-file job ${job.id} completed: ${result.albumsMoved} moved, ${result.albumsMerged} merged, ${result.albumsFailed} failed`);
        return;
    }
    logger.debug(
        `Scan job ${job.id} completed: +${result.tracksAdded} ~${result.tracksUpdated} missing:${result.tracksMissing} removed:${result.tracksRemoved}`
    );
    // Enrichment waits while a scan runs (scanActivity.ts); new songs start it now, not at the next timed cycle. Only then:
    // a trigger also runs one cycle past an operator's stop.
    if (result.tracksAdded > 0) {
        triggerEnrichmentNow().catch((err) => logger.error("Failed to start enrichment after the scan:", err));
    }
});

scanWorker.on("failed", (job, err) => {
    logger.error(`Scan job ${job?.id} failed:`, err.message);
});

scanWorker.on("active", (job) => {
    logger.debug(`Scan job ${job.id} started`);
});

scanWorker.on("error", (err) => {
    logger.error("Scan worker error:", err.message);
});

// Event handlers for discover worker
discoverWorker.on("completed", (job, result) => {
    if (result.success) {
        logger.debug(
            `Discover job ${job.id} completed: ${result.downloadsQueued} album downloads queued (batch ${result.batchId})`
        );
    } else {
        logger.debug(`Discover job ${job.id} failed: ${result.error}`);
    }
});

discoverWorker.on("failed", (job, err) => {
    logger.error(`Discover job ${job?.id} failed:`, err.message);
});

discoverWorker.on("active", (job) => {
    logger.debug(`Discover job ${job.id} started for user ${job.data.userId}`);
});

discoverWorker.on("error", (err) => {
    logger.error("Discover worker error:", err.message);
});

// Event handlers for import worker
importWorker.on("completed", (job) => {
    logger.info(`[ImportWorker] Job ${job.id} completed`);
});

importWorker.on("failed", async (job, err) => {
    logger.error(`[ImportWorker] Job ${job?.id} failed: ${err.message}`);
    if (job?.data?.importJobId) {
        try {
            await spotifyImportService.markJobFailed(job.data.importJobId, err.message);
        } catch (e: any) {
            logger.error(`[ImportWorker] Failed to mark job as failed: ${e.message}`);
        }
    }
});

importWorker.on("error", (err) => {
    logger.error("[ImportWorker] Worker error:", err.message);
});

logger.debug("BullMQ workers registered and event handlers attached");

// Start Discovery Weekly cron scheduler (Mondays at 5 AM)
startDiscoverWeeklyCron();

// Start data cleanup cron scheduler (daily at 2 AM)
startDataCleanupCron();

// Start library auto-sync cron (every 6h, gated on the autoSync setting)
startLibrarySyncCron();

// Running guards to prevent pile-up when tasks take longer than their interval
let dataIntegrityRunning = false;
let reconciliationRunning = false;

// Self-rescheduling data integrity check (prevents pile-up on slow runs)
async function runDataIntegrityCycle() {
    if (dataIntegrityRunning) return;
    dataIntegrityRunning = true;
    try {
        await runDataIntegrityCheck();
    } catch (err) {
        logger.error("Data integrity check failed:", err);
    } finally {
        dataIntegrityRunning = false;
        schedule("data-integrity", runDataIntegrityCycle, 24 * 60 * 60 * 1000);
    }
}

// First run 10 seconds after startup
schedule("data-integrity", runDataIntegrityCycle, 10000);

// Each listener's radio covers are picked as their day begins, so their first visit reads them (radioRow.ts).
let radioCoversRunning = false;
async function runRadioCoversCycle() {
    if (radioCoversRunning) return;
    radioCoversRunning = true;
    try {
        await warmRadioCovers();
    } catch (err) {
        logger.error("Picking radio covers ahead failed:", err);
    } finally {
        radioCoversRunning = false;
        schedule("radio-covers", runRadioCoversCycle, 5 * 60 * 1000);
    }
}
schedule("radio-covers", runRadioCoversCycle, 60 * 1000);
logger.debug("Data integrity check scheduled (every 24 hours, self-rescheduling)");

// The one place downloads move outside webhooks. Each cycle reads Lidarr once,
// completes what arrived before judging anything else, then acts on the queue,
// follows replaced downloads and checks jobs still waiting for one. It schedules
// the next cycle when it finishes and does nothing while no download is active.
async function runReconciliationCycle() {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    try {
        const activeJobs = await prisma.downloadJob.count({
            where: { status: { in: ["pending", "processing"] } },
        });
        if (activeJobs === 0) return;

        const { lidarrService } = await import("../services/lidarr");
        const snapshot = await withTimeout(lidarrService.getReconciliationSnapshot(), 30000, "Lidarr snapshot timed out");
        const steps: [string, () => Promise<unknown>][] = [
            ["complete from Lidarr", () => simpleDownloadManager.reconcileWithLidarr(snapshot)],
            ["complete from the library", () => queueCleaner.reconcileWithLocalLibrary()],
            ["judge Lidarr's queue", () => (snapshot ? sweepFailedDownloads(snapshot) : Promise.resolve())],
            ["follow replaced downloads", () => simpleDownloadManager.syncWithLidarrQueue(snapshot)],
            ["check waiting jobs", () => simpleDownloadManager.checkWaitingJobs(snapshot)],
        ];
        // Each step stands alone: one that fails must not stop the others this cycle.
        for (const [name, step] of steps) {
            try {
                await withTimeout(step(), 120000, `${name} timed out`);
            } catch (err) {
                logger.error(`Download reconciliation: ${name} failed:`, err);
            }
        }
    } catch (err) {
        logger.error("Download reconciliation failed:", err);
    } finally {
        reconciliationRunning = false;
        schedule("reconciliation", runReconciliationCycle, 2 * 60 * 1000);
    }
}

schedule("reconciliation", runReconciliationCycle, 2 * 60 * 1000);
logger.debug("Download reconciliation scheduled (every 2 minutes, self-rescheduling)");

async function runStuckWorkCycle() {
    try {
        await withTimeout(queueCleaner.recoverStuckWork(), 120000, "stuck work recovery timed out");
    } catch (err) {
        logger.error("Stuck work recovery failed:", err);
    } finally {
        schedule("stuck-work", runStuckWorkCycle, 2 * 60 * 1000);
    }
}

schedule("stuck-work", runStuckWorkCycle, 60 * 1000);

/**
 * Gracefully shutdown all workers and cleanup resources
 */
export async function shutdownWorkers(): Promise<void> {
    logger.debug("Shutting down workers...");

    // Stop unified enrichment worker (async — closes BullMQ workers and queues)
    await stopUnifiedEnrichmentWorker();

    // Disconnect enrichment state service Redis connections (2 connections)
    try {
        await enrichmentStateService.disconnect();
        logger.debug("Enrichment state service disconnected");
    } catch (err) {
        logger.error("Failed to disconnect enrichment state service:", err);
    }

    stopMoodSnapshotWorker();

    // Stop discover weekly cron
    stopDiscoverWeeklyCron();

    // Stop data cleanup cron
    stopDataCleanupCron();

    // Stop library auto-sync cron
    stopLibrarySyncCron();

    // Clear all timeouts
    for (const timeout of timers.values()) {
        clearTimeout(timeout);
    }
    timers.clear();

    // Close workers first so in-flight jobs complete, then close queues
    await Promise.all([scanWorker.close(), discoverWorker.close(), importWorker.close()]);
    await Promise.all([scanQueue.close(), discoverQueue.close(), importQueue.close()]);

    logger.debug("Workers shutdown complete");
}
