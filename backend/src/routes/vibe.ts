import { Router } from "express";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { requireAuth } from "../middleware/auth";
import { findSimilarTracks } from "../services/hybridSimilarity";
import {
    getVocabulary,
    expandQueryWithVocabulary,
    rerankWithFeatures,
    loadVocabulary,
    VocabTerm
} from "../services/vibeVocabulary";

const router = Router();

// Load vocabulary at module initialization
loadVocabulary();

interface TextSearchResult {
    id: string;
    title: string;
    duration: number;
    trackNo: number;
    distance: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
    // Audio features for re-ranking
    energy: number | null;
    valence: number | null;
    danceability: number | null;
    acousticness: number | null;
    instrumentalness: number | null;
    arousal: number | null;
    speechiness: number | null;
}

/**
 * GET /api/vibe/similar/:trackId
 * Find tracks similar to a given track using hybrid similarity (CLAP + audio features)
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
    } catch (error: any) {
        logger.error("Hybrid similarity error:", error);
        res.status(500).json({ error: "Failed to find similar tracks" });
    }
});

// Convert CLAP cosine distance (0-2 range) to similarity percentage (0-1)
// distance 0 = identical, distance 1 = orthogonal, distance 2 = opposite
function distanceToSimilarity(distance: number): number {
    return Math.max(0, 1 - distance / 2);
}

// Minimum similarity threshold for search results
// 0.65 = 65% match, meaning distance <= 0.7
const MIN_SEARCH_SIMILARITY = 0.60;

/**
 * POST /api/vibe/search
 * Search for tracks using natural language text via CLAP text embeddings
 */
router.post("/search", requireAuth, async (req, res) => {
    try {
        const { query, limit: requestedLimit, minSimilarity } = req.body;

        if (!query || typeof query !== "string" || query.trim().length < 2) {
            return res.status(400).json({
                error: "Query must be at least 2 characters",
            });
        }

        const limit = Math.min(
            Math.max(1, requestedLimit || 20),
            100
        );

        // Allow override but default to MIN_SEARCH_SIMILARITY
        const similarityThreshold = typeof minSimilarity === "number"
            ? Math.max(0, Math.min(1, minSimilarity))
            : MIN_SEARCH_SIMILARITY;

        // Convert similarity threshold to max distance
        // similarity = 1 - (distance / 2), so distance = 2 * (1 - similarity)
        const maxDistance = 2 * (1 - similarityThreshold);

        const requestId = randomUUID();
        const responseChannel = `audio:text:embed:response:${requestId}`;
        const requestChannel = "audio:text:embed";

        // Create a duplicate client for subscribing (redis client cannot subscribe and publish on same connection)
        const subscriber = redisClient.duplicate();
        await subscriber.connect();

        try {
            // Set up response handling
            let resolveEmbedding: (value: number[]) => void;
            let rejectEmbedding: (reason: Error) => void;
            const embeddingPromise = new Promise<number[]>((resolve, reject) => {
                resolveEmbedding = resolve;
                rejectEmbedding = reject;
            });

            const timeout = setTimeout(() => {
                rejectEmbedding!(new Error("Text embedding request timed out"));
            }, 60000);

            // Subscribe and wait for Redis to confirm before publishing
            await subscriber.subscribe(responseChannel, (message) => {
                clearTimeout(timeout);
                try {
                    const data = JSON.parse(message);
                    if (data.error) {
                        rejectEmbedding!(new Error(data.error));
                    } else {
                        resolveEmbedding!(data.embedding);
                    }
                } catch (e) {
                    rejectEmbedding!(new Error("Invalid response from analyzer"));
                }
            });

            // Publish the text embedding request
            await redisClient.publish(
                requestChannel,
                JSON.stringify({ requestId, text: query.trim() })
            );

            // Wait for embedding response
            const textEmbedding = await embeddingPromise;

            // Query expansion with vocabulary
            const vocab = getVocabulary();
            let searchEmbedding = textEmbedding;
            let genreConfidence = 0;
            let matchedTerms: VocabTerm[] = [];

            if (vocab) {
                const expansion = expandQueryWithVocabulary(textEmbedding, query.trim(), vocab);
                searchEmbedding = expansion.embedding;
                genreConfidence = expansion.genreConfidence;
                matchedTerms = expansion.matchedTerms;

                logger.info(`[VIBE-SEARCH] Query "${query.trim()}" expanded with terms: ${matchedTerms.map(t => t.name).join(", ") || "none"}, genre confidence: ${(genreConfidence * 100).toFixed(0)}%`);
            }

            // Query for similar tracks using the (possibly expanded) embedding
            // Fetch more candidates for re-ranking (3x limit)
            // Filter by max distance to exclude poor matches
            const similarTracks = await prisma.$queryRaw<TextSearchResult[]>`
                SELECT
                    t.id,
                    t.title,
                    t.duration,
                    t."trackNo",
                    te.embedding <=> ${searchEmbedding}::vector AS distance,
                    a.id as "albumId",
                    a.title as "albumTitle",
                    a."coverUrl" as "albumCoverUrl",
                    ar.id as "artistId",
                    ar.name as "artistName",
                    t.energy,
                    t.valence,
                    t.danceability,
                    t.acousticness,
                    t.instrumentalness,
                    t.arousal,
                    t.speechiness
                FROM track_embeddings te
                JOIN "Track" t ON te.track_id = t.id
                JOIN "Album" a ON t."albumId" = a.id
                JOIN "Artist" ar ON a."artistId" = ar.id
                WHERE te.embedding <=> ${searchEmbedding}::vector <= ${maxDistance}
                ORDER BY te.embedding <=> ${searchEmbedding}::vector
                LIMIT ${limit * 3}
            `;

            logger.info(`Vibe search "${query.trim()}": found ${similarTracks.length} candidates above ${Math.round(similarityThreshold * 100)}% similarity (max distance: ${maxDistance.toFixed(2)})`);

            // Re-rank using audio features if we have vocabulary matches
            let rankedTracks: typeof similarTracks | ReturnType<typeof rerankWithFeatures<TextSearchResult>> = similarTracks;
            if (vocab && matchedTerms.length > 0) {
                const reranked = rerankWithFeatures(similarTracks, matchedTerms, genreConfidence);
                rankedTracks = reranked.slice(0, limit);

                logger.info(`[VIBE-SEARCH] Re-ranked ${similarTracks.length} candidates, top result: ${rankedTracks[0]?.title || "none"}`);
            } else {
                rankedTracks = similarTracks.slice(0, limit);
            }

            // If we have results, log the similarity range
            if (rankedTracks.length > 0) {
                const first = rankedTracks[0];
                const last = rankedTracks[rankedTracks.length - 1];
                const bestSim = "finalScore" in first ? first.finalScore : distanceToSimilarity(first.distance);
                const worstSim = "finalScore" in last ? last.finalScore : distanceToSimilarity(last.distance);
                logger.info(`Vibe search similarity range: ${Math.round(bestSim * 100)}% - ${Math.round(worstSim * 100)}%`);
            }

            const tracks = rankedTracks.map((row) => ({
                id: row.id,
                title: row.title,
                duration: row.duration,
                trackNo: row.trackNo,
                distance: row.distance,
                similarity: "finalScore" in row ? row.finalScore : distanceToSimilarity(row.distance),
                album: {
                    id: row.albumId,
                    title: row.albumTitle,
                    coverUrl: row.albumCoverUrl,
                },
                artist: {
                    id: row.artistId,
                    name: row.artistName,
                },
            }));

            res.json({
                query: query.trim(),
                tracks,
                minSimilarity: similarityThreshold,
                totalAboveThreshold: tracks.length,
                debug: {
                    matchedTerms: matchedTerms.map(t => t.name),
                    genreConfidence,
                    featureWeight: matchedTerms.length > 0 ? 0.2 + (genreConfidence * 0.5) : 0
                }
            });
        } finally {
            await subscriber.unsubscribe(responseChannel);
            await subscriber.disconnect();
        }
    } catch (error: any) {
        logger.error("Vibe text search error:", error);
        if (error.message?.includes("timed out")) {
            return res.status(504).json({
                error: "Text embedding service unavailable",
                message: "The CLAP analyzer service did not respond in time",
            });
        }
        res.status(500).json({ error: "Failed to search tracks by vibe" });
    }
});

/**
 * GET /api/vibe/status
 * Get embedding analysis progress statistics
 */
router.get("/status", requireAuth, async (req, res) => {
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
    } catch (error: any) {
        logger.error("Vibe status error:", error);
        res.status(500).json({ error: "Failed to get embedding status" });
    }
});

export default router;
