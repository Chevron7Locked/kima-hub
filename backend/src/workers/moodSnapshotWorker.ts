/**
 * Keeps the mood snapshot (each song's moods, read by the vibe map and the mood presets) in step with the learned
 * moods. When the mood statistics' version or inputs fingerprint changes (a rescore, new or re-run sound vectors, a
 * track added, removed or re-analysed) the snapshot is rebuilt; while there are no current statistics it keeps its
 * last contents.
 */

import { logger } from "../utils/logger";
import { NO_STATISTICS, refreshMoodSnapshot } from "../services/moodBucketService";

const WORKER_INTERVAL_MS = 30 * 1000;

let isRunning = false;
let workerTimeout: NodeJS.Timeout | null = null;

export async function startMoodSnapshotWorker() {
    logger.debug(`[MoodSnapshot] Starting worker, interval ${WORKER_INTERVAL_MS / 1000}s`);
    await syncMoodSnapshot();

    function scheduleNext() {
        workerTimeout = setTimeout(async () => {
            await syncMoodSnapshot();
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
