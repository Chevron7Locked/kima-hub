/**
 * Mood Bucket Worker
 *
 * This worker runs in the background and assigns newly analyzed tracks
 * to mood buckets. It watches for tracks that have:
 * - analysisStatus = 'completed'
 * - No existing MoodBucket entries
 *
 * This is separate from the Python audio analyzer to keep mood bucket
 * logic in TypeScript and avoid modifying the Python code.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { moodBucketService } from "../services/moodBucketService";

// Configuration
const BATCH_SIZE = 50;
const WORKER_INTERVAL_MS = 30 * 1000; // Run every 30 seconds

let isRunning = false;
let workerInterval: NodeJS.Timeout | null = null;

/**
 * Start the mood bucket worker
 */
export async function startMoodBucketWorker() {
    logger.debug("\n=== Starting Mood Bucket Worker ===");
    logger.debug(`   Batch size: ${BATCH_SIZE}`);
    logger.debug(`   Interval: ${WORKER_INTERVAL_MS / 1000}s`);
    logger.debug("");

    // Run immediately
    await processNewlyAnalyzedTracks();

    // Then run at interval
    workerInterval = setInterval(async () => {
        await processNewlyAnalyzedTracks();
    }, WORKER_INTERVAL_MS);
}

/**
 * Stop the mood bucket worker
 */
export function stopMoodBucketWorker() {
    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
        logger.debug("[Mood Bucket] Worker stopped");
    }
}

/**
 * Process newly analyzed tracks that don't have mood bucket assignments
 */
async function processNewlyAnalyzedTracks(): Promise<number> {
    if (isRunning) return 0;

    try {
        isRunning = true;

        // Find tracks that are analyzed but not in any mood bucket
        // We use a subquery to find tracks without mood bucket entries
        const tracksWithoutBuckets = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                moodBuckets: {
                    none: {},
                },
            },
            select: {
                id: true,
                title: true,
            },
            take: BATCH_SIZE,
            orderBy: {
                analyzedAt: "desc",
            },
        });

        if (tracksWithoutBuckets.length === 0) {
            return 0;
        }

        logger.debug(
            `[Mood Bucket] Processing ${tracksWithoutBuckets.length} newly analyzed tracks...`
        );

        let assigned = 0;
        for (const track of tracksWithoutBuckets) {
            try {
                const moods = await moodBucketService.assignTrackToMoods(
                    track.id
                );
                if (moods.length > 0) {
                    assigned++;
                    logger.debug(` ${track.title}: [${moods.join(", ")}]`);
                }
            } catch (error: any) {
                logger.error(
                    `   ✗ ${track.title}: ${error?.message || error}`
                );
            }
        }

        logger.debug(
            `[Mood Bucket] Assigned ${assigned}/${tracksWithoutBuckets.length} tracks to mood buckets`
        );

        return assigned;
    } catch (error) {
        logger.error("[Mood Bucket] Worker error:", error);
        return 0;
    } finally {
        isRunning = false;
    }
}

/**
 * Get mood bucket assignment progress
 */
export async function getMoodBucketProgress() {
    const totalAnalyzed = await prisma.track.count({
        where: { analysisStatus: "completed" },
    });

    const withBuckets = await prisma.track.count({
        where: {
            analysisStatus: "completed",
            moodBuckets: {
                some: {},
            },
        },
    });

    // Get counts per mood
    const moodCounts = await prisma.moodBucket.groupBy({
        by: ["mood"],
        _count: true,
    });

    const moodDistribution: Record<string, number> = {};
    for (const mc of moodCounts) {
        moodDistribution[mc.mood] = mc._count;
    }

    return {
        totalAnalyzed,
        withBuckets,
        pending: totalAnalyzed - withBuckets,
        progress:
            totalAnalyzed > 0
                ? Math.round((withBuckets / totalAnalyzed) * 100)
                : 0,
        moodDistribution,
    };
}

/**
 * Manually trigger mood bucket assignment for all analyzed tracks
 * (Used for initial backfill or re-processing)
 */
export async function backfillMoodBuckets(): Promise<{
    processed: number;
    assigned: number;
}> {
    logger.debug("[Mood Bucket] Starting full backfill...");
    return moodBucketService.backfillAllTracks();
}
