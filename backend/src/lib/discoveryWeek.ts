import { startOfWeek, endOfWeek, addWeeks, isSameDay, isBefore, format } from "date-fns";

/** date-fns weekStartsOn: 0=Sun..6=Sat. Discovery defaults to 1 (Monday). */
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The week a generation run belongs to: the one the user is about to enter.
 * A run on the last day of a week rolls forward to the next, the week
 * GET /current looks for next morning. Weeks start at midnight in the
 * server's time zone (TZ).
 */
export function resolveGenerationWeekStart(now: Date, weekStartsOn: WeekStartsOn = 1): Date {
  const currentWeekStart = startOfWeek(now, { weekStartsOn });
  const currentWeekEnd = endOfWeek(now, { weekStartsOn });
  if (isSameDay(now, currentWeekEnd)) {
    return addWeeks(currentWeekStart, 1);
  }
  return currentWeekStart;
}

export interface ViewWeek {
  weekStart: Date;
  /** True when the displayed content is not from the current calendar week. */
  stale: boolean;
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
    return { weekStart: calendarWeekStart, stale: false };
  }
  // Stale only if the batch is strictly before the current calendar week.
  // Same week or a future (early-generated) week counts as fresh.
  const stale = isBefore(latestBatchWeekStart, calendarWeekStart);
  return { weekStart: latestBatchWeekStart, stale };
}

/**
 * Stable YYYY-MM-DD key for BullMQ jobId dedup: the week's first day on the
 * server's calendar, the same calendar startOfWeek used. The UTC date of a
 * local midnight is the day before anywhere east of UTC.
 */
export function weekStartKey(weekStart: Date): string {
  return format(weekStart, "yyyy-MM-dd");
}
