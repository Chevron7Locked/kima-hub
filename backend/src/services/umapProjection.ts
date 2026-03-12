import path from "path";
import { Worker } from "worker_threads";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { parseEmbedding } from "../utils/embedding";

const MIN_TRACKS_FOR_UMAP = 5;
const MAX_EMBEDDINGS = 15000;
const CACHE_KEY = "vibe:map:v3:projection";
const TRACK_IDS_KEY = "vibe:map:v3:track_ids";
const CACHE_TTL = 86400;
const KNN_NEIGHBORS = 5;

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
    moods: Record<string, number>;
    energy: number | null;
    valence: number | null;
}

interface MapResponse {
    tracks: MapTrack[];
    trackCount: number;
    sampled?: boolean;
    computedAt: string;
}

const MOOD_FIELDS = [
    "moodHappy", "moodSad", "moodRelaxed", "moodAggressive",
    "moodParty", "moodAcoustic", "moodElectronic",
] as const;

function getDominantMood(track: Record<string, unknown>): { mood: string; score: number } {
    let best = { mood: "neutral", score: 0 };
    for (const field of MOOD_FIELDS) {
        const val = track[field] as number | null | undefined;
        if (val != null && val > best.score) {
            best = { mood: field, score: val };
        }
    }
    return best;
}

function getMoodScores(track: Record<string, unknown>): Record<string, number> {
    const moods: Record<string, number> = {};
    for (const field of MOOD_FIELDS) {
        const val = track[field] as number | null | undefined;
        if (val != null) moods[field] = val;
    }
    return moods;
}

const UMAP_TIMEOUT_MS = 15 * 60 * 1000;
const UMAP_WARN_MS = 5 * 60 * 1000;

function runUmapInWorker(embeddings: number[][], nNeighbors: number): Promise<number[][]> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, "../workers/umapWorker.js"), {
            workerData: { embeddings, nNeighbors },
        });

        let settled = false;

        const warnTimer = setTimeout(() => {
            logger.warn(`[VIBE-MAP] UMAP worker running for 5+ minutes (${embeddings.length} tracks)`);
        }, UMAP_WARN_MS);

        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                clearTimeout(warnTimer);
                worker.terminate();
                reject(new Error(`UMAP worker timed out after ${UMAP_TIMEOUT_MS / 60000} minutes`));
            }
        }, UMAP_TIMEOUT_MS);

        worker.on("message", (result) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                clearTimeout(warnTimer);
                if (result?.error) {
                    reject(new Error(result.error));
                } else {
                    resolve(result);
                }
            }
        });

        worker.on("error", (err) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                clearTimeout(warnTimer);
                reject(err);
            }
        });

        worker.on("exit", (code) => {
            if (!settled && code !== 0) {
                settled = true;
                clearTimeout(timeout);
                clearTimeout(warnTimer);
                reject(new Error(`UMAP worker exited with code ${code}`));
            }
        });
    });
}

let computePromise: Promise<MapResponse> | null = null;

export async function computeMapProjection(): Promise<MapResponse> {
    const cached = await redisClient.get(CACHE_KEY);
    if (cached) {
        logger.debug("[VIBE-MAP] Cache hit (stable key)");
        return JSON.parse(cached);
    }

    if (computePromise) {
        logger.info("[VIBE-MAP] Waiting for in-progress computation");
        return computePromise;
    }

    computePromise = doCompute();
    try {
        return await computePromise;
    } finally {
        computePromise = null;
    }
}

async function cacheResult(result: MapResponse, trackIds: string[]): Promise<void> {
    try {
        const pipeline = redisClient.multi();
        pipeline.setEx(CACHE_KEY, CACHE_TTL, JSON.stringify(result));
        pipeline.del(TRACK_IDS_KEY);
        if (trackIds.length > 0) {
            pipeline.sAdd(TRACK_IDS_KEY, trackIds);
            pipeline.expire(TRACK_IDS_KEY, CACHE_TTL);
        }
        await pipeline.exec();
    } catch (e) {
        logger.warn("[VIBE-MAP] Failed to cache projection:", (e as Error).message);
    }
}

type TrackRow = {
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
};

async function buildCircularLayout(rows: (TrackRow & { embedding: string })[]): Promise<MapResponse> {
    const trackIds = rows.map(r => r.track_id);
    const result: MapResponse = {
        tracks: rows.map((r, i) => {
            const dominant = getDominantMood(r as Record<string, unknown>);
            const angle = (2 * Math.PI * i) / rows.length;
            return {
                id: r.track_id,
                x: 0.5 + 0.3 * Math.cos(angle),
                y: 0.5 + 0.3 * Math.sin(angle),
                title: r.title,
                artist: r.artistName,
                artistId: r.artistId,
                albumId: r.albumId,
                coverUrl: r.coverUrl,
                dominantMood: dominant.mood,
                moodScore: dominant.score,
                moods: getMoodScores(r as Record<string, unknown>),
                energy: r.energy,
                valence: r.valence,
            };
        }),
        trackCount: rows.length,
        computedAt: new Date().toISOString(),
    };
    await cacheResult(result, trackIds);
    return result;
}

async function doCompute(): Promise<MapResponse> {
    const startTime = Date.now();

    const rows = await prisma.$queryRaw<Array<TrackRow & { embedding: string }>>`
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
        ORDER BY RANDOM()
        LIMIT ${MAX_EMBEDDINGS}
    `;

    if (rows.length === 0) {
        return { tracks: [], trackCount: 0, computedAt: new Date().toISOString() };
    }

    const sampled = rows.length === MAX_EMBEDDINGS;

    logger.info(`[VIBE-MAP] Computing UMAP projection for ${rows.length} tracks${sampled ? " (sampled)" : ""}...`);

    if (rows.length < MIN_TRACKS_FOR_UMAP) {
        return buildCircularLayout(rows);
    }

    const embeddings: number[][] = rows.map(r => parseEmbedding(r.embedding));
    const nNeighbors = Math.min(15, Math.max(2, Math.floor(rows.length / 2)));

    const projection = await runUmapInWorker(embeddings, nNeighbors);

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

    const trackIds = rows.map(r => r.track_id);
    const tracks: MapTrack[] = rows.map((row, i) => {
        const dominant = getDominantMood(row as Record<string, unknown>);
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
            moods: getMoodScores(row as Record<string, unknown>),
            energy: row.energy,
            valence: row.valence,
        };
    });

    const result: MapResponse = {
        tracks,
        trackCount: tracks.length,
        ...(sampled && { sampled: true }),
        computedAt: new Date().toISOString(),
    };

    await cacheResult(result, trackIds);

    const elapsed = Date.now() - startTime;
    logger.info(`[VIBE-MAP] UMAP projection computed in ${elapsed}ms for ${tracks.length} tracks`);

    return result;
}

// Note: read-modify-write on Redis is not atomic -- concurrent vibe/success
// callbacks can cause a lost append. Acceptable because precomputeProjection()
// runs at enrichment completion and catches all tracks with a full UMAP.
export async function appendTrackToProjection(trackId: string): Promise<boolean> {
    try {
        const cached = await redisClient.get(CACHE_KEY);
        if (!cached) return false;

        const alreadyIncluded = await redisClient.sIsMember(TRACK_IDS_KEY, trackId);
        if (alreadyIncluded) return false;

        // Find K nearest neighbors via pgvector cosine distance
        const neighbors = await prisma.$queryRaw<Array<{
            track_id: string;
            distance: number;
        }>>`
            SELECT
                te2.track_id,
                te1.embedding <=> te2.embedding AS distance
            FROM track_embeddings te1
            JOIN track_embeddings te2 ON te2.track_id != te1.track_id
            WHERE te1.track_id = ${trackId}
            ORDER BY te1.embedding <=> te2.embedding
            LIMIT ${KNN_NEIGHBORS * 3}
        `;

        if (neighbors.length === 0) return false;

        const projection: MapResponse = JSON.parse(cached);
        const trackPositions = new Map<string, { x: number; y: number }>();
        for (const t of projection.tracks) {
            trackPositions.set(t.id, { x: t.x, y: t.y });
        }

        // Filter to neighbors that exist in our projection
        const validNeighbors = neighbors
            .filter(n => trackPositions.has(n.track_id))
            .slice(0, KNN_NEIGHBORS);

        if (validNeighbors.length === 0) return false;

        // Inverse distance weighted average of neighbor positions
        let weightSum = 0;
        let wx = 0;
        let wy = 0;
        for (const neighbor of validNeighbors) {
            const pos = trackPositions.get(neighbor.track_id)!;
            const weight = 1 / (neighbor.distance + 1e-6);
            wx += pos.x * weight;
            wy += pos.y * weight;
            weightSum += weight;
        }

        const newX = wx / weightSum;
        const newY = wy / weightSum;

        // Fetch track metadata
        const trackData = await prisma.$queryRaw<TrackRow[]>`
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
                t."moodElectronic"
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE te.track_id = ${trackId}
        `;

        if (trackData.length === 0) return false;

        const row = trackData[0];
        const dominant = getDominantMood(row as Record<string, unknown>);

        const newTrack: MapTrack = {
            id: row.track_id,
            x: newX,
            y: newY,
            title: row.title,
            artist: row.artistName,
            artistId: row.artistId,
            albumId: row.albumId,
            coverUrl: row.coverUrl,
            dominantMood: dominant.mood,
            moodScore: dominant.score,
            moods: getMoodScores(row as Record<string, unknown>),
            energy: row.energy,
            valence: row.valence,
        };

        projection.tracks.push(newTrack);
        projection.trackCount = projection.tracks.length;

        const pipeline = redisClient.multi();
        pipeline.setEx(CACHE_KEY, CACHE_TTL, JSON.stringify(projection));
        pipeline.sAdd(TRACK_IDS_KEY, trackId);
        await pipeline.exec();

        logger.debug(`[VIBE-MAP] Appended track ${trackId} via KNN interpolation (${validNeighbors.length} neighbors)`);
        return true;
    } catch (e) {
        logger.warn(`[VIBE-MAP] Failed to append track ${trackId}:`, (e as Error).message);
        return false;
    }
}

export async function precomputeProjection(): Promise<void> {
    try {
        await redisClient.del(CACHE_KEY);
        await redisClient.del(TRACK_IDS_KEY);
        const result = await computeMapProjection();
        logger.info(`[VIBE-MAP] Pre-computed projection: ${result.trackCount} tracks`);
    } catch (e) {
        logger.error("[VIBE-MAP] Pre-computation failed:", (e as Error).message);
    }
}
