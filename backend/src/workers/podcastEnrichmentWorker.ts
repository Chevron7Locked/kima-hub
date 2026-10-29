import { Worker, Job } from "bullmq";
import { createWorkerConnection, QUEUE_NAMES } from "./enrichmentQueues";
import { refreshPodcastFeed } from "../routes/podcasts";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { logger } from "../utils/logger";

interface PodcastJobData {
    podcastId: string;
    podcastTitle: string;
}

/** A job's data; a job hash stripped by Redis arrives without any. */
const jobData = (job: Job<PodcastJobData>): Partial<PodcastJobData> => job.data ?? {};

/** Refreshes one podcast's feed. A podcast unsubscribed since its job was queued is skipped. */
export async function processPodcastJob(job: Job<PodcastJobData>): Promise<void> {
    const { podcastId, podcastTitle } = jobData(job);
    // A job hash stripped by Redis arrives without data.
    if (!podcastId) {
        throw new Error("[PodcastWorker] Job has no podcastId -- corrupt job data");
    }
    logger.debug(`[PodcastWorker] Processing ${podcastId} (${podcastTitle})`);
    if (!(await refreshPodcastFeed(podcastId))) {
        logger.debug(`[PodcastWorker] ${podcastId} (${podcastTitle}) is no longer subscribed; skipping`);
    }
}

export function startPodcastEnrichmentWorker(): Worker {
    const worker = new Worker<PodcastJobData>(
        QUEUE_NAMES.PODCASTS,
        processPodcastJob,
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
        const { podcastId, podcastTitle } = jobData(job);
        logger.error(`[PodcastWorker] Podcast ${podcastId ?? "<unknown>"} failed (attempt ${job.attemptsMade}): ${err.message}`);
        // A corrupt/data-less job has nothing to record against -- the cleaned
        // jobId lets the next cycle re-queue it with real data.
        if (!podcastId) return;

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
