/**
 * Daily at 2 AM: delete completed or failed download jobs and processed webhook
 * events after 30 days, completed discovery batches after 60.
 */

import { logger } from "../utils/logger";
import * as downloadJobs from "../services/downloads/jobs";
import cron, { ScheduledTask } from "node-cron";
import { prisma } from "../utils/db";

let cronTask: ScheduledTask | null = null;

const RETENTION_DAYS = {
    downloadJobs: 30,
    webhookEvents: 30,
    discoveryBatches: 60,
};

async function cleanupDownloadJobs(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS.downloadJobs);

    const result = await prisma.downloadJob.deleteMany({
        where: {
            status: { in: downloadJobs.SETTLED_STATUSES },
            completedAt: {
                lt: cutoffDate,
            },
        },
    });

    return result.count;
}

async function cleanupWebhookEvents(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS.webhookEvents);

    const result = await prisma.webhookEvent.deleteMany({
        where: {
            processed: true,
            createdAt: {
                lt: cutoffDate,
            },
        },
    });

    return result.count;
}

async function cleanupDiscoveryBatches(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS.discoveryBatches);

    const result = await prisma.discoveryBatch.deleteMany({
        where: {
            status: "completed",
            completedAt: {
                lt: cutoffDate,
            },
        },
    });

    return result.count;
}

export function startDataCleanupCron() {
    const schedule = "0 2 * * *";

    logger.debug(
        `Scheduling data cleanup to run: ${schedule} (daily at 2 AM)`
    );

    cronTask = cron.schedule(schedule, async () => {
        logger.debug("[DataCleanup] Triggered");

        try {
            const { downloadJobs, webhookEvents, discoveryBatches, total } = await runDataCleanup();
            logger.debug(
                `   Cleaned up ${downloadJobs} old download job(s) (>${RETENTION_DAYS.downloadJobs} days)`
            );
            logger.debug(
                `   Cleaned up ${webhookEvents} old webhook event(s) (>${RETENTION_DAYS.webhookEvents} days)`
            );
            logger.debug(
                `   Cleaned up ${discoveryBatches} old discovery batch(es) (>${RETENTION_DAYS.discoveryBatches} days)`
            );

            if (total > 0) {
                logger.debug(`   Total records cleaned: ${total}`);
            } else {
                logger.debug(`   No old records to clean up`);
            }
        } catch (error) {
            logger.error(` Data cleanup cron error:`, error);
        }
    });

    logger.debug("Data cleanup cron scheduler started");
}

export function stopDataCleanupCron() {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
        logger.debug("Data cleanup cron scheduler stopped");
    }
}

/** Delete every expired row from the three tables and report how many went from each. */
export async function runDataCleanup(): Promise<{
    downloadJobs: number;
    webhookEvents: number;
    discoveryBatches: number;
    total: number;
}> {
    const jobsDeleted = await cleanupDownloadJobs();
    const eventsDeleted = await cleanupWebhookEvents();
    const batchesDeleted = await cleanupDiscoveryBatches();

    return {
        downloadJobs: jobsDeleted,
        webhookEvents: eventsDeleted,
        discoveryBatches: batchesDeleted,
        total: jobsDeleted + eventsDeleted + batchesDeleted,
    };
}
