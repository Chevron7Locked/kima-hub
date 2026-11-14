import { Worker, Job } from "bullmq";
import { createWorkerConnection, QUEUE_NAMES } from "./enrichmentQueues";
import { isEntityGone } from "./entityGone";
import { identifyTrack } from "./enrichment/identification";
import * as stageRecords from "../services/stages/stageRecords";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";

interface TrackJobData {
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
            if (!(await stageRecords.claimIsCurrent(trackId, "recording", job.id))) {
                logger.debug(`[TrackWorker] ${trackId}: claim ${job.id} was re-issued; skipped`);
                return;
            }
            logger.debug(`[TrackWorker] Processing ${trackId} (${trackTitle})`);
            // identifyTrack settles the stage record itself (done, absent, failed
            // with its cause, or left pending for a paused source); don't settle it again.
            const outcome = await identifyTrack(trackId, job.id);
            logger.debug(`[TrackWorker] ${trackId}: recording question settled (${outcome})`);
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
        const { trackId } = job.data;

        if (isEntityGone(err)) {
            logger.info(`[TrackWorker] Track ${trackId} no longer exists, resolving silently`);
            return;
        }

        logger.error(`[TrackWorker] Track ${trackId} failed: ${err.message}`);

        // The stage record owns the attempt: its retry ladder decides when to stop
        // asking, and it is the only record of this failure the failures API reads.
        await stageRecords.fail(trackId, "recording", "musicbrainz", err, { queueJobId: job.id }, job.id).catch(
            (reportErr: Error) =>
                logger.warn(`[TrackWorker] Could not record track ${trackId}'s failure: ${reportErr.message}`),
        );
    });

    worker.on("error", (err) => logger.error(`[TrackWorker] Error: ${err.message}`));
    logger.info(`[TrackWorker] Started (concurrency: ${concurrency})`);
    return worker;
}
