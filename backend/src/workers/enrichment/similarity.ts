/**
 * The similarity step of the enrichment cycle, after the moods: feel for new sound vectors and the library's
 * matching state when its inputs changed (services/matching/state.ts), then the vibe map, laid out or extended
 * with new tracks (services/matching/map.ts). The scheduler decides when the step runs; what it does once it
 * runs is here, and it is tried without the scheduler.
 */

import { logger } from "../../utils/logger";
import { featureDetection } from "../../services/featureDetection";
import { buildMatching } from "../../services/matching/state";
import { updateMap } from "../../services/matching/map";
import { soundInputsSettled, type SoundInputs } from "./moods";

/** The counts the step is judged by: the moods' inputs, plus the artists still owing their genres. */
export interface SimilarityInputs extends SoundInputs {
    artists: { owed: number };
}

/**
 * Waits for the same settled analysis and sound vectors as the moods, then builds feel and the map. The map's
 * one-time layout also waits for the artist genres the formula reads. Returns how many tracks got feel or a
 * map position.
 */
export async function runSimilarityStep(readProgress: () => Promise<SimilarityInputs>): Promise<number> {
    const features = await featureDetection.getFeatures();
    if (!features.vibeEmbeddings) {
        return 0;
    }
    const progress = await readProgress();
    if (!soundInputsSettled(progress)) {
        logger.debug("[Enrichment] Similarity waits: analysis or sound vectors are still being made");
        return 0;
    }
    const { feelUpdated } = await buildMatching();
    const { laidOut, placed } = await updateMap(progress.artists.owed === 0);
    if (laidOut > 0) logger.info(`[Enrichment] Vibe map laid out: ${laidOut} tracks`);
    return feelUpdated + laidOut + placed;
}
