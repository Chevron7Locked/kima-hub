/** `n` consecutive calendar dates from 2026-01-01, as YYYY-MM-DD. */
export const consecutiveDates = (n: number) =>
    Array.from({ length: n }, (_, k) => new Date(Date.UTC(2026, 0, 1 + k)).toISOString().slice(0, 10));

/** `n` dates a week apart that fall on `day` (0 = Sunday): a weekday mix exists on the day it is drawn for. */
export const datesOn = (day: number, n: number) =>
    // 2026-01-04 is a Sunday.
    Array.from({ length: n }, (_, k) => new Date(Date.UTC(2026, 0, 4 + day + 7 * k)).toISOString().slice(0, 10));
