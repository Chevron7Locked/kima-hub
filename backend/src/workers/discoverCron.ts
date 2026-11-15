/**
 * Discover Weekly Cron Scheduler
 *
 * Generates Discover Weekly playlists on Monday at 05:00, the start of the
 * user's week, so fresh music is waiting in the morning.
 */

import { logger } from "../utils/logger";
import cron, { ScheduledTask } from "node-cron";
import { prisma } from "../utils/db";
import { queueWeeklyJob } from "../services/discovery/weeklyJob";
import { distributedLock } from "../utils/distributedLock";
import { LockUnavailableError } from "../utils/lockErrors";

let cronTask: ScheduledTask | null = null;

export function startDiscoverWeeklyCron() {
    const schedule = "0 5 * * 1";

    logger.debug(
        `Scheduling Discover Weekly to run: ${schedule} (Mondays at 5 AM)`
    );

    cronTask = cron.schedule(schedule, async () => {
        logger.debug("[DiscoverCron] Triggered");

        try {
            // Get all users with Discover Weekly enabled
            const configs = await prisma.userDiscoverConfig.findMany({
                where: {
                    enabled: true,
                },
                select: {
                    userId: true,
                    playlistSize: true,
                },
            });

            logger.debug(
                `   Found ${configs.length} users with Discover Weekly enabled`
            );

            let queued = 0;
            for (const config of configs) {
                logger.debug(`   Queueing job for user ${config.userId}...`);

                // Past a lost lock another enqueue may have run; this one is skipped, as a held lock skips it.
                const enqueue = (signal?: AbortSignal) => queueWeeklyJob(config.userId, signal);
                try {
                    try {
                        await distributedLock.withLock(`discover:generate:${config.userId}`, 30000, enqueue);
                    } catch (e) {
                        if (!(e instanceof LockUnavailableError)) throw e;
                        // Nobody can be asked who holds the lock. The job id is the same for this user and week, so the
                        // queue ignores a second add: queueing without the lock cannot double the job, and skipping would
                        // leave the user with no Discover this week.
                        logger.warn(`[DiscoverCron] no lock for ${config.userId} (${e.message}), enqueuing without it`);
                        await enqueue();
                    }
                    queued++;
                } catch (e) {
                    logger.warn(
                        `[DiscoverCron] enqueue skipped for ${config.userId}: ${(e as Error).message}`,
                    );
                }
            }

            logger.debug(`   Queued ${queued} of ${configs.length} Discover Weekly jobs`);
        } catch (error) {
            logger.error(` Discover Weekly cron error:`, (error as Error).message);
        }
    });

    logger.debug("Discover Weekly cron scheduler started");
}

export function stopDiscoverWeeklyCron() {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
        logger.debug("Discover Weekly cron scheduler stopped");
    }
}
