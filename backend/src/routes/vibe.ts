import { Router, type Request, type Response } from "express";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { requireAuth } from "../middleware/auth";
import { UserFacingError } from "../utils/errors";
import { findSimilarTracks } from "../services/hybridSimilarity";
import { getVibeMap, type MapResponse } from "../services/vibeMap";
import { currentMoodSnapshot, moodOutput } from "../services/moodBucketService";
import { generateSongPath } from "../services/songPath";
import { searchTracksByText } from "../services/textEmbeddingBridge";
import { SELF_SCORE, blendSelfScore } from "../services/matching/formula";
import { matchingContext, rankMatches, weightedTracks } from "../services/matching/rank";
import { createHash } from "node:crypto";

/** A requested result count: 1 to 100, 20 when missing or not a number. */
function resultLimit(value: unknown): number {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20;
}

const router = Router();
const gzipAsync = promisify(gzip);

const CUID_RE = /^c[a-z0-9]{20,30}$/;

function sanitizeForLog(s: string): string {
    return s.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100);
}

// A large library's map is tens of megabytes of JSON that compresses ~8x, and
// the app has no global compression middleware. Gzip it here, once per version
// of the map and of the mood snapshot, not once per request.
let gzippedMap: { key: string; body: Buffer } | null = null;
async function sendMapJson(req: Request, res: Response, mapData: MapResponse) {
    const acceptsGzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    if (!acceptsGzip) {
        res.json(mapData);
        return;
    }
    // Keyed on the content itself, so a renamed track or a new cover is never served stale.
    const json = JSON.stringify(mapData);
    const key = createHash("sha1").update(json).digest("base64");
    if (gzippedMap?.key !== key) {
        gzippedMap = { key, body: await gzipAsync(Buffer.from(json)) };
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    res.send(gzippedMap.body);
}

/**
 * GET /api/vibe/map: every track's position and colour from the similarity
 * step; 202 while the first layout is pending.
 */
router.get("/map", requireAuth, async (req, res) => {
    try {
        const state = await getVibeMap();
        if (state.status === "computing") {
            res.status(202).json({ computing: true });
            return;
        }
        await sendMapJson(req, res, state.data);
    } catch (error) {
        logger.error("Vibe map error:", error);
        res.status(500).json({ error: "Failed to read the vibe map" });
    }
});

/**
 * POST /api/vibe/path
 * Generate a smooth musical journey between two tracks.
 */
router.post("/path", requireAuth, async (req, res) => {
    try {
        const { startTrackId, endTrackId, length, mode } = req.body;

        if (!startTrackId || !endTrackId || typeof startTrackId !== "string" || typeof endTrackId !== "string") {
            return res.status(400).json({ error: "startTrackId and endTrackId are required strings" });
        }

        if (!CUID_RE.test(startTrackId) || !CUID_RE.test(endTrackId)) {
            return res.status(400).json({ error: "Invalid track ID format" });
        }

        if (startTrackId === endTrackId) {
            return res.status(400).json({ error: "Start and end tracks must be different" });
        }

        const result = await generateSongPath(startTrackId, endTrackId, {
            length: length ? Math.max(5, Math.min(50, length)) : undefined,
            mode: mode === "discovery" ? "discovery" : "smooth",
        });

        res.json(result);
    } catch (error) {
        if (error instanceof UserFacingError) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        logger.error("Song path error:", error);
        res.status(500).json({ error: "Failed to generate song path" });
    }
});

/**
 * POST /api/vibe/alchemy
 * Tracks matching a blend on the matching formula: the add tracks weighted
 * 1/|add| each, the subtract tracks weighted -1/|subtract| each.
 */
router.post("/alchemy", requireAuth, async (req, res) => {
    try {
        const { add, subtract, limit: requestedLimit } = req.body;

        if (!add || !Array.isArray(add) || add.length === 0) {
            return res.status(400).json({ error: "At least one track ID in 'add' is required" });
        }

        if (add.length > 10) {
            return res.status(400).json({ error: "'add' may contain at most 10 tracks" });
        }

        if (subtract && (!Array.isArray(subtract) || subtract.length > 10)) {
            return res.status(400).json({ error: "'subtract' must be an array of at most 10 tracks" });
        }

        if (!add.every((id: unknown) => typeof id === "string" && CUID_RE.test(id))) {
            return res.status(400).json({ error: "'add' must contain valid track IDs" });
        }

        if (subtract && !subtract.every((id: unknown) => typeof id === "string" && CUID_RE.test(id))) {
            return res.status(400).json({ error: "'subtract' must contain valid track IDs" });
        }

        const limit = resultLimit(requestedLimit);
        const addIds: string[] = add;
        const subtractIds: string[] = subtract ?? [];

        const ctx = await matchingContext([...addIds, ...subtractIds]);
        const missingAdd = addIds.filter((id) => !ctx?.tracks.has(id));
        const missingSubtract = subtractIds.filter((id) => !ctx?.tracks.has(id));
        if (!ctx || missingAdd.length > 0 || missingSubtract.length > 0) {
            return res.status(400).json({
                error: "Some tracks have not been through the similarity step yet",
                missingAdd,
                missingSubtract,
            });
        }

        const inputs = [
            ...addIds.map((trackId) => ({ trackId, weight: 1 / addIds.length })),
            ...subtractIds.map((trackId) => ({ trackId, weight: -1 / subtractIds.length })),
        ];
        const blendSq = blendSelfScore(
            weightedTracks(ctx, inputs),
            ctx.state.genres,
            ctx.state.genreWeight ** 2,
        );
        if (!(blendSq > 0)) {
            return res.status(400).json({ error: "The tracks to add and to subtract cancel each other out" });
        }

        const rows = await rankMatches(ctx, inputs, { limit, counted: addIds });
        const scale = Math.sqrt(blendSq * SELF_SCORE);

        res.json({
            tracks: rows.map((t) => {
                const match = t.score / scale;
                return {
                    id: t.id,
                    title: t.title,
                    duration: t.duration,
                    distance: 1 - match,
                    similarity: Math.min(1, Math.max(0, match)),
                    album: { id: t.albumId, title: t.albumTitle, coverUrl: t.albumCoverUrl },
                    artist: { id: t.artistId, name: t.artistName },
                };
            }),
        });
    } catch (error) {
        logger.error("Alchemy error:", error);
        res.status(500).json({ error: "Failed to compute alchemy blend" });
    }
});

/**
 * GET /api/vibe/similar/:trackId
 * Tracks similar to a given track on the matching formula.
 */
router.get("/similar/:trackId", requireAuth, async (req, res) => {
    try {
        const { trackId } = req.params;
        const limit = Math.min(
            Math.max(1, parseInt(req.query.limit as string) || 20),
            100
        );

        const tracks = await findSimilarTracks(trackId, limit);

        if (tracks.length === 0) {
            return res.status(404).json({
                error: "No similar tracks found",
                message: "This track may not have been analyzed yet, or no analyzer is running",
            });
        }

        res.json({
            sourceTrackId: trackId,
            tracks: tracks.map((t) => ({
                id: t.id,
                title: t.title,
                duration: t.duration,
                distance: t.distance,
                similarity: t.similarity,
                album: {
                    id: t.albumId,
                    title: t.albumTitle,
                    coverUrl: t.albumCoverUrl,
                },
                artist: {
                    id: t.artistId,
                    name: t.artistName,
                },
            })),
        });
    } catch (error) {
        logger.error("Hybrid similarity error:", error);
        res.status(500).json({ error: "Failed to find similar tracks" });
    }
});

// Convert pgvector cosine distance to similarity (0-1)
// distance 0 = identical, distance 1 = orthogonal, distance 2 = opposite
function distanceToSimilarity(distance: number): number {
    return Math.max(0, 1 - distance);
}

/**
 * POST /api/vibe/search
 * Search for tracks using natural language text via CLAP text embeddings.
 * Returns the nearest `limit` tracks, best first, with no similarity cut-off
 * (see searchTracksByText for why a fixed or per-query floor does not work).
 */
router.post("/search", requireAuth, async (req, res) => {
    try {
        const { query, limit: requestedLimit } = req.body;

        if (!query || typeof query !== "string" || query.trim().length < 2) {
            return res.status(400).json({
                error: "Query must be at least 2 characters",
            });
        }

        if (query.length > 500) {
            return res.status(400).json({
                error: "Query must be at most 500 characters",
            });
        }

        const limit = resultLimit(requestedLimit);

        const trimmedQuery = query.trim();
        const rows = await searchTracksByText(trimmedQuery, limit);

        logger.debug(`[VIBE-SEARCH] "${sanitizeForLog(trimmedQuery)}": ${rows.length} tracks, top: ${rows[0]?.title || "none"}`);

        res.json({
            query: trimmedQuery,
            tracks: rows.map((row) => ({
                id: row.id,
                title: row.title,
                duration: row.duration,
                trackNo: row.trackNo,
                distance: row.distance,
                similarity: distanceToSimilarity(row.distance),
                album: {
                    id: row.albumId,
                    title: row.albumTitle,
                    coverUrl: row.albumCoverUrl,
                },
                artist: {
                    id: row.artistId,
                    name: row.artistName,
                },
            })),
        });
    } catch (error) {
        logger.error("Vibe text search error:", error);
        if (error instanceof Error && error.message.includes("timed out")) {
            return res.status(504).json({
                error: "Text embedding service unavailable",
                message: "The CLAP analyzer service did not respond in time",
            });
        }
        res.status(500).json({ error: "Failed to search tracks by vibe" });
    }
});

/**
 * GET /api/vibe/mood/:trackId
 * The track's dominant mood, the same one that colours its star on the map.
 */
router.get("/mood/:trackId", requireAuth, async (req, res) => {
    try {
        const snap = await currentMoodSnapshot();
        res.json({ dominantMood: moodOutput(snap.views.get(req.params.trackId)).dominantMood });
    } catch (error) {
        logger.error("Track mood error:", error);
        res.status(500).json({ error: "Failed to read the track's mood" });
    }
});

/**
 * GET /api/vibe/status
 * Get embedding analysis progress statistics
 */
router.get("/status", requireAuth, async (_req, res) => {
    try {
        const totalTracks = await prisma.track.count();

        const embeddedTracks = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) as count FROM track_embeddings
        `;

        const embeddedCount = Number(embeddedTracks[0]?.count || 0);
        const progress = totalTracks > 0
            ? Math.round((embeddedCount / totalTracks) * 100)
            : 0;

        res.json({
            totalTracks,
            embeddedTracks: embeddedCount,
            progress,
            isComplete: embeddedCount >= totalTracks && totalTracks > 0,
        });
    } catch (error) {
        logger.error("Vibe status error:", error);
        res.status(500).json({ error: "Failed to get embedding status" });
    }
});

export default router;
