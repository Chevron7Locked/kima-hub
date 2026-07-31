import * as fuzz from "fuzzball";

/**
 * Utility functions for normalizing artist and album names
 * to handle case-sensitivity and other variations
 */

/**
 * Canonical name and MBID for compilation/various artists
 */
export const VARIOUS_ARTISTS_CANONICAL = "Various Artists";


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
 * Strip characters that PostgreSQL rejects in UTF-8 text columns.
 * Removes null bytes and ASCII control characters (C0 range) while
 * preserving all legitimate Unicode including accented chars, CJK, emoji.
 */
export function sanitizeTagString(value: string | null | undefined): string {
    if (value == null) return "";
    return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
}

/**
 * Normalize an artist name for case-insensitive comparison.
 *
 * RE-EXPORTED, not re-implemented. Two functions with this exact name and
 * different behaviour sat on opposite sides of one database column:
 * artistIdentity's WRITES Artist.normalizedName; this module's was used to
 * QUERY it from ~20 call sites, and they disagreed on the ligature fold. "MO"
 * with a slash was stored as "mo" and looked up unfolded, making such artists
 * unfindable by Spotify import and Discover Weekly seeding. One definition
 * removes the failure mode instead of keeping two in step by hand.
 */
export { normalizeArtistName } from "../services/artistIdentity";



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
 * Note: Handles both Unix (/) and Windows (\) path separators.
 * Returns null if no artist can be determined.
 */
export function extractArtistFromRelativePath(relativePath: string): string | null {
    if (!relativePath) return null;

    // Normalize path separators to forward slashes for cross-platform compatibility
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
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

/**
 * Extract album title from a relative file path.
 * Uses the immediate parent folder name, which is typically the album folder
 * in standard Artist/Album/Track.ext layouts.
 *
 * Note: Handles both Unix (/) and Windows (\) path separators.
 * Returns null if the file is at the root level (no parent folder).
 */
export function extractAlbumFromRelativePath(relativePath: string): string | null {
    if (!relativePath) return null;

    // Normalize path separators to forward slashes for cross-platform compatibility
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
    if (parts.length < 2) return null;

    const albumFolder = parts[parts.length - 2];
    return albumFolder || null;
}
