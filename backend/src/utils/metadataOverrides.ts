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
 * Get the genres of an entity (artist, album, ...) for functional use in mixes, discovery and
 * genre filtering: the genres a person set, or the enriched ones when the person set none.
 *
 * A person's list REPLACES the enriched one — it is not added to it. The artist editor saves the
 * whole edited list, so a genre the person removed must disappear from every surface, not come
 * back from the enriched column. Both columns are read with jsonArrayOrEmpty, so anything that is
 * not a list of strings (null, an object, JSON null) counts as an empty list and falls back to the
 * enriched genres. The returned list is deduplicated, keeping the person's order.
 *
 * CRITICAL: This is used for mix generation, discovery, and genre filtering.
 * The person's genres win whenever they are a non-empty list.
 */
export function getMergedGenres(entity: {
    genres?: unknown;
    userGenres?: unknown;
}): string[] {
    const userGenres = jsonArrayOrEmpty(entity.userGenres);
    if (userGenres.length > 0) {
        // Deduplicate, keeping the person's order (indexOf-based: no Set iteration, so the
        // function compiles at every target).
        const deduped: string[] = [];
        for (const genre of userGenres) {
            if (deduped.indexOf(genre) === -1) deduped.push(genre);
        }
        return deduped;
    }
    return jsonArrayOrEmpty(entity.genres);
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
