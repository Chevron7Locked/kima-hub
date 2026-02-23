// backend/src/services/vibeVocabulary.ts

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger";
import { VOCAB_DEFINITIONS, FeatureProfile, TermType } from "../data/featureProfiles";

// Force TypeScript to copy JSON to dist (without actually using it here - runtime reads the file directly)
import _vocabData from "../data/vibe-vocabulary.json";
void(_vocabData); // Prevent unused variable warning

export interface VocabTerm {
    name: string;
    type: TermType;
    embedding: number[];
    featureProfile: FeatureProfile;
    related?: string[];
}

export interface Vocabulary {
    terms: Record<string, VocabTerm>;
    version: string;
    generatedAt: string;
}

export interface QueryExpansionResult {
    embedding: number[];
    genreConfidence: number;
    matchedTerms: VocabTerm[];
    originalQuery: string;
}

let vocabulary: Vocabulary | null = null;

/**
 * Load vocabulary from JSON file. Call at startup.
 */
export function loadVocabulary(): Vocabulary | null {
    // Try multiple paths: dist/data (compiled), src/data (dev/source), relative to __dirname
    const possiblePaths = [
        join(__dirname, "../data/vibe-vocabulary.json"),        // Works in dev (tsx)
        join(__dirname, "../../src/data/vibe-vocabulary.json"), // Works in prod (dist -> src)
    ];

    const vocabPath = possiblePaths.find(p => existsSync(p));

    if (!vocabPath) {
        logger.warn("[VIBE-VOCAB] Vocabulary file not found. Run generateVibeVocabulary script.");
        logger.warn("[VIBE-VOCAB] Searched paths:", possiblePaths);
        return null;
    }

    try {
        const data = JSON.parse(readFileSync(vocabPath, "utf-8"));
        vocabulary = data as Vocabulary;
        logger.info(`[VIBE-VOCAB] Loaded ${Object.keys(vocabulary.terms).length} vocabulary terms`);
        return vocabulary;
    } catch (error) {
        logger.error("[VIBE-VOCAB] Failed to load vocabulary:", error);
        return null;
    }
}

/**
 * Get loaded vocabulary (or attempt to load if not loaded)
 */
export function getVocabulary(): Vocabulary | null {
    if (!vocabulary) {
        return loadVocabulary();
    }
    return vocabulary;
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Calculate weighted average of multiple embeddings
 */
export function blendEmbeddings(
    items: Array<{ embedding: number[]; weight: number }>
): number[] {
    if (items.length === 0) return [];

    const dim = items[0].embedding.length;
    const result = new Array(dim).fill(0);
    let totalWeight = 0;

    for (const { embedding, weight } of items) {
        for (let i = 0; i < dim; i++) {
            result[i] += embedding[i] * weight;
        }
        totalWeight += weight;
    }

    if (totalWeight > 0) {
        for (let i = 0; i < dim; i++) {
            result[i] /= totalWeight;
        }
    }

    return result;
}

/**
 * Find vocabulary terms similar to a query embedding
 */
export function findSimilarTerms(
    queryEmbedding: number[],
    vocab: Vocabulary,
    minSimilarity: number = 0.55,
    maxTerms: number = 5
): Array<{ term: VocabTerm; similarity: number }> {
    const matches: Array<{ term: VocabTerm; similarity: number }> = [];

    for (const [, term] of Object.entries(vocab.terms)) {
        const similarity = cosineSimilarity(queryEmbedding, term.embedding);
        if (similarity >= minSimilarity) {
            matches.push({ term, similarity });
        }
    }

    return matches
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, maxTerms);
}

/**
 * Expand a query using vocabulary term matching
 */
export function expandQueryWithVocabulary(
    queryEmbedding: number[],
    originalQuery: string,
    vocab: Vocabulary
): QueryExpansionResult {
    // Find similar vocabulary terms
    const matches = findSimilarTerms(queryEmbedding, vocab, 0.55, 5);

    if (matches.length === 0) {
        // No matches - return original embedding
        return {
            embedding: queryEmbedding,
            genreConfidence: 0,
            matchedTerms: [],
            originalQuery
        };
    }

    // Calculate genre confidence (highest similarity to a genre term)
    const genreMatches = matches.filter(m => m.term.type === "genre");
    const genreConfidence = genreMatches.length > 0 ? genreMatches[0].similarity : 0;

    // Blend embeddings: 60% original query, 40% distributed among matches
    const embeddingItems: Array<{ embedding: number[]; weight: number }> = [
        { embedding: queryEmbedding, weight: 0.6 }
    ];

    const matchWeight = 0.4 / matches.length;
    for (const match of matches) {
        embeddingItems.push({
            embedding: match.term.embedding,
            weight: matchWeight * match.similarity
        });
    }

    const blendedEmbedding = blendEmbeddings(embeddingItems);

    return {
        embedding: blendedEmbedding,
        genreConfidence,
        matchedTerms: matches.map(m => m.term),
        originalQuery
    };
}

/**
 * Blend multiple feature profiles into a target profile
 */
export function blendFeatureProfiles(terms: VocabTerm[]): FeatureProfile {
    if (terms.length === 0) return {};

    const features = ["energy", "valence", "danceability", "acousticness",
                      "instrumentalness", "arousal", "speechiness"] as const;

    const result: FeatureProfile = {};

    for (const feature of features) {
        const values = terms
            .map(t => t.featureProfile[feature])
            .filter((v): v is number => v !== undefined);

        if (values.length > 0) {
            result[feature] = values.reduce((a, b) => a + b, 0) / values.length;
        }
    }

    return result;
}

/**
 * Calculate how well a track's features match a target profile
 */
export function calculateFeatureMatch(
    trackFeatures: Record<string, number | null>,
    targetProfile: FeatureProfile
): number {
    let score = 0;
    let count = 0;

    for (const [feature, targetValue] of Object.entries(targetProfile)) {
        if (targetValue === undefined) continue;

        const trackValue = trackFeatures[feature] ?? 0.5;
        const match = 1 - Math.abs(trackValue - targetValue);
        score += match;
        count++;
    }

    return count > 0 ? score / count : 0.5;
}

/**
 * Re-rank CLAP candidates using audio features
 */
export function rerankWithFeatures<T extends {
    id: string;
    distance: number;
    energy?: number | null;
    valence?: number | null;
    danceability?: number | null;
    acousticness?: number | null;
    instrumentalness?: number | null;
    arousal?: number | null;
    speechiness?: number | null;
}>(
    candidates: T[],
    matchedTerms: VocabTerm[],
    genreConfidence: number
): Array<T & { finalScore: number; clapScore: number; featureScore: number }> {
    // Build composite feature profile from matched terms
    const targetProfile = blendFeatureProfiles(matchedTerms);

    // Calculate dynamic weights based on genre confidence
    // High confidence (0.8+) → 40% CLAP, 60% features
    // Low confidence (0.3)  → 80% CLAP, 20% features
    const featureWeight = 0.2 + (genreConfidence * 0.5);
    const clapWeight = 1 - featureWeight;

    logger.debug(`[VIBE-RERANK] Genre confidence: ${(genreConfidence * 100).toFixed(0)}%, ` +
                 `Weights: CLAP ${(clapWeight * 100).toFixed(0)}% / Features ${(featureWeight * 100).toFixed(0)}%`);

    return candidates.map(track => {
        // CLAP score: convert distance to 0-1 similarity
        const clapScore = Math.max(0, 1 - (track.distance / 2));

        // Feature score
        const trackFeatures: Record<string, number | null> = {
            energy: track.energy ?? null,
            valence: track.valence ?? null,
            danceability: track.danceability ?? null,
            acousticness: track.acousticness ?? null,
            instrumentalness: track.instrumentalness ?? null,
            arousal: track.arousal ?? null,
            speechiness: track.speechiness ?? null
        };

        const featureScore = Object.keys(targetProfile).length > 0
            ? calculateFeatureMatch(trackFeatures, targetProfile)
            : 0.5;

        // Blend scores
        const finalScore = (clapWeight * clapScore) + (featureWeight * featureScore);

        return {
            ...track,
            finalScore,
            clapScore,
            featureScore
        };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}
