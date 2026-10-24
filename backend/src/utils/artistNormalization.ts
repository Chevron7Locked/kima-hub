
/**
 * Utility functions for normalizing artist and album names
 * to handle case-sensitivity and other variations
 */

/** Canonical name for compilation/various artists. */
export const VARIOUS_ARTISTS_CANONICAL = "Various Artists";

/** The artist the scanner files a song under when it has no artist tags and no folder artist (musicScanner.ts). */
export const UNKNOWN_ARTIST = "Unknown Artist";

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



// Words that mark another edition of the same album, matched as whole words.
const EDITION_WORD =
    /\b(?:deluxe|remaster(?:ed)?|expanded|anniversary|bonus|special|limited|collector'?s?|platinum|edition|version|original|soundtrack|motion picture|explicit|clean|mono|stereo|recording|import|japan(?:ese)?|uk|us)\b/i;
// Words that mark a different recording, which is a different album even when
// an edition word sits beside them: "(Live Edition)", "(Acoustic Version)".
const OTHER_RECORDING =
    /\b(?:live|remix(?:es|ed)?|mix|radio|acoustic|unplugged|sessions?|demos?|instrumentals?|karaoke|covers?|reworked|reimagined|orchestral|symphonic|stripped)\b/i;

function isEditionMarker(text: string): boolean {
    return EDITION_WORD.test(text) && !OTHER_RECORDING.test(text);
}

/**
 * Strip edition markers from an album title, keeping anything that names a
 * different recording:
 * "In A Time Lapse (Deluxe Edition)" -> "In A Time Lapse",
 * "Abbey Road - 2019 Remaster" -> "Abbey Road",
 * "Get Born (Live)" stays "Get Born (Live)".
 */
export function stripAlbumEdition(title: string): string {
    // Guard against ReDoS - skip regex for excessively long inputs
    if (!title || title.length > 500) {
        return title?.trim() || "";
    }

    return title
        .replace(/\s*\(([^)]*)\)\s*/g, (group, inner) => (isEditionMarker(inner) ? " " : group))
        .replace(/\s*\[([^\]]*)\]\s*/g, (group, inner) => (isEditionMarker(inner) ? " " : group))
        .replace(/\s*[-–—:]\s*((?:\d{4}\s+)?[^-–—:]*)$/, (tail, inner) =>
            /^(?:\d{4}\s+)?(?:deluxe|remaster|expanded|anniversary|bonus|special|limited|collector|platinum|edition|version|original|mono|stereo)/i.test(inner) && isEditionMarker(inner)
                ? ""
                : tail
        )
        // A trailing year in parentheses is usually a remaster's
        .replace(/\s*\(\d{4}\)\s*$/, "")
        .replace(/\s+/g, " ")
        .trim();
}


/**
 * Artist name from a folder name: "Artist - Album (Year) FLAC" -> "Artist",
 * "Artist.Name-Album.Name-24BIT-FLAC-2023-GROUP" -> "Artist Name". Null when
 * no pattern fits.
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
 * Artist from a relative path (either separator): the album folder name, then
 * the grandparent folder, then "Artist - Album - Track - Title" filenames.
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

/** Album title from a relative path (either separator): the parent folder, or null at the root. */
export function extractAlbumFromRelativePath(relativePath: string): string | null {
    if (!relativePath) return null;

    // Normalize path separators to forward slashes for cross-platform compatibility
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
    if (parts.length < 2) return null;

    const albumFolder = parts[parts.length - 2];
    return albumFolder || null;
}
