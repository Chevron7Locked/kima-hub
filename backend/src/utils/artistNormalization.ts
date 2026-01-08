import * as fuzz from "fuzzball";

/**
 * Utility functions for normalizing artist and album names
 * to handle case-sensitivity and other variations
 */

/**
 * Canonical name and MBID for compilation/various artists
 */
export const VARIOUS_ARTISTS_CANONICAL = "Various Artists";
export const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

/**
 * Check if an artist name is a variation of "Various Artists"
 * and return the canonical form if so.
 *
 * Uses regex for flexible matching instead of exhaustive list.
 * Covers: VA, V.A., V/A, V.A, Various, Various Artist(s), <Various Artists>, etc.
 */
export function canonicalizeVariousArtists(name: string): string {
    // Strip angle brackets and trim
    const cleaned = name.trim().replace(/^<|>$/g, '');

    // Case-insensitive regex patterns for Various Artists variations
    // Pattern 1: VA, V.A., V/A, V.A (with optional dots/slashes)
    // Pattern 2: Various, Various Artist, Various Artists
    const vaPattern = /^v\.?\s*[\/.]?\s*a\.?$/i;
    const variousPattern = /^various(\s+artists?)?$/i;

    if (vaPattern.test(cleaned) || variousPattern.test(cleaned)) {
        return VARIOUS_ARTISTS_CANONICAL;
    }

    return name;
}

/**
 * Check if a platform-specific artist ID is Various Artists
 */
export function isVariousArtistsById(platform: 'deezer' | 'spotify', id: string | number): boolean {
    if (platform === 'deezer' && String(id) === '5080') {
        return true;
    }
    // Add other platform IDs as needed
    return false;
}

/**
 * Strip diacritics/accents from a string
 * e.g., "Ólafur" → "Olafur", "Björk" → "Bjork"
 */
function stripDiacritics(str: string): string {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Check if a string contains any diacritics/accents
 * Used to prefer the accented version when merging duplicates
 */
export function hasDiacritics(str: string): boolean {
    return str !== stripDiacritics(str);
}

/**
 * Given two artist names, return the "preferred" one
 * Prefers the accented version as it's likely the official spelling
 * e.g., "Olafur Arnalds" vs "Ólafur Arnalds" → "Ólafur Arnalds"
 */
export function getPreferredArtistName(name1: string, name2: string): string {
    const has1 = hasDiacritics(name1);
    const has2 = hasDiacritics(name2);
    
    // If one has accents and the other doesn't, prefer the accented one
    if (has2 && !has1) return name2;
    if (has1 && !has2) return name1;
    
    // If both or neither have accents, prefer the longer/more complete one
    return name1.length >= name2.length ? name1 : name2;
}

/**
 * Normalize an artist name for case-insensitive comparison
 * - Converts to lowercase
 * - Trims whitespace
 * - Strips diacritics/accents (Ólafur → olafur)
 * - Normalizes "&" to "and" (Of Mice & Men → of mice and men)
 * - Normalizes common variations
 * - This ensures "Olafur Arnalds" and "Ólafur Arnalds" match
 * - This ensures "Of Mice & Men" and "Of Mice And Men" match
 */
export function normalizeArtistName(name: string): string {
    let normalized = stripDiacritics(name.trim().toLowerCase());
    
    // Normalize "&" to "and" (handles "Of Mice & Men" vs "Of Mice And Men")
    normalized = normalized.replace(/\s*&\s*/g, ' and ');
    
    // Normalize multiple spaces to single space
    normalized = normalized.replace(/\s+/g, ' ');
    
    return normalized.trim();
}

/**
 * Normalize an album title for case-insensitive comparison
 * - Converts to lowercase
 * - Trims whitespace
 */
export function normalizeAlbumTitle(title: string): string {
    return title.trim().toLowerCase();
}

/**
 * Check if two artist names are similar enough to be considered the same
 * Uses fuzzy matching to catch typos like "the weeknd" vs "the weekend"
 * @param name1 First artist name
 * @param name2 Second artist name
 * @param threshold Similarity threshold (0-100), default 95
 * @returns true if names are similar enough
 */
export function areArtistNamesSimilar(
    name1: string,
    name2: string,
    threshold: number = 95
): boolean {
    // First normalize both names
    const normalized1 = normalizeArtistName(name1);
    const normalized2 = normalizeArtistName(name2);

    // If they're exactly equal after normalization, return true
    if (normalized1 === normalized2) {
        return true;
    }

    // Use fuzzy matching to catch typos
    const similarity = fuzz.ratio(normalized1, normalized2);
    return similarity >= threshold;
}

/**
 * Find the best matching artist from a list of candidates
 * @param targetName The name to match
 * @param candidates List of candidate artist names
 * @param threshold Minimum similarity score (0-100), default 95
 * @returns The best matching artist name, or null if no good match
 */
export function findBestArtistMatch(
    targetName: string,
    candidates: string[],
    threshold: number = 95
): string | null {
    const normalizedTarget = normalizeArtistName(targetName);

    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
        const normalizedCandidate = normalizeArtistName(candidate);
        const score = fuzz.ratio(normalizedTarget, normalizedCandidate);

        if (score >= threshold && score > bestScore) {
            bestScore = score;
            bestMatch = candidate;
        }
    }

    return bestMatch;
}

/**
 * Extract the primary artist from collaboration strings
 * Examples:
 *   "CHVRCHES & Robert Smith" -> "CHVRCHES"
 *   "Artist feat. Someone" -> "Artist"
 *   "Artist ft. Someone" -> "Artist"
 *   "Artist x Someone" -> "Artist"
 *   "Artist, Someone" -> "Artist"
 *
 * But preserves band names:
 *   "Earth, Wind & Fire" -> "Earth, Wind & Fire" (kept as-is)
 *   "The Naked and Famous" -> "The Naked and Famous" (kept as-is)
 *   "Of Mice & Men" -> "Of Mice & Men" (kept as-is)
 *   "Between the Buried and Me" -> "Between the Buried and Me" (kept as-is)
 */
export function extractPrimaryArtist(artistName: string): string {
    // Empty string check
    if (!artistName || artistName.trim() === '') {
        return 'Unknown Artist';
    }

    // Trim whitespace
    artistName = artistName.trim();

    // HIGH PRIORITY: These patterns almost always indicate collaborations
    // (not band names) so we always split on them
    const definiteCollaborationPatterns = [
        / feat\.? /i, // "feat." or "feat "
        / ft\.? /i, // "ft." or "ft "
        / featuring /i,
        / x /i, // "Artist x Chromeo" style collaborations
    ];

    for (const pattern of definiteCollaborationPatterns) {
        const match = artistName.split(pattern);
        if (match.length > 1) {
            return match[0].trim();
        }
    }

    // LOWER PRIORITY: These might be band names, so only split if the result
    // looks like a complete artist name (not truncated)
    const ambiguousPatterns = [
        { pattern: / \& /, name: "&" }, // "Earth, Wind & Fire" shouldn't split
        { pattern: / and /i, name: "and" }, // "The Naked and Famous" shouldn't split
        { pattern: / with /i, name: "with" },
        { pattern: /, /, name: "," },
    ];

    for (const { pattern } of ambiguousPatterns) {
        const parts = artistName.split(pattern);
        if (parts.length > 1) {
            const firstPart = parts[0].trim();
            const secondPart = parts[1].trim();
            const lastWord =
                firstPart.split(/\s+/).pop()?.toLowerCase() || "";

            // Don't split if the first part ends with common incomplete words
            // These suggest it's a band name, not a collaboration
            const incompleteEndings = ["the", "a", "an", "and", "of", ","];
            if (incompleteEndings.includes(lastWord)) {
                continue; // Skip this pattern, try the next one
            }

            // Don't split if the first part is very short (likely incomplete)
            if (firstPart.length < 4) {
                continue;
            }

            // Don't split if the second part looks like part of a band name
            // (short single word that's likely not a full artist name)
            // Examples: "Of Mice & Men" -> "Men" (1 word, 3 chars) = band name
            //           "Artist & Robert Smith" -> "Robert Smith" (2 words) = collaborator
            const secondPartWords = secondPart.split(/\s+/).length;
            if (secondPartWords < 2 && secondPart.length <= 10) {
                continue; // Second part too short, likely part of band name
            }

            // Don't split if the second part contains another separator
            // This indicates a multi-part band name like "Earth, Wind & Fire"
            if (
                secondPart.includes(" & ") ||
                / and /i.test(secondPart) ||
                secondPart.includes(", ")
            ) {
                continue; // Multi-separator band name, don't split
            }

            return firstPart;
        }
    }

    // No collaboration found, return as-is
    return artistName;
}

/**
 * Parse artist name from folder path patterns
 * Common patterns:
 *   "Artist - Album (Year) FLAC" -> "Artist"
 *   "Artist - Album" -> "Artist"
 *   "Artist.Name-Album.Name-24BIT-FLAC-2023-GROUP" -> "Artist Name"
 *
 * Returns null if no clear artist pattern is found
 */
export function parseArtistFromPath(folderName: string): string | null {
    if (!folderName || folderName.trim() === '') {
        return null;
    }

    folderName = folderName.trim();

    // Pattern 1: "Artist - Album" or "Artist - Album (Year)"
    // Match everything before " - " separator
    const dashPattern = /^([^-]+)\s*-\s*.+$/;
    const dashMatch = folderName.match(dashPattern);
    if (dashMatch && dashMatch[1]) {
        const artist = dashMatch[1].trim();
        // Validate: should be at least 2 chars and not look like a track number
        if (artist.length >= 2 && !/^\d+$/.test(artist)) {
            return artist;
        }
    }

    // Pattern 2: "Artist.Name-Album.Name-FLAC-2023" (scene release format)
    // Split on "-", first part is artist with dots, convert dots to spaces
    const scenePattern = /^([^-]+)-/;
    const sceneMatch = folderName.match(scenePattern);
    if (sceneMatch && sceneMatch[1]) {
        const artistPart = sceneMatch[1].trim();
        // Convert dots to spaces (Artist.Name -> Artist Name)
        const artist = artistPart.replace(/\./g, ' ').trim();
        // Validate: should be at least 2 chars and not all caps metadata
        if (artist.length >= 2 && !/^(FLAC|MP3|WAV|24BIT|WEB|CD)$/i.test(artist)) {
            return artist;
        }
    }

    return null;
}
