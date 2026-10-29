/** A person's metadata overrides: what they set wins over the enriched value. */

/**
 * Json columns can hold anything; only an array of strings (or a string
 * holding one) counts as a list of genres, everything else is an empty list.
 */
function stringArrayOrEmpty(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((g): g is string => typeof g === "string");
    if (typeof value !== "string") return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return stringArrayOrEmpty(parsed);
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
 * back from the enriched column. Both columns are read with stringArrayOrEmpty, so anything that is
 * not a list of strings (null, an object, JSON null) counts as an empty list and falls back to the
 * enriched genres. The returned list is deduplicated, keeping the person's order.
 */
export function getMergedGenres(entity: {
    genres?: unknown;
    userGenres?: unknown;
}): string[] {
    const userGenres = stringArrayOrEmpty(entity.userGenres);
    // A Set keeps the first of each, in order.
    if (userGenres.length > 0) return [...new Set(userGenres)];
    return stringArrayOrEmpty(entity.genres);
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
