/**
 * The podcast refresh job: everything the scheduler's podcast phase and its worker do, behind a few calls.
 *
 *   queueStalePodcasts()     the scheduler's turn each cycle: queues a refresh for every podcast not refreshed in
 *                            the last hour and returns how many it queued
 *   startPodcastWorker()     the queue's worker: one feed per job
 *   processPodcastJob(job)   one podcast's refresh (the worker's work, callable on its own)
 *
 * A podcast's `lastRefreshed` is advanced before its job is queued, so every outcome, an unreachable feed
 * included, waits a full window. The scheduler keeps the order of phases, the locks and the run state; it only
 * calls this module.
 */
import { Worker, Job } from "bullmq";
import { createWorkerConnection, podcastQueue, QUEUE_NAMES } from "../enrichmentQueues";
import { refreshPodcastFeed } from "../../routes/podcasts";
import { enrichmentFailureService } from "../../services/enrichmentFailureService";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";

interface PodcastJobData {
    podcastId: string;
    podcastTitle: string;
}

// ── Queueing: the scheduler's podcast phase ──────────────────────────────

const STALE_AFTER_MS = 60 * 60 * 1000;

export async function queueStalePodcasts(): Promise<number> {
    const podcastCount = await prisma.podcast.count();
    if (podcastCount === 0) return 0;

    const staleThreshold = new Date(Date.now() - STALE_AFTER_MS);
    const stalePodcasts = await prisma.podcast.findMany({
        where: { lastRefreshed: { lt: staleThreshold } },
        select: { id: true, title: true },
    });

    if (stalePodcasts.length === 0) return 0;

    // BullMQ keeps the jobId marker after completed and failed jobs alike; a kept
    // failed job would make every later add() for that podcast a silent no-op. Clean both.
    try {
        await podcastQueue.clean(0, 0, "completed");
        await podcastQueue.clean(0, 0, "failed");
    } catch (err) {
        logger.warn(`[Enrichment] podcastQueue clean failed: ${(err as Error).message}`);
    }

    // Advance lastRefreshed before queuing so every outcome, including an
    // unreachable feed, gets a full backoff window instead of re-queuing each cycle.
    await prisma.podcast.updateMany({
        where: { id: { in: stalePodcasts.map((p) => p.id) } },
        data: { lastRefreshed: new Date() },
    });

    let queued = 0;
    for (const podcast of stalePodcasts) {
        try {
            await podcastQueue.add(
                "refresh",
                { podcastId: podcast.id, podcastTitle: podcast.title },
                { jobId: `podcast-${podcast.id}` }, // dedup: completed jobs are cleaned above
            );
            queued++;
        } catch (err) {
            logger.warn(`[Enrichment] Failed to queue podcast ${podcast.id}: ${(err as Error).message}`);
        }
    }

    if (queued > 0) {
        logger.debug(`[Enrichment] Queued ${queued} podcast refreshes`);
    }
    return queued;
}

// ── The worker ───────────────────────────────────────────────────────────

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

/** A refresh that failed: only the job's final attempt is recorded as the podcast's failure. */
export async function recordPodcastJobFailure(job: Job<PodcastJobData>, err: Error): Promise<void> {
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
}

export function startPodcastWorker(): Worker {
    const worker = new Worker<PodcastJobData>(QUEUE_NAMES.PODCASTS, processPodcastJob, {
        connection: createWorkerConnection(),
        concurrency: 2,
        lockDuration: 60000,
        stalledInterval: 30000,
        maxStalledCount: 2,
    });

    worker.on("failed", async (job, err) => {
        if (!job) return;
        await recordPodcastJobFailure(job, err);
    });

    worker.on("error", (err) => logger.error(`[PodcastWorker] Error: ${err.message}`));
    logger.info("[PodcastWorker] Started");
    return worker;
}
