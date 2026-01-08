/**
 * Date filtering utilities for consistent year handling across the codebase.
 *
 * Year Priority Resolution:
 * 1. displayYear - User override (highest priority)
 * 2. originalYear - MusicBrainz first-release-date (authoritative)
 * 3. year - File metadata (may be remaster date)
 */

/**
 * Get the effective year for an album, respecting override hierarchy.
 */
export function getEffectiveYear(album: {
    displayYear?: number | null;
    originalYear?: number | null;
    year?: number | null;
}): number | null {
    return album.displayYear ?? album.originalYear ?? album.year ?? null;
}

/**
 * Build Prisma where clause for filtering albums by decade.
 * Uses originalYear with fallback to year for albums not yet enriched.
 */
export function getDecadeWhereClause(decade: number) {
    return {
        OR: [
            // Albums with originalYear in the target decade
            {
                originalYear: {
                    gte: decade,
                    lt: decade + 10,
                },
            },
            // Fallback: albums without originalYear, use year field
            {
                originalYear: null,
                year: {
                    gte: decade,
                    lt: decade + 10,
                },
            },
        ],
    };
}

/**
 * Get decade from a year (e.g., 1987 -> 1980, 2023 -> 2020)
 */
export function getDecadeFromYear(year: number): number {
    return Math.floor(year / 10) * 10;
}
