/**
 * With "Auto sync library" on, periodically requests a full scan so files added
 * outside the download pipeline are picked up. requestScan dedupes, so a tick
 * while a scan is queued or running does nothing.
 */

import { logger } from "../utils/logger";
import cron, { ScheduledTask } from "node-cron";
import { getSystemSettings } from "../utils/systemSettings";
import { requestScan } from "./scanRequest";

let cronTask: ScheduledTask | null = null;

export function startLibrarySyncCron() {
    // Every 6 hours. Cron format: minute hour day-of-month month day-of-week
    const schedule = "0 */6 * * *";
    logger.debug(`Scheduling library auto-sync: ${schedule} (every 6h)`);

    cronTask = cron.schedule(schedule, async () => {
        try {
            const settings = await getSystemSettings();
            if (!settings?.autoSync) {
                logger.debug("[LibrarySync] autoSync disabled, skipping");
                return;
            }

            // requestScan dedupes: if any full scan is already waiting,
            // delayed, or active, this tick is a no-op.
            const result = await requestScan({
                source: "auto-sync",
            });
            if (result.queued) {
                logger.debug("[LibrarySync] Enqueued automatic library scan");
            } else {
                logger.debug(`[LibrarySync] ${result.reason}, skipping`);
            }
        } catch (error) {
            logger.error("[LibrarySync] cron error:", (error as Error).message);
        }
    });

    logger.debug("Library auto-sync cron scheduler started");
}

export function stopLibrarySyncCron() {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
        logger.debug("Library auto-sync cron scheduler stopped");
    }
}
