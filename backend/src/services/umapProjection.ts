import { UMAP } from "umap-js";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { parseEmbedding } from "../utils/embedding";

const MIN_TRACKS_FOR_UMAP = 5;

interface MapTrack {
    id: string;
    x: number;
    y: number;
    title: string;
    artist: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    dominantMood: string;
    moodScore: number;
    energy: number | null;
    valence: number | null;
}

interface MapResponse {
    tracks: MapTrack[];
    trackCount: number;
    computedAt: string;
}

const MOOD_FIELDS = [
    "moodHappy", "moodSad", "moodRelaxed", "moodAggressive",
    "moodParty", "moodAcoustic", "moodElectronic",
] as const;

function getDominantMood(track: Record<string, number | null>): { mood: string; score: number } {
    let best = { mood: "neutral", score: 0 };
    for (const field of MOOD_FIELDS) {
        const val = track[field];
        if (val !== null && val !== undefined && val > best.score) {
            best = { mood: field, score: val };
        }
    }
    return best;
}

export async function computeMapProjection(): Promise<MapResponse> {
    const embeddedCount = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count FROM track_embeddings
    `;
    const count = Number(embeddedCount[0]?.count || 0);

    if (count === 0) {
        return { tracks: [], trackCount: 0, computedAt: new Date().toISOString() };
    }

    const cacheKey = `vibe:map:v1:${count}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) {
        logger.debug(`[VIBE-MAP] Cache hit for ${count} tracks`);
        return JSON.parse(cached);
    }

    logger.info(`[VIBE-MAP] Computing UMAP projection for ${count} tracks...`);
    const startTime = Date.now();

    const rows = await prisma.$queryRaw<Array<{
        track_id: string;
        title: string;
        artistName: string;
        artistId: string;
        albumId: string;
        coverUrl: string | null;
        energy: number | null;
        valence: number | null;
        moodHappy: number | null;
        moodSad: number | null;
        moodRelaxed: number | null;
        moodAggressive: number | null;
        moodParty: number | null;
        moodAcoustic: number | null;
        moodElectronic: number | null;
        embedding: string;
    }>>`
        SELECT
            te.track_id,
            t.title,
            ar.name as "artistName",
            ar.id as "artistId",
            a.id as "albumId",
            a."coverUrl",
            t.energy,
            t.valence,
            t."moodHappy",
            t."moodSad",
            t."moodRelaxed",
            t."moodAggressive",
            t."moodParty",
            t."moodAcoustic",
            t."moodElectronic",
            te.embedding::text as embedding
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
    `;

    if (rows.length < MIN_TRACKS_FOR_UMAP) {
        // Too few tracks for meaningful UMAP -- place in a simple grid
        const result: MapResponse = {
            tracks: rows.map((r, i) => {
                const dominant = getDominantMood(r as any);
                const angle = (2 * Math.PI * i) / rows.length;
                return {
                    id: r.track_id,
                    x: 0.5 + 0.3 * Math.cos(angle),
                    y: 0.5 + 0.3 * Math.sin(angle),
                    title: r.title,
                    artist: r.artistName, artistId: r.artistId, albumId: r.albumId,
                    coverUrl: r.coverUrl, dominantMood: dominant.mood,
                    moodScore: dominant.score, energy: r.energy, valence: r.valence,
                };
            }),
            trackCount: rows.length,
            computedAt: new Date().toISOString(),
        };
        return result;
    }

    const embeddings: number[][] = rows.map(r => parseEmbedding(r.embedding));

    // Run UMAP: 512-dim -> 2-dim
    const umap = new UMAP({
        nComponents: 2,
        nNeighbors: Math.min(15, Math.max(2, Math.floor(rows.length / 2))),
        minDist: 0.1,
        spread: 1.0,
    });

    const projection = umap.fit(embeddings);

    // Normalize to 0-1 range
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of projection) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;

    const tracks: MapTrack[] = rows.map((row, i) => {
        const dominant = getDominantMood(row as any);
        return {
            id: row.track_id,
            x: (projection[i][0] - minX) / rangeX,
            y: (projection[i][1] - minY) / rangeY,
            title: row.title,
            artist: row.artistName,
            artistId: row.artistId,
            albumId: row.albumId,
            coverUrl: row.coverUrl,
            dominantMood: dominant.mood,
            moodScore: dominant.score,
            energy: row.energy,
            valence: row.valence,
        };
    });

    const result: MapResponse = {
        tracks,
        trackCount: tracks.length,
        computedAt: new Date().toISOString(),
    };

    // Cache for 24 hours
    await redisClient.setEx(cacheKey, 86400, JSON.stringify(result));

    const elapsed = Date.now() - startTime;
    logger.info(`[VIBE-MAP] UMAP projection computed in ${elapsed}ms for ${tracks.length} tracks`);

    return result;
}
