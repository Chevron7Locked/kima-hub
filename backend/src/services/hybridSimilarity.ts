import { featureDetection } from "./featureDetection";
import { logger } from "../utils/logger";
import { SELF_SCORE } from "./matching/formula";
import { matchingContext, rankMatches, type LibraryTrack } from "./matching/rank";

export interface SimilarTrack extends LibraryTrack {
    /** 1 minus `similarity` before clamping: the matching formula's score scaled so the seed itself scores 1. */
    distance: number;
    similarity: number;
}

/**
 * Similar tracks on the matching formula; empty until the seed has matching data, and on installs without the CLAP
 * analyzer, which the formula needs.
 */
export async function findSimilarTracks(
    trackId: string,
    limit: number = 20
): Promise<SimilarTrack[]> {
    const features = await featureDetection.getFeatures();

    if (features.vibeEmbeddings) {
        return findSimilarByFormula(trackId, limit);
    }

    logger.warn("[SIMILAR] No CLAP analyzer: similar tracks need the matching formula");
    return [];
}

async function findSimilarByFormula(
    trackId: string,
    limit: number
): Promise<SimilarTrack[]> {
    const ctx = await matchingContext([trackId]);
    if (!ctx?.tracks.has(trackId)) return [];
    const rows = await rankMatches(ctx, [{ trackId, weight: 1 }], { limit, counted: [trackId] });
    return rows.map(({ score, ...track }) => {
        const match = score / SELF_SCORE;
        return { ...track, distance: 1 - match, similarity: Math.min(1, Math.max(0, match)) };
    });
}
