import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { featureDetection } from "./featureDetection";
import { logger } from "../utils/logger";
import { SELF_SCORE } from "./matching/formula";
import { capRanked, matchingContext, rankMatches, type LibraryTrack } from "./matching/rank";

export interface SimilarTrack extends LibraryTrack {
    /**
     * 1 minus `similarity` before clamping: the matching formula's score scaled so the
     * seed itself scores 1, or on installs without CLAP the feature similarity.
     */
    distance: number;
    similarity: number;
}

/** Feature weights for installs without CLAP (they sum to 1). */
export const FEATURES_ONLY_WEIGHTS = {
    energy: 0.222,
    valence: 0.200,
    arousal: 0.178,
    bpm: 0.156,
    danceability: 0.111,
    acousticness: 0.067,
    instrumentalness: 0.044,
    key: 0.022,
};

/**
 * Similar tracks on the matching formula
 * when the CLAP analyzer is installed; empty until the seed has matching data.
 * Installs without CLAP rank on audio features.
 */
export async function findSimilarTracks(
    trackId: string,
    limit: number = 20
): Promise<SimilarTrack[]> {
    const features = await featureDetection.getFeatures();

    if (features.vibeEmbeddings) {
        return findSimilarByFormula(trackId, limit);
    }

    if (features.musicCNN) {
        return findSimilarFeaturesOnly(trackId, limit);
    }

    logger.warn("[HYBRID-SIMILARITY] No similarity features available");
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

/**
 * The weighted mean of feature closeness over the features both tracks have; a
 * track pair with none scores the neutral 0.5. No BPM prefilter, because
 * bpm_similarity folds half and double time together.
 */
async function findSimilarFeaturesOnly(
    trackId: string,
    limit: number
): Promise<SimilarTrack[]> {
    const seed = await prisma.track.findUnique({
        where: { id: trackId },
        select: { albumId: true, album: { select: { artistId: true } } },
    });
    if (!seed) return [];

    const w = FEATURES_ONLY_WEIGHTS;
    const scored = Prisma.sql`
        WITH source AS (
            SELECT energy, valence, arousal, bpm, "danceabilityMl", acousticness, instrumentalness, key, "keyScale"
            FROM "Track"
            WHERE id = ${trackId}
        ),
        combined AS (
            SELECT
                t.id, t.title, t.duration,
                a.id AS "albumId", a.title AS "albumTitle", a."coverUrl" AS "albumCoverUrl",
                ar.id AS "artistId", ar.name AS "artistName",
                (
                    ${w.energy} * (CASE WHEN t.energy IS NULL OR s.energy IS NULL THEN 0 ELSE 1 - ABS(t.energy - s.energy) END)
                    + ${w.valence} * (CASE WHEN t.valence IS NULL OR s.valence IS NULL THEN 0 ELSE 1 - ABS(t.valence - s.valence) END)
                    + ${w.arousal} * (CASE WHEN t.arousal IS NULL OR s.arousal IS NULL THEN 0 ELSE 1 - ABS(t.arousal - s.arousal) END)
                    + ${w.bpm} * (CASE WHEN t.bpm IS NULL OR s.bpm IS NULL THEN 0 ELSE bpm_similarity(t.bpm, s.bpm) END)
                    + ${w.danceability} * (CASE WHEN t."danceabilityMl" IS NULL OR s."danceabilityMl" IS NULL THEN 0 ELSE 1 - ABS(t."danceabilityMl" - s."danceabilityMl") END)
                    + ${w.acousticness} * (CASE WHEN t.acousticness IS NULL OR s.acousticness IS NULL THEN 0 ELSE 1 - ABS(t.acousticness - s.acousticness) END)
                    + ${w.instrumentalness} * (CASE WHEN t.instrumentalness IS NULL OR s.instrumentalness IS NULL THEN 0 ELSE 1 - ABS(t.instrumentalness - s.instrumentalness) END)
                    + ${w.key} * (CASE WHEN t.key IS NULL OR s.key IS NULL THEN 0 ELSE key_similarity(t.key, t."keyScale", s.key, s."keyScale") END)
                ) AS num,
                (
                    ${w.energy} * (CASE WHEN t.energy IS NULL OR s.energy IS NULL THEN 0 ELSE 1 END)
                    + ${w.valence} * (CASE WHEN t.valence IS NULL OR s.valence IS NULL THEN 0 ELSE 1 END)
                    + ${w.arousal} * (CASE WHEN t.arousal IS NULL OR s.arousal IS NULL THEN 0 ELSE 1 END)
                    + ${w.bpm} * (CASE WHEN t.bpm IS NULL OR s.bpm IS NULL THEN 0 ELSE 1 END)
                    + ${w.danceability} * (CASE WHEN t."danceabilityMl" IS NULL OR s."danceabilityMl" IS NULL THEN 0 ELSE 1 END)
                    + ${w.acousticness} * (CASE WHEN t.acousticness IS NULL OR s.acousticness IS NULL THEN 0 ELSE 1 END)
                    + ${w.instrumentalness} * (CASE WHEN t.instrumentalness IS NULL OR s.instrumentalness IS NULL THEN 0 ELSE 1 END)
                    + ${w.key} * (CASE WHEN t.key IS NULL OR s.key IS NULL THEN 0 ELSE 1 END)
                ) AS den
            FROM "Track" t
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            CROSS JOIN source s
            WHERE t.id <> ${trackId} AND t."missingSince" IS NULL
        )
        SELECT id, title, duration, "albumId", "albumTitle", "albumCoverUrl", "artistId", "artistName",
               CASE WHEN den = 0 THEN 0.5 ELSE num / den END AS score
        FROM combined
    `;
    const rows = await capRanked(scored, [{ albumId: seed.albumId, artistId: seed.album.artistId }], limit);
    return rows.map(({ score, ...track }) => ({ ...track, similarity: score, distance: 1 - score }));
}
