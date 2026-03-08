import { prisma } from "../utils/db";
import { featureDetection } from "./featureDetection";
import { logger } from "../utils/logger";

export interface SimilarTrack {
    id: string;
    title: string;
    distance: number;
    similarity: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
}

const WEIGHTS = {
    clap: 0.55,
    features: {
        energy: 0.10,
        valence: 0.09,
        arousal: 0.08,
        bpm: 0.07,
        danceability: 0.05,
        acousticness: 0.03,
        instrumentalness: 0.02,
        key: 0.01,
    },
};

// Normalized weights for features-only mode (sum to 1.0)
const FEATURES_ONLY_WEIGHTS = {
    energy: 0.222,
    valence: 0.200,
    arousal: 0.178,
    bpm: 0.156,
    danceability: 0.111,
    acousticness: 0.067,
    instrumentalness: 0.044,
    key: 0.022,
};

export async function findSimilarTracks(
    trackId: string,
    limit: number = 20
): Promise<SimilarTrack[]> {
    const features = await featureDetection.getFeatures();

    if (features.vibeEmbeddings && features.musicCNN) {
        logger.debug(`[HYBRID-SIMILARITY] Using hybrid mode for track ${trackId}`);
        return findSimilarHybrid(trackId, limit);
    }

    if (features.vibeEmbeddings && !features.musicCNN) {
        logger.debug(`[HYBRID-SIMILARITY] Using CLAP-only mode for track ${trackId}`);
        return findSimilarClapOnly(trackId, limit);
    }

    if (features.musicCNN && !features.vibeEmbeddings) {
        logger.debug(`[HYBRID-SIMILARITY] Using features-only mode for track ${trackId}`);
        return findSimilarFeaturesOnly(trackId, limit);
    }

    logger.warn("[HYBRID-SIMILARITY] No similarity features available");
    return [];
}

async function findSimilarHybrid(
    trackId: string,
    limit: number
): Promise<SimilarTrack[]> {
    // Fetch 5x candidates from CLAP to ensure good coverage after re-ranking
    const candidateMultiplier = 5;

    const results = await prisma.$queryRaw<SimilarTrack[]>`
        WITH source AS (
            SELECT
                te.embedding,
                t.energy, t.valence, t.arousal, t.bpm, t."danceabilityMl",
                t.acousticness, t.instrumentalness, t.key, t."keyScale"
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            WHERE te.track_id = ${trackId}
        ),
        clap_candidates AS (
            SELECT
                te.track_id,
                GREATEST(0, 1 - (te.embedding <=> (SELECT embedding FROM source))) as clap_sim
            FROM track_embeddings te
            WHERE te.track_id != ${trackId}
            ORDER BY te.embedding <=> (SELECT embedding FROM source)
            LIMIT ${limit * candidateMultiplier}
        )
        SELECT
            t.id,
            t.title,
            c.clap_sim as distance,
            (
                ${WEIGHTS.clap} * c.clap_sim +
                ${WEIGHTS.features.energy} * (1 - ABS(COALESCE(t.energy, 0.5) - COALESCE(s.energy, 0.5))) +
                ${WEIGHTS.features.valence} * (1 - ABS(COALESCE(t.valence, 0.5) - COALESCE(s.valence, 0.5))) +
                ${WEIGHTS.features.arousal} * (1 - ABS(COALESCE(t.arousal, 0.5) - COALESCE(s.arousal, 0.5))) +
                ${WEIGHTS.features.bpm} * bpm_similarity(t.bpm, s.bpm) +
                ${WEIGHTS.features.danceability} * (1 - ABS(COALESCE(t."danceabilityMl", 0.5) - COALESCE(s."danceabilityMl", 0.5))) +
                ${WEIGHTS.features.acousticness} * (1 - ABS(COALESCE(t.acousticness, 0.5) - COALESCE(s.acousticness, 0.5))) +
                ${WEIGHTS.features.instrumentalness} * (1 - ABS(COALESCE(t.instrumentalness, 0.5) - COALESCE(s.instrumentalness, 0.5))) +
                ${WEIGHTS.features.key} * key_similarity(t.key, t."keyScale", s.key, s."keyScale")
            ) as similarity,
            a.id as "albumId",
            a.title as "albumTitle",
            a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId",
            ar.name as "artistName"
        FROM clap_candidates c
        JOIN "Track" t ON c.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        CROSS JOIN source s
        ORDER BY similarity DESC
        LIMIT ${limit}
    `;

    return results;
}

async function findSimilarClapOnly(
    trackId: string,
    limit: number
): Promise<SimilarTrack[]> {
    const results = await prisma.$queryRaw<SimilarTrack[]>`
        WITH source AS (
            SELECT embedding FROM track_embeddings WHERE track_id = ${trackId}
        )
        SELECT
            t.id,
            t.title,
            te.embedding <=> (SELECT embedding FROM source) as distance,
            GREATEST(0, 1 - (te.embedding <=> (SELECT embedding FROM source))) as similarity,
            a.id as "albumId",
            a.title as "albumTitle",
            a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId",
            ar.name as "artistName"
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE te.track_id != ${trackId}
        ORDER BY distance
        LIMIT ${limit}
    `;

    return results;
}

async function findSimilarFeaturesOnly(
    trackId: string,
    limit: number
): Promise<SimilarTrack[]> {
    const results = await prisma.$queryRaw<SimilarTrack[]>`
        WITH source AS (
            SELECT energy, valence, arousal, bpm, "danceabilityMl", acousticness, instrumentalness, key, "keyScale"
            FROM "Track"
            WHERE id = ${trackId}
        )
        SELECT
            t.id,
            t.title,
            0 as distance,
            (
                ${FEATURES_ONLY_WEIGHTS.energy} * (1 - ABS(COALESCE(t.energy, 0.5) - COALESCE(s.energy, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.valence} * (1 - ABS(COALESCE(t.valence, 0.5) - COALESCE(s.valence, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.arousal} * (1 - ABS(COALESCE(t.arousal, 0.5) - COALESCE(s.arousal, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.bpm} * bpm_similarity(t.bpm, s.bpm) +
                ${FEATURES_ONLY_WEIGHTS.danceability} * (1 - ABS(COALESCE(t."danceabilityMl", 0.5) - COALESCE(s."danceabilityMl", 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.acousticness} * (1 - ABS(COALESCE(t.acousticness, 0.5) - COALESCE(s.acousticness, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.instrumentalness} * (1 - ABS(COALESCE(t.instrumentalness, 0.5) - COALESCE(s.instrumentalness, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.key} * key_similarity(t.key, t."keyScale", s.key, s."keyScale")
            ) as similarity,
            a.id as "albumId",
            a.title as "albumTitle",
            a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId",
            ar.name as "artistName"
        FROM "Track" t
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        CROSS JOIN source s
        WHERE t.id != ${trackId}
        ORDER BY similarity DESC
        LIMIT ${limit}
    `;

    return results;
}
