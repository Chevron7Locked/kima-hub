import { Worker, Job } from "bullmq";
import { createWorkerConnection, QUEUE_NAMES } from "./enrichmentQueues";
import { refreshPodcastFeed } from "../routes/podcasts";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { logger } from "../utils/logger";

export interface PodcastJobData {
    podcastId: string;
    podcastTitle: string;
}

export function startPodcastEnrichmentWorker(): Worker {
    const worker = new Worker<PodcastJobData>(
        QUEUE_NAMES.PODCASTS,
        async (job: Job<PodcastJobData>) => {
            const { podcastId, podcastTitle } = job.data;
            logger.debug(`[PodcastWorker] Processing ${podcastId} (${podcastTitle})`);
            await refreshPodcastFeed(podcastId);
        },
        {
            connection: createWorkerConnection(),
            concurrency: 2,
            lockDuration: 60000,
            stalledInterval: 30000,
            maxStalledCount: 2,
        },
    );

    worker.on("failed", async (job, err) => {
        if (!job) return;
        const { podcastId, podcastTitle } = job.data;
        logger.error(`[PodcastWorker] Podcast ${podcastId} failed (attempt ${job.attemptsMade}): ${err.message}`);

        const isEntityGone = (err as any).entityNotFound === true;
        if (isEntityGone) {
            logger.info(`[PodcastWorker] Podcast ${podcastId} no longer exists, skipping failure record`);
            return;
        }

        const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 3);
        if (isFinalAttempt) {
            await enrichmentFailureService
                .recordFailure({
                    entityType: "podcast",
                    entityId: podcastId,
                    entityName: podcastTitle,
                    errorMessage: err.message,
                })
                .catch(() => {});
        }
    });

    worker.on("error", (err) => logger.error(`[PodcastWorker] Error: ${err.message}`));
    logger.info("[PodcastWorker] Started");
    return worker;
}
