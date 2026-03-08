import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { parseEmbedding } from "../utils/embedding";

const MIN_PATH_DISTANCE = 0.15;

interface PathTrack {
    id: string;
    title: string;
    duration: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
}

interface PathResult {
    startTrack: PathTrack;
    endTrack: PathTrack;
    path: PathTrack[];
    metadata: {
        totalTracks: number;
        embeddingDistance: number;
        averageStepSize: number;
        mode: string;
    };
}

/**
 * Generate a smooth musical journey between two tracks using CLAP embedding interpolation.
 *
 * Algorithm:
 * 1. Get start/end CLAP embeddings (512-dim)
 * 2. Calculate cosine distance between them
 * 3. Determine number of waypoints based on distance
 * 4. For each waypoint, interpolate between start/end embeddings
 * 5. Query pgvector for nearest unvisited track to each interpolated point
 * 6. Apply artist diversity filter
 */
export async function generateSongPath(
    startTrackId: string,
    endTrackId: string,
    options: { length?: number; mode?: "smooth" | "discovery" } = {}
): Promise<PathResult> {
    const mode = options.mode || "smooth";

    const [startInfo, endInfo] = await Promise.all([
        getTrackInfo(startTrackId),
        getTrackInfo(endTrackId),
    ]);

    if (!startInfo || !endInfo) {
        throw new Error("One or both tracks not found or missing embeddings");
    }

    const [startEmb, endEmb] = await Promise.all([
        getEmbedding(startTrackId),
        getEmbedding(endTrackId),
    ]);

    if (!startEmb || !endEmb) {
        throw new Error("One or both tracks missing CLAP embeddings. Run vibe analysis first.");
    }

    const distance = cosineDistance(startEmb, endEmb);

    if (distance < MIN_PATH_DISTANCE) {
        throw new Error("TRACKS_TOO_SIMILAR");
    }

    const numWaypoints = options.length || Math.max(8, Math.min(50, Math.round(distance * 15)));

    logger.info(`[SONG-PATH] Generating ${mode} path: ${numWaypoints} waypoints, distance=${distance.toFixed(3)}`);

    const visitedIds = new Set<string>([startTrackId, endTrackId]);
    const path: PathTrack[] = [];
    let totalStepSize = 0;

    for (let i = 1; i <= numWaypoints; i++) {
        const t = i / (numWaypoints + 1);
        const interpolated = interpolateEmbeddings(startEmb, endEmb, t);

        const pickIndex = mode === "discovery" ? Math.floor(Math.random() * 3) : 0;
        const candidateLimit = mode === "discovery" ? 5 : 3;

        const candidates = await prisma.$queryRaw<Array<{
            id: string;
            title: string;
            duration: number;
            albumId: string;
            albumTitle: string;
            albumCoverUrl: string | null;
            artistId: string;
            artistName: string;
            distance: number;
        }>>`
            SELECT
                t.id,
                t.title,
                t.duration,
                a.id as "albumId",
                a.title as "albumTitle",
                a."coverUrl" as "albumCoverUrl",
                ar.id as "artistId",
                ar.name as "artistName",
                te.embedding <=> ${interpolated}::vector AS distance
            FROM track_embeddings te
            JOIN "Track" t ON te.track_id = t.id
            JOIN "Album" a ON t."albumId" = a.id
            JOIN "Artist" ar ON a."artistId" = ar.id
            WHERE te.track_id != ALL(${Array.from(visitedIds)})
            ORDER BY te.embedding <=> ${interpolated}::vector
            LIMIT ${candidateLimit + 5}
        `;

        if (candidates.length === 0) break;

        let selected = candidates[Math.min(pickIndex, candidates.length - 1)];

        if (path.length >= 2) {
            const prev1 = path[path.length - 1];
            const prev2 = path[path.length - 2];
            if (prev1.artistId === prev2.artistId && selected.artistId === prev1.artistId) {
                const threshold = candidates[0].distance * 1.05;
                const alt = candidates.find(
                    c => c.artistId !== prev1.artistId && c.distance <= threshold
                );
                if (alt) selected = alt;
            }
        }

        visitedIds.add(selected.id);
        totalStepSize += selected.distance;
        path.push({
            id: selected.id,
            title: selected.title,
            duration: selected.duration,
            albumId: selected.albumId,
            albumTitle: selected.albumTitle,
            albumCoverUrl: selected.albumCoverUrl,
            artistId: selected.artistId,
            artistName: selected.artistName,
        });
    }

    return {
        startTrack: startInfo,
        endTrack: endInfo,
        path,
        metadata: {
            totalTracks: path.length + 2,
            embeddingDistance: distance,
            averageStepSize: path.length > 0 ? totalStepSize / path.length : 0,
            mode,
        },
    };
}

async function getTrackInfo(trackId: string): Promise<PathTrack | null> {
    const result = await prisma.$queryRaw<PathTrack[]>`
        SELECT
            t.id, t.title, t.duration,
            a.id as "albumId", a.title as "albumTitle", a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId", ar.name as "artistName"
        FROM "Track" t
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE t.id = ${trackId}
    `;
    return result[0] || null;
}

async function getEmbedding(trackId: string): Promise<number[] | null> {
    const result = await prisma.$queryRaw<Array<{ embedding: string }>>`
        SELECT embedding::text as embedding FROM track_embeddings WHERE track_id = ${trackId}
    `;
    if (!result[0]) return null;
    return parseEmbedding(result[0].embedding);
}

function cosineDistance(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 2;
    return 1 - (dot / denom);
}

function interpolateEmbeddings(start: number[], end: number[], t: number): number[] {
    const result = new Array(start.length);
    for (let i = 0; i < start.length; i++) {
        result[i] = start[i] + (end[i] - start[i]) * t;
    }
    let norm = 0;
    for (let i = 0; i < result.length; i++) norm += result[i] * result[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < result.length; i++) result[i] /= norm;
    }
    return result;
}
