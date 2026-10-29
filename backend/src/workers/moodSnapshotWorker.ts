/**
 * Keeps the mood snapshot (each song's moods, read by the vibe map and the mood presets) in step with the learned
 * moods. When the mood statistics' version or inputs fingerprint changes (a rescore, new or re-run sound vectors, a
 * track added, removed or re-analysed) the snapshot is rebuilt; while there are no current statistics it keeps its
 * last contents. With the public feed on, each pass also brings the public library export up to date, so a change
 * reaches its next request rather than the one after.
 */

import { logger } from "../utils/logger";
import { NO_STATISTICS, refreshMoodSnapshot } from "../services/moodBucketService";
import { refreshLibraryExport } from "../services/publicLibraryExport";
import { config } from "../config";

const WORKER_INTERVAL_MS = 30 * 1000;

let isRunning = false;
let workerTimeout: NodeJS.Timeout | null = null;

export async function startMoodSnapshotWorker() {
    logger.debug(`[MoodSnapshot] Starting worker, interval ${WORKER_INTERVAL_MS / 1000}s`);
    await moodSnapshotPass();

    function scheduleNext() {
        workerTimeout = setTimeout(async () => {
            await moodSnapshotPass();
            scheduleNext();
        }, WORKER_INTERVAL_MS);
    }
    scheduleNext();
}

export function stopMoodSnapshotWorker() {
    if (workerTimeout) {
        clearTimeout(workerTimeout);
        workerTimeout = null;
        logger.debug("[MoodSnapshot] Worker stopped");
    }
}

/** After a failed export build, how long the worker waits before building it again. */
const EXPORT_RETRY_MS = 10 * 60 * 1000;
let exportFailedAt: number | null = null;

/** One pass: the mood snapshot, then (with the public feed on) the public export, which rebuilds only on a change. */
export async function moodSnapshotPass(): Promise<void> {
    await syncMoodSnapshot();
    if (!config.publicVibe) return;
    if (exportFailedAt !== null && Date.now() - exportFailedAt < EXPORT_RETRY_MS) return;
    try {
        await refreshLibraryExport();
        exportFailedAt = null;
    } catch (error) {
        exportFailedAt = Date.now();
        logger.error("[PUBLIC-VIBE] library export failed; trying again in 10 minutes:", error);
    }
}

/** Rebuild the snapshot if the library's mood statistics changed and exist. Returns true when a rebuild ran. */
export async function syncMoodSnapshot(): Promise<boolean> {
    if (isRunning) return false;

    try {
        isRunning = true;
        const { snapshot, changed } = await refreshMoodSnapshot();
        if (!changed || snapshot.signature === NO_STATISTICS) return false;
        const withMoods = [...snapshot.views.values()].filter((v) => v.moods.length > 0).length;
        logger.info(
            `[MoodSnapshot] Re-sorted library: ${withMoods} of ${snapshot.views.size} analysed tracks have a mood (${snapshot.pending} awaiting analysis)`
        );
        return true;
    } catch (error) {
        logger.error("[MoodSnapshot] Worker error:", error);
        return false;
    } finally {
        isRunning = false;
    }
}
