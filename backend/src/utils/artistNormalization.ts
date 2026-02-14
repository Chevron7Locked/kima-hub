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
 * Strip diacritics/accents from a string
 * e.g., "Ólafur" → "Olafur", "Björk" → "Bjork"
 */
function stripDiacritics(str: string): string {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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
    if (name == null) return "";
    let normalized = stripDiacritics(name.trim().toLowerCase());

    // Normalize "&" to "and" (handles "Of Mice & Men" vs "Of Mice And Men")
    normalized = normalized.replace(/\s*&\s*/g, ' and ');

    // Normalize multiple spaces to single space
    normalized = normalized.replace(/\s+/g, ' ');

    return normalized.trim();
}

/**
 * Collapse all whitespace from a normalized name for secondary comparison.
 * Used to catch cases like "Dead Mau5" vs "Deadmau5" where the only
 * difference is spacing. Input should already be normalized via normalizeArtistName().
 */
export function collapseForComparison(normalizedName: string): string {
    return normalizedName.replace(/\s+/g, '');
}

/**
 * Normalize an album title for case-insensitive comparison
 * - Converts to lowercase
 * - Trims whitespace
 */
export function normalizeAlbumTitle(title: string): string {
    if (title == null) return "";
    return title.trim().toLowerCase();
}

/**
 * Strip edition/version suffixes from album titles for better search matching
 * "In A Time Lapse (Deluxe Edition)" → "In A Time Lapse"
 * "Abbey Road (2019 Remaster)" → "Abbey Road"
 * "Dark Side of the Moon [Remastered]" → "Dark Side of the Moon"
 */
export function stripAlbumEdition(title: string): string {
    // Guard against ReDoS - skip regex for excessively long inputs
    if (!title || title.length > 500) {
        return title?.trim() || "";
    }

    return title
        // Remove parenthetical edition/version markers
        .replace(
            /\s*\([^)]*(?:deluxe|remaster|expanded|anniversary|bonus|special|limited|collector|platinum|edition|version|original|soundtrack|motion picture|super deluxe|explicit|clean|mono|stereo|remix|live|acoustic|unplugged|sessions?|recording|import|japan|uk|us)\s*[^)]*\)\s*/gi,
            ""
        )
        // Remove bracketed edition markers
        .replace(
            /\s*\[[^\]]*(?:deluxe|remaster|expanded|anniversary|bonus|special|limited|collector|platinum|edition|version|original|soundtrack|motion picture|super deluxe|explicit|clean|mono|stereo|remix|live|acoustic|unplugged|sessions?|recording|import|japan|uk|us)\s*[^\]]*\]\s*/gi,
            ""
        )
        // Remove trailing dash content with edition keywords
        .replace(
            /\s*[-–—:]\s*(?:\d{4}\s+)?(?:deluxe|remaster|expanded|anniversary|bonus|special|limited|collector|platinum|edition|version|original|mono|stereo|remix|live|acoustic).*$/gi,
            ""
        )
        // Remove trailing year in parentheses (often indicates remaster year)
        .replace(/\s*\(\d{4}\)\s*$/, "")
        // Clean up any double spaces or trailing whitespace
        .replace(/\s+/g, " ")
        .trim();
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
    if (name1 == null || name2 == null) return false;
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
        { pattern: / x /i, name: "x" }, // "Artist x Chromeo" - applies same heuristics as & and "and"
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

/**
 * Extract artist name from a relative file path by trying multiple strategies:
 * 1. parseArtistFromPath on the album folder name (catches "Artist - Album" patterns)
 * 2. Grandparent folder name (catches standard Artist/Album/Track.ext layout)
 * 3. Filename parsing (catches "Artist - Album - Track - Title.ext" naming)
 *
 * Returns null if no artist can be determined.
 */
export function extractArtistFromRelativePath(relativePath: string): string | null {
    if (!relativePath) return null;

    const parts = relativePath.split('/');
    if (parts.length < 2) return null;

    const albumFolder = parts[parts.length - 2];
    const fileName = parts[parts.length - 1];

    // Strategy 1: Parse "Artist - Album" from album folder name
    const fromAlbumFolder = parseArtistFromPath(albumFolder);
    if (fromAlbumFolder) return fromAlbumFolder;

    // Strategy 2: Grandparent folder = artist (standard Artist/Album/Track layout)
    if (parts.length >= 3) {
        const grandparent = parts[parts.length - 3];
        const genericFolders = ['music', 'songs', 'audio', 'media', 'downloads', 'library'];
        if (grandparent && !genericFolders.includes(grandparent.toLowerCase())) {
            return grandparent;
        }
    }

    // Strategy 3: Parse "Artist - Album - Track - Title.ext" from filename
    const baseName = fileName.replace(/\.[^.]+$/, '');
    const dashSegments = baseName.split(/\s+-\s+/);
    if (dashSegments.length >= 3) {
        const artist = dashSegments[0].trim();
        if (artist.length >= 2 && !/^\d+$/.test(artist)) {
            return artist;
        }
    }

    return null;
}
