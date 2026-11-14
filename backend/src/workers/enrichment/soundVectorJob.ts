/**
 * The `embedding` job: the CLAP sound vector of a song, made by the CLAP worker from a BullMQ job on the vibe queue.
 *
 * Offered only for songs whose own analysis is `done` (the scheduler's offer enforces it), so one unanalysable file
 * cannot hold back anyone else's. The scheduler keeps the order, the claim and the one-at-a-time rule against audio
 * analysis; this module owns whether the job runs at all, what a vector question looks like on the queue and how deep
 * a window it is offered in.
 */

import { vibeQueue } from "../enrichmentQueues";
import { featureDetection } from "../../services/featureDetection";
import type { StageWork } from "../unifiedEnrichment";
import type { StageOffer } from "./stageOffer";

/** Queue one vector question. `jobId` is per attempt, so a retry never reuses the key a failed job still holds. */
export async function queueSoundVector(item: StageWork): Promise<void> {
    await vibeQueue.add(
        "embed",
        { trackId: item.trackId, filePath: item.filePath, duration: item.duration },
        { jobId: item.jobId },
    );
}

/** Offer the songs whose vector is owed and queue them; nothing when this install has no vector embeddings. */
export async function runSoundVectors(offer: StageOffer): Promise<number> {
    const features = await featureDetection.getFeatures();
    if (!features.vibeEmbeddings) return 0;
    const work = await offer.nextWork(await offer.window());
    return offer.dispatch(work, queueSoundVector);
}
