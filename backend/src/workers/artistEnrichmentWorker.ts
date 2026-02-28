import { Worker, Job } from "bullmq";
import { createWorkerConnection, QUEUE_NAMES } from "./enrichmentQueues";
import { enrichSimilarArtist } from "./artistEnrichment";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";

export interface ArtistJobData {
    artistId: string;
    artistName: string;
}

export async function startArtistEnrichmentWorker(): Promise<Worker> {
    const settings = await getSystemSettings();
    const concurrency = settings?.enrichmentConcurrency ?? 3;

    const worker = new Worker<ArtistJobData>(
        QUEUE_NAMES.ARTISTS,
        async (job: Job<ArtistJobData>) => {
            const { artistId, artistName } = job.data;
            logger.debug(`[ArtistWorker] Processing ${artistId} (${artistName})`);

            const artist = await prisma.artist.findUnique({ where: { id: artistId } });
            if (!artist) {
                const err = new Error(`ENTITY_NOT_FOUND: Artist ${artistId} deleted`);
                (err as any).entityNotFound = true;
                throw err;
            }

            // enrichSimilarArtist handles its own final status update
            // (sets "completed", "unresolvable", or "failed" internally)
            await enrichSimilarArtist(artist);
        },
        {
            connection: createWorkerConnection(),
            concurrency,
            lockDuration: 120000,
            stalledInterval: 30000,
            maxStalledCount: 2,
        },
    );

    worker.on("failed", async (job, err) => {
        if (!job) return;
        const { artistId } = job.data;
        const isEntityGone = (err as any).entityNotFound === true;

        if (isEntityGone) {
            logger.info(`[ArtistWorker] Artist ${artistId} no longer exists, resolving silently`);
            return;
        }

        logger.error(`[ArtistWorker] Artist ${artistId} failed (attempt ${job.attemptsMade}): ${err.message}`);

        const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 3);
        if (isFinalAttempt) {
            await prisma.artist
                .update({
                    where: { id: artistId },
                    data: { enrichmentStatus: "failed" },
                })
                .catch(() => {});

            await enrichmentFailureService.recordFailure({
                entityType: "artist",
                entityId: artistId,
                entityName: job.data.artistName,
                errorMessage: err.message,
            });
        }
    });

    worker.on("error", (err) => logger.error(`[ArtistWorker] Error: ${err.message}`));
    logger.info(`[ArtistWorker] Started (concurrency: ${concurrency})`);
    return worker;
}
