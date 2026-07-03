import path from "path";
import { Worker } from "worker_threads";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { parseEmbedding } from "../utils/embedding";

const MIN_TRACKS_FOR_UMAP = 5;
const MAX_EMBEDDINGS = 15000;
const CACHE_KEY = "vibe:map:v3:projection";
const TRACK_IDS_KEY = "vibe:map:v3:track_ids";
const CACHE_TTL = 86400;
const CIRCULAR_CACHE_TTL = 3600; // 1 hour -- refreshes as enrichment adds tracks
const KNN_NEIGHBORS = 5;
const HYDRATE_COVERAGE_THRESHOLD = 0.98;

// SQL fragment: the shared column list for track metadata joins.
// Update in one place when adding/removing projection fields.
const TRACK_METADATA_COLUMNS = Prisma.sql`
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
`;

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

    // Try DB hydrate path: if every embedding has a persisted map position,
    // we can skip the expensive UMAP worker entirely and just hydrate metadata.
    const dbResult = await hydrateFromDb();
    if (dbResult) {
        await cacheResult(dbResult, dbResult.tracks.map(t => t.id));
        logger.info(`[VIBE-MAP] Hydrated ${dbResult.trackCount} tracks from DB positions`);
        return dbResult;
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

// Bulk persist normalized UMAP positions back to the embedding table. Uses
// UNNEST of three parallel arrays so 8-15k rows go in a single statement.
async function persistPositions(ids: string[], xs: number[], ys: number[]): Promise<void> {
    if (ids.length === 0) return;
    try {
        await prisma.$executeRaw`
            UPDATE track_embeddings AS te
            SET map_x = u.x, map_y = u.y
            FROM UNNEST(
                ${ids}::text[],
                ${xs}::float8[],
                ${ys}::float8[]
            ) AS u(tid, x, y)
            WHERE te.track_id = u.tid
        `;
    } catch (e) {
        logger.warn("[VIBE-MAP] Failed to persist positions:", (e as Error).message);
    }
}

// Attempt to serve the map from persisted DB positions without running UMAP.
// Returns null if coverage is incomplete (new tracks enriched since last run,
// positions never computed, etc.) so the caller falls through to doCompute().
async function hydrateFromDb(): Promise<MapResponse | null> {
    try {
        const coverage = await prisma.$queryRaw<Array<{ total: bigint; covered: bigint }>>`
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE map_x IS NOT NULL AND map_y IS NOT NULL) AS covered
            FROM track_embeddings
        `;
        const total = Number(coverage[0]?.total ?? 0n);
        const covered = Number(coverage[0]?.covered ?? 0n);
        if (total === 0) return null;
        if (covered / total < HYDRATE_COVERAGE_THRESHOLD) {
            logger.info(`[VIBE-MAP] DB hydrate skipped: ${covered}/${total} below threshold`);
            return null;
        }
        if (covered < total) {
            logger.info(`[VIBE-MAP] DB hydrate with partial coverage: ${covered}/${total}`);
        }

        const rows = await prisma.$queryRaw<Array<TrackRow & { map_x: number; map_y: number }>>`
            SELECT
                te.track_id,
                te.map_x,
                te.map_y,
                ${TRACK_METADATA_COLUMNS}
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE te.map_x IS NOT NULL AND te.map_y IS NOT NULL
            ORDER BY te.track_id ASC
            LIMIT ${MAX_EMBEDDINGS}
        `;

        if (rows.length === 0) {
            logger.warn("[VIBE-MAP] Hydrate SELECT returned 0 rows despite coverage check - race condition");
            return null;
        }

        const sampled = rows.length === MAX_EMBEDDINGS;
        const tracks: MapTrack[] = rows.map(row => {
            const dominant = getDominantMood(row as Record<string, unknown>);
            return {
                id: row.track_id,
                x: row.map_x,
                y: row.map_y,
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

        return {
            tracks,
            trackCount: tracks.length,
            ...(sampled && { sampled: true }),
            computedAt: new Date().toISOString(),
        };
    } catch (e) {
        logger.warn("[VIBE-MAP] DB hydrate failed:", (e as Error).message);
        return null;
    }
}

async function cacheResult(result: MapResponse, trackIds: string[], ttl = CACHE_TTL): Promise<void> {
    try {
        const pipeline = redisClient.multi();
        pipeline.setex(CACHE_KEY, ttl, JSON.stringify(result));
        pipeline.del(TRACK_IDS_KEY);
        if (trackIds.length > 0) {
            pipeline.sadd(TRACK_IDS_KEY, trackIds);
            pipeline.expire(TRACK_IDS_KEY, ttl);
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
    await cacheResult(result, trackIds, CIRCULAR_CACHE_TTL);
    return result;
}

async function doCompute(): Promise<MapResponse> {
    const startTime = Date.now();

    const rows = await prisma.$queryRaw<Array<TrackRow & { embedding: string }>>`
        SELECT
            te.track_id,
            ${TRACK_METADATA_COLUMNS},
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
    // Scale nNeighbors with library size: sqrt gives balanced local/global structure.
    // 100 tracks -> 10, 500 tracks -> 22, 1000+ tracks -> 32-50.
    const nNeighbors = Math.min(50, Math.max(5, Math.round(Math.sqrt(rows.length))));

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
    const xs = new Array<number>(rows.length);
    const ys = new Array<number>(rows.length);
    const tracks: MapTrack[] = rows.map((row, i) => {
        const dominant = getDominantMood(row as Record<string, unknown>);
        const nx = (projection[i][0] - minX) / rangeX;
        const ny = (projection[i][1] - minY) / rangeY;
        xs[i] = nx;
        ys[i] = ny;
        return {
            id: row.track_id,
            x: nx,
            y: ny,
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

    void persistPositions(trackIds, xs, ys).catch(e =>
        logger.warn("[VIBE-MAP] persist failed (background):", (e as Error).message)
    );
    await cacheResult(result, trackIds);

    const elapsed = Date.now() - startTime;
    logger.info(`[VIBE-MAP] UMAP projection computed in ${elapsed}ms for ${tracks.length} tracks`);

    return result;
}

// Incremental appends buffer in memory and flush to Redis on a short debounce
// instead of doing a JSON.parse(full cache) -> push 1 -> JSON.stringify -> SETEX
// round-trip per track -- during an analysis burst that's O(map size) per call,
// i.e. O(n^2) for n tracks finishing around the same time.
//
// Note: the flush is still a whole-key SETEX, not atomic with a concurrent full
// recompute (doCompute/cacheResult). We guard against clobbering one by
// re-checking the cache's `computedAt` immediately before writing; if a full
// recompute landed mid-buffer we drop the flush and let that recompute stand.
// Acceptable because precomputeProjection() runs at enrichment completion and
// catches all tracks with a full UMAP regardless.
const APPEND_FLUSH_DEBOUNCE_MS = 2000;
const APPEND_FLUSH_MAX_BATCH = 50;

let workingProjection: MapResponse | null = null;
let workingTrackIds: Set<string> | null = null;
let workingProjectionLoad: Promise<MapResponse | null> | null = null;
let pendingFlushIds: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function getWorkingProjection(): Promise<MapResponse | null> {
    if (workingProjection && workingTrackIds) return workingProjection;

    if (!workingProjectionLoad) {
        workingProjectionLoad = (async () => {
            const cached = await redisClient.get(CACHE_KEY);
            if (!cached) return null;
            const projection: MapResponse = JSON.parse(cached);
            workingProjection = projection;
            workingTrackIds = new Set(projection.tracks.map(t => t.id));
            return projection;
        })();
    }

    try {
        return await workingProjectionLoad;
    } finally {
        workingProjectionLoad = null;
    }
}

function scheduleAppendFlush(): void {
    if (pendingFlushIds.length >= APPEND_FLUSH_MAX_BATCH) {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        flushPendingAppends().catch(e =>
            logger.warn("[VIBE-MAP] Append flush failed:", (e as Error).message)
        );
        return;
    }
    if (!flushTimer) {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushPendingAppends().catch(e =>
                logger.warn("[VIBE-MAP] Append flush failed:", (e as Error).message)
            );
        }, APPEND_FLUSH_DEBOUNCE_MS);
    }
}

async function flushPendingAppends(): Promise<void> {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (pendingFlushIds.length === 0 || !workingProjection) return;

    const projection = workingProjection;
    const flushedIds = pendingFlushIds;
    pendingFlushIds = [];
    // Drop the working copy either way -- the next append reloads fresh from
    // Redis, so we never keep interpolating on top of an increasingly stale base.
    workingProjection = null;
    workingTrackIds = null;

    try {
        const current = await redisClient.get(CACHE_KEY);
        if (!current) return; // cache evicted; the next full recompute will rebuild it

        const currentProjection: MapResponse = JSON.parse(current);
        if (currentProjection.computedAt !== projection.computedAt) {
            // A full recompute landed while we were buffering -- it already
            // supersedes our interpolated appends, so don't clobber it.
            logger.debug(
                "[VIBE-MAP] Skipping buffered flush: superseded by a full recompute"
            );
            return;
        }

        const pipeline = redisClient.multi();
        pipeline.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(projection));
        pipeline.sadd(TRACK_IDS_KEY, flushedIds);
        await pipeline.exec();

        logger.debug(
            `[VIBE-MAP] Flushed ${flushedIds.length} buffered append(s) to projection cache`
        );
    } catch (e) {
        logger.warn(
            "[VIBE-MAP] Failed to flush buffered projection appends:",
            (e as Error).message
        );
    }
}

export async function appendTrackToProjection(trackId: string): Promise<boolean> {
    try {
        const projection = await getWorkingProjection();
        if (!projection || !workingTrackIds) return false;

        if (workingTrackIds.has(trackId)) return false;

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
                ${TRACK_METADATA_COLUMNS}
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

        // Merge into the shared in-memory working copy; the actual Redis
        // write is coalesced across all appends in this debounce window.
        projection.tracks.push(newTrack);
        projection.trackCount = projection.tracks.length;
        workingTrackIds.add(trackId);
        pendingFlushIds.push(trackId);
        scheduleAppendFlush();

        // Persist so it survives Redis expiry and feeds hydrateFromDb(), and
        // so the position isn't lost even if the process restarts before flush.
        await persistPositions([trackId], [newX], [newY]);

        logger.debug(`[VIBE-MAP] Buffered append for track ${trackId} via KNN interpolation (${validNeighbors.length} neighbors)`);
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
