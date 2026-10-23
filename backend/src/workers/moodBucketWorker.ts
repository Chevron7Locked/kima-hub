/**
 * Keeps MoodBucket and the mood snapshot in step with the learned moods. When the
 * mood statistics' version or inputs fingerprint changes (a rescore, new or
 * re-run sound vectors, a track added, removed or re-analysed), every bucket is
 * rebuilt: moods are judged against the library, so one track shifts all the
 * others. Tracks enter buckets once the mood step has scored them. While there
 * are no current statistics (a rescore or a weights change before the next mood
 * pass finishes) the buckets keep their last contents; deleted tracks still leave.
 */

import { logger } from "../utils/logger";
import { NO_STATISTICS, moodBucketService, refreshMoodSnapshot } from "../services/moodBucketService";

const WORKER_INTERVAL_MS = 30 * 1000; // Run every 30 seconds

let isRunning = false;
let workerInterval: NodeJS.Timeout | null = null;
let lastBuiltSignature: string | null = null;

/**
 * Start the mood bucket worker
 */
export async function startMoodBucketWorker() {
    logger.debug(`[MoodBucket] Starting worker, interval ${WORKER_INTERVAL_MS / 1000}s`);

    // Run immediately
    await syncMoodBuckets();

    // Then run at interval with self-rescheduling setTimeout
    function scheduleNext() {
        workerInterval = setTimeout(async () => {
            await syncMoodBuckets();
            scheduleNext();
        }, WORKER_INTERVAL_MS);
    }
    scheduleNext();
}

/**
 * Stop the mood bucket worker
 */
export function stopMoodBucketWorker() {
    if (workerInterval) {
        clearTimeout(workerInterval);
        workerInterval = null;
        logger.debug("[Mood Bucket] Worker stopped");
    }
}

/**
 * Rebuild the buckets if the library's mood statistics changed since the last
 * rebuild and exist. Returns true when a rebuild ran.
 */
export async function syncMoodBuckets(): Promise<boolean> {
    if (isRunning) return false;

    try {
        isRunning = true;
        const { snapshot } = await refreshMoodSnapshot();
        if (snapshot.signature === NO_STATISTICS || snapshot.signature === lastBuiltSignature) return false;

        const result = await moodBucketService.rebuildBuckets(snapshot);
        lastBuiltSignature = snapshot.signature;
        logger.info(
            `[Mood Bucket] Re-sorted library: ${result.tracks} tracks in ${result.assignments} mood buckets (${snapshot.views.size} analysed, ${snapshot.pending} awaiting analysis)`
        );
        return true;
    } catch (error) {
        logger.error("[Mood Bucket] Worker error:", error);
        return false;
    } finally {
        isRunning = false;
    }
}
