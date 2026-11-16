import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { queues } from "../workers/queues";
import * as downloadJobs from "./downloads/jobs";

const STALE_THRESHOLDS = {
    discoveryBatch: 60 * 60 * 1000, // 1 hour
    downloadJob: 2 * 60 * 60 * 1000, // 2 hours
    spotifyImportJob: 2 * 60 * 60 * 1000, // 2 hours
    bullQueueRetention: 7 * 24 * 60 * 60 * 1000, // 7 days
};

interface CleanupResult {
    discoveryBatches: { cleaned: number; ids: string[] };
    downloadJobs: { cleaned: number; ids: string[] };
    spotifyImportJobs: { cleaned: number; ids: string[] };
    bullQueues: { cleaned: number; queues: string[] };
    totalCleaned: number;
}

class StaleJobCleanupService {
    async cleanupAll(): Promise<CleanupResult> {
        logger.debug("[STALE-CLEANUP] Starting on-demand cleanup...");

        const [
            discoveryBatches,
            downloadJobs,
            spotifyImportJobs,
            bullQueues,
        ] = await Promise.all([
            this.cleanupDiscoveryBatches(),
            this.cleanupDownloadJobs(),
            this.cleanupSpotifyImportJobs(),
            this.cleanupBullQueues(),
        ]);

        const totalCleaned =
            discoveryBatches.cleaned +
            downloadJobs.cleaned +
            spotifyImportJobs.cleaned +
            bullQueues.cleaned;

        logger.debug(`[STALE-CLEANUP] Complete. Total cleaned: ${totalCleaned}`);

        return {
            discoveryBatches,
            downloadJobs,
            spotifyImportJobs,
            bullQueues,
            totalCleaned,
        };
    }

    private async cleanupDiscoveryBatches() {
        const cutoff = new Date(Date.now() - STALE_THRESHOLDS.discoveryBatch);

        const staleBatches = await prisma.discoveryBatch.findMany({
            where: {
                status: { in: ["downloading", "scanning"] },
                createdAt: { lt: cutoff },
            },
            select: { id: true },
        });

        if (staleBatches.length === 0) {
            return { cleaned: 0, ids: [] };
        }

        const ids = staleBatches.map((b) => b.id);
        logger.debug(
            `[STALE-CLEANUP] Cleaning ${
                ids.length
            } discovery batches: ${ids.join(", ")}`
        );

        await prisma.discoveryBatch.updateMany({
            where: { id: { in: ids } },
            data: {
                status: "failed",
                errorMessage: "Cleaned up as stale by user request",
            },
        });

        // Also clean associated DownloadJobs that reference these batches
        const batchJobs = await prisma.downloadJob.findMany({
            where: {
                discoveryBatchId: { in: ids },
                status: { in: downloadJobs.ACTIVE_STATUSES },
            },
            select: { id: true },
        });
        await downloadJobs.fail(batchJobs, "Parent batch cleaned up as stale");

        return { cleaned: ids.length, ids };
    }

    private async cleanupDownloadJobs() {
        const cutoff = new Date(Date.now() - STALE_THRESHOLDS.downloadJob);

        // Find stale jobs (not already handled by batch cleanup)
        const staleJobs = await prisma.downloadJob.findMany({
            where: {
                status: { in: downloadJobs.ACTIVE_STATUSES },
                createdAt: { lt: cutoff },
            },
            select: { id: true },
        });

        if (staleJobs.length === 0) {
            return { cleaned: 0, ids: [] };
        }

        logger.debug(`[STALE-CLEANUP] Cleaning ${staleJobs.length} download jobs`);

        // Settling tells each job's batch and import, so one that was waiting on a stale job can finish.
        const settled = await downloadJobs.fail(staleJobs, "Cleaned up as stale by user request");
        const ids = settled.map((j) => j.id);

        return { cleaned: ids.length, ids };
    }

    private async cleanupSpotifyImportJobs() {
        const cutoff = new Date(Date.now() - STALE_THRESHOLDS.spotifyImportJob);

        const staleJobs = await prisma.spotifyImportJob.findMany({
            where: {
                status: {
                    in: [
                        "pending",
                        "fetching",
                        "downloading",
                        "scanning",
                        "creating_playlist",
                    ],
                },
                createdAt: { lt: cutoff },
            },
            select: { id: true },
        });

        if (staleJobs.length === 0) {
            return { cleaned: 0, ids: [] };
        }

        const ids = staleJobs.map((j) => j.id);
        logger.debug(
            `[STALE-CLEANUP] Cleaning ${ids.length} Spotify import jobs`
        );

        await prisma.spotifyImportJob.updateMany({
            where: { id: { in: ids } },
            data: {
                status: "failed",
                error: "Cleaned up as stale by user request",
            },
        });

        return { cleaned: ids.length, ids };
    }

    private async cleanupBullQueues() {
        const retentionMs = STALE_THRESHOLDS.bullQueueRetention;
        let totalCleaned = 0;
        const cleanedQueues: string[] = [];

        for (const queue of queues) {
            try {
                const completedCleaned = await queue.clean(
                    retentionMs,
                    1000,
                    "completed"
                );
                const failedCleaned = await queue.clean(retentionMs, 1000, "failed");

                const queueCleaned =
                    completedCleaned.length + failedCleaned.length;
                if (queueCleaned > 0) {
                    logger.debug(
                        `[STALE-CLEANUP] Cleaned ${queueCleaned} jobs from ${queue.name}`
                    );
                    totalCleaned += queueCleaned;
                    cleanedQueues.push(queue.name);
                }
            } catch (error) {
                logger.error(
                    `[STALE-CLEANUP] Error cleaning queue ${queue.name}:`,
                    error
                );
            }
        }

        return { cleaned: totalCleaned, queues: cleanedQueues };
    }
}

export const staleJobCleanupService = new StaleJobCleanupService();
