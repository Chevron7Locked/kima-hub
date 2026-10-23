/**
 * Metadata Override Utilities
 *
 * Helper functions for working with user metadata overrides.
 * Implements the pattern: display = userOverride ?? canonical
 */

/**
 * Json columns can hold anything; only an array of strings (or a string
 * holding one) counts as a list of genres, everything else is an empty list.
 */
function jsonArrayOrEmpty(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((g): g is string => typeof g === "string");
    if (typeof value !== "string") return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return jsonArrayOrEmpty(parsed);
    } catch {
        return [];
    }
}

/**
 * Get merged genres (user + canonical) for functional use in mixes/discovery
 * User-added genres take precedence and are merged with canonical genres
 *
 * CRITICAL: This is used for mix generation, discovery, and genre filtering.
 * User genres always take precedence.
 */
export function getMergedGenres(entity: {
    genres?: unknown;
    userGenres?: unknown;
}): string[] {
    const canonical = jsonArrayOrEmpty(entity.genres);
    const userAdded = jsonArrayOrEmpty(entity.userGenres);

    // Merge and deduplicate (user genres first for priority)
    const merged = [...new Set([...userAdded, ...canonical])];
    return merged;
}

/**
 * Get display summary for an artist
 * User override takes precedence over canonical summary
 */
export function getArtistDisplaySummary(artist: {
    userSummary?: string | null;
    summary?: string | null;
}): string | null {
    return artist.userSummary ?? artist.summary ?? null;
}
