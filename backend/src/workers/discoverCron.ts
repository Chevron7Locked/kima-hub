/**
 * Discover Weekly Cron Scheduler
 *
 * Automatically generates Discover Weekly playlists on Sunday evenings
 * so users have fresh music waiting Monday morning.
 */

import { logger } from "../utils/logger";
import cron, { ScheduledTask } from "node-cron";
import { prisma } from "../utils/db";
import { discoverQueue } from "./queues";
import { resolveGenerationWeekStart, weekStartKey } from "../lib/discoveryWeek";

let cronTask: ScheduledTask | null = null;

export function startDiscoverWeeklyCron() {
    // Monday 05:00 -- generate at the start of the user's week (was Sunday
    // 20:00, which tagged records with the ending week and hid them).
    // Cron format: minute hour day-of-month month day-of-week
    const schedule = "0 5 * * 1";

    logger.debug(
        `Scheduling Discover Weekly to run: ${schedule} (Mondays at 5 AM)`
    );

    cronTask = cron.schedule(schedule, async () => {
        logger.debug(`\n === Discover Weekly Cron Triggered ===`);
        logger.debug(`   Time: ${new Date().toLocaleString()}`);

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

            for (const config of configs) {
                logger.debug(`   Queueing job for user ${config.userId}...`);

                const weekKey = weekStartKey(resolveGenerationWeekStart(new Date(), 1));
                await discoverQueue.add("discover-weekly", {
                    userId: config.userId,
                }, {
                    jobId: `discover-weekly-${config.userId}-${weekKey}`,
                });
            }

            logger.debug(`   Queued ${configs.length} Discover Weekly jobs`);
        } catch (error: any) {
            logger.error(` Discover Weekly cron error:`, error.message);
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
