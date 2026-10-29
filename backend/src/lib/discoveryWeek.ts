import { startOfWeek, endOfWeek, addWeeks, addHours, isSameDay, isBefore, format } from "date-fns";

/** Discover's weeks start on Monday (date-fns weekStartsOn). */
export const WEEK_STARTS_ON = 1 as const;

/**
 * The week a generation run belongs to: the one the user is about to enter.
 * A run on the last day of a week rolls forward to the next, the week
 * GET /current looks for next morning. Weeks start at midnight in the
 * server's time zone (TZ).
 */
export function resolveGenerationWeekStart(now: Date): Date {
  const currentWeekStart = startOfWeek(now, { weekStartsOn: WEEK_STARTS_ON });
  const currentWeekEnd = endOfWeek(now, { weekStartsOn: WEEK_STARTS_ON });
  if (isSameDay(now, currentWeekEnd)) {
    return addWeeks(currentWeekStart, 1);
  }
  return currentWeekStart;
}

export interface ViewWeek {
  /** The batch's stored week start, which its albums are keyed by. */
  weekStart: Date;
  /** Midnight starting the server's local week the batch belongs to. */
  weekOf: Date;
  /** True when the displayed content is not from the current calendar week. */
  stale: boolean;
}

/**
 * A stored week start is midnight starting a week in whatever zone the server
 * ran in when it made the batch (UTC while the image forced it), at most 26
 * hours (UTC+14 to UTC-12) from the same midnight here. Weeks are 168 hours
 * apart, so half a week forward always lands inside the batch's own week.
 */
const HALF_WEEK_HOURS = 84;

/** The local week a stored week start belongs to, whichever zone made it. */
export function localWeekOf(storedWeekStart: Date): Date {
  return startOfWeek(addHours(storedWeekStart, HALF_WEEK_HOURS), { weekStartsOn: WEEK_STARTS_ON });
}

/**
 * The week GET /current shows: always the latest completed batch, whose albums
 * cleanup never deletes. `stale` when it is older than the current calendar
 * week; a batch generated early for next week counts as fresh.
 */
export function resolveViewWeek(
  calendarWeekStart: Date,
  latestBatchWeekStart: Date | null
): ViewWeek {
  if (!latestBatchWeekStart) {
    return { weekStart: calendarWeekStart, weekOf: calendarWeekStart, stale: false };
  }
  const weekOf = localWeekOf(latestBatchWeekStart);
  // Same week or a future (early-generated) week counts as fresh.
  return { weekStart: latestBatchWeekStart, weekOf, stale: isBefore(weekOf, calendarWeekStart) };
}

/**
 * Stable YYYY-MM-DD key for BullMQ jobId dedup: the week's first day on the
 * server's calendar, the same calendar startOfWeek used. The UTC date of a
 * local midnight is the day before anywhere east of UTC.
 */
export function weekStartKey(weekStart: Date): string {
  return format(weekStart, "yyyy-MM-dd");
}

/**
 * A week boundary for API responses: ISO 8601 with the server's own offset, so
 * its first ten characters are the server's calendar date, which the iPhone app
 * shows, and it still parses to the exact instant. On a UTC server it is the
 * text toISOString gives.
 */
export function weekBoundaryIso(date: Date): string {
  return format(date, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
}
