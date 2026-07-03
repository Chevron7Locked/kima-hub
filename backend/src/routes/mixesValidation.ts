/**
 * Pure, dependency-free validation for the mood-mix save route — extracted so the
 * request-body checks are unit-testable without standing up the whole mixes router.
 */

/** Max tracks in a saved mood mix — one source of truth for the client-trackIds
 *  cap AND the mix size requested from the service. */
export const MOOD_MIX_LIMIT = 15;

/**
 * Validate the optional `trackIds` from a mood-mix save request body.
 * Returns `{ trackIds }` (undefined = "regenerate the mix") on success, or
 * `{ error }` carrying the 400 message on failure.
 */
export function validateSaveTrackIds(
    raw: unknown,
    limit: number = MOOD_MIX_LIMIT,
): { trackIds?: string[] } | { error: string } {
    if (raw === undefined) return { trackIds: undefined };
    if (!Array.isArray(raw)) return { error: "trackIds must be an array" };
    if (raw.some((id) => typeof id !== "string")) {
        return { error: "Each trackId must be a string" };
    }
    if (raw.length > limit) {
        return { error: `trackIds must not exceed ${limit} tracks` };
    }
    return { trackIds: raw as string[] };
}
