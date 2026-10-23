/**
 * Year filters. Precedence: displayYear (user override), then originalYear
 * (MusicBrainz first release), then year (file tags, may be a remaster).
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
 * Build Prisma where clause for filtering albums by decade, with the same
 * precedence as getEffectiveYear: displayYear, then originalYear, then year.
 */
export function getEffectiveDecadeWhereClause(decade: number) {
    const inDecade = { gte: decade, lt: decade + 10 };
    return {
        OR: [
            { displayYear: inDecade },
            { displayYear: null, originalYear: inDecade },
            { displayYear: null, originalYear: null, year: inDecade },
        ],
    };
}

/**
 * Get decade from a year (e.g., 1987 -> 1980, 2023 -> 2020)
 */
export function getDecadeFromYear(year: number): number {
    return Math.floor(year / 10) * 10;
}
