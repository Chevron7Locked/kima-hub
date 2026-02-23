import { Worker, Job } from "bullmq";
import { createWorkerConnection, QUEUE_NAMES } from "./enrichmentQueues";
import { enrichSingleTrack } from "./unifiedEnrichment";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";

export interface TrackJobData {
    trackId: string;
    trackTitle: string;
}

export async function startTrackEnrichmentWorker(): Promise<Worker> {
    const settings = await getSystemSettings();
    const concurrency = settings?.enrichmentConcurrency ?? 5;

    const worker = new Worker<TrackJobData>(
        QUEUE_NAMES.TRACKS,
        async (job: Job<TrackJobData>) => {
            const { trackId, trackTitle } = job.data;
            logger.debug(`[TrackWorker] Processing ${trackId} (${trackTitle})`);
            await enrichSingleTrack(trackId);
        },
        {
            connection: createWorkerConnection(),
            concurrency,
            lockDuration: 60000,
            stalledInterval: 30000,
            maxStalledCount: 2,
        },
    );

    worker.on("failed", async (job, err) => {
        if (!job) return;
        const { trackId, trackTitle } = job.data;

        if ((err as any).entityNotFound) {
            logger.info(`[TrackWorker] Track ${trackId} no longer exists, resolving silently`);
            return;
        }

        logger.error(`[TrackWorker] Track ${trackId} failed (attempt ${job.attemptsMade}): ${err.message}`);

        const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 3);
        if (isFinalAttempt) {
            // Clear the "_queued" sentinel so the orchestrator can re-pick this
            // track up on the next library re-enrich rather than leaving it stuck
            await prisma.track
                .update({ where: { id: trackId }, data: { lastfmTags: [] } })
                .catch(() => {});
            await enrichmentFailureService
                .recordFailure({
                    entityType: "track",
                    entityId: trackId,
                    entityName: trackTitle,
                    errorMessage: err.message,
                })
                .catch(() => {});
        }
    });

    worker.on("error", (err) => logger.error(`[TrackWorker] Error: ${err.message}`));
    logger.info(`[TrackWorker] Started (concurrency: ${concurrency})`);
    return worker;
}
