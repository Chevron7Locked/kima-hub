/**
 * Library Auto-Sync Cron
 *
 * When the "Auto sync library" setting is enabled, periodically enqueues a full
 * library scan so music added outside the download pipeline (manual file drops,
 * external tools) is picked up without a manual scan. Download-completion
 * webhooks already trigger scans; this is the fallback for everything else.
 *
 * No fixed jobId is used -- a fresh job each tick avoids BullMQ's failed/
 * completed dedup-marker trap, and at a 6h cadence scans cannot pile up.
 */

import { logger } from "../utils/logger";
import cron, { ScheduledTask } from "node-cron";
import { getSystemSettings } from "../utils/systemSettings";
import { config } from "../config";
import { scanQueue } from "./queues";

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

            // Skip if a scan (manual, webhook, or a prior auto-sync) is already
            // active or waiting -- no point queuing a redundant full rescan
            // behind one that's about to cover the same files.
            const counts = await scanQueue.getJobCounts("active", "waiting");
            if ((counts.active ?? 0) + (counts.waiting ?? 0) > 0) {
                logger.debug("[LibrarySync] scan already in progress, skipping");
                return;
            }

            await scanQueue.add("scan", {
                musicPath: config.music.musicPath,
                source: "auto-sync",
            });
            logger.debug("[LibrarySync] Enqueued automatic library scan");
        } catch (error: any) {
            logger.error("[LibrarySync] cron error:", error.message);
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
