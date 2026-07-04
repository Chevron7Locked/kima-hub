/**
 * Fuzzy matching utilities for album and artist names
 * Part of Phase 3 fix for #31 - Active downloads not resolving
 */

import { normalizeString, stripTrackSuffix } from "./normalization";

export function normalizeForMatching(str: string): string {
    return normalizeString(stripTrackSuffix(str.replace(/^(the|a|an)\s+/i, "")));
}

/**
 * Calculate simple similarity score between two strings (0-1)
 * Uses a combination of:
 * - Exact match after normalization
 * - Contains check (substring)
 * - Word overlap
 */
function calculateSimilarity(str1: string, str2: string): number {
    const normalized1 = normalizeForMatching(str1);
    const normalized2 = normalizeForMatching(str2);

    // Exact match = 1.0
    if (normalized1 === normalized2) {
        return 1.0;
    }

    // Empty strings
    if (!normalized1 || !normalized2) {
        return 0;
    }

    // One contains the other
    if (
        normalized1.includes(normalized2) ||
        normalized2.includes(normalized1)
    ) {
        const shorter =
            normalized1.length < normalized2.length ? normalized1 : normalized2;
        const longer =
            normalized1.length >= normalized2.length
                ? normalized1
                : normalized2;
        // Score based on how much of the longer string is covered
        return shorter.length / longer.length;
    }

    // Word overlap
    const words1 = normalized1.split(" ").filter((w) => w.length > 2); // Ignore short words
    const words2 = normalized2.split(" ").filter((w) => w.length > 2);

    if (words1.length === 0 || words2.length === 0) {
        return 0;
    }

    const commonWords = words1.filter((w) => words2.includes(w));
    const maxWords = Math.max(words1.length, words2.length);

    return commonWords.length / maxWords;
}

/**
 * Check if two strings match with fuzzy logic
 * @param str1 First string
 * @param str2 Second string
 * @param threshold Minimum similarity score (0-1), default 0.8
 */
function fuzzyMatch(
    str1: string,
    str2: string,
    threshold: number = 0.8
): boolean {
    const similarity = calculateSimilarity(str1, str2);
    return similarity >= threshold;
}

/**
 * Check if artist and album names match between two sources
 * Uses fuzzy matching for both artist and album
 */
export function matchAlbum(
    artist1: string,
    album1: string,
    artist2: string,
    album2: string,
    threshold: number = 0.75
): boolean {
    const artistMatch = fuzzyMatch(artist1, artist2, threshold);
    const albumMatch = fuzzyMatch(album1, album2, threshold);

    return artistMatch && albumMatch;
}
