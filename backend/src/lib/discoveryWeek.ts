import { startOfWeek, endOfWeek, addWeeks, isSameDay, isBefore } from "date-fns";

/** date-fns weekStartsOn: 0=Sun..6=Sat. Discovery defaults to 1 (Monday). */
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * The week a generation run belongs to. Generation produces "the playlist
 * waiting for the user" at the start of their week. When the run fires on the
 * LAST calendar day of the current week, date-fns' startOfWeek returns the week
 * that is ending; we roll forward so records are tagged with the week the user
 * is about to enter -- the week GET /current looks for next morning.
 *
 * Deterministic only under TZ=UTC (Task 1).
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
 * The week GET /current should display. Serves the latest completed batch
 * UNCONDITIONALLY -- Task 10's cleanup never deletes the latest completed week,
 * so its albums always still exist, and hiding it (rev-2's 1-week cliff) would
 * blank out a still-valid playlist. `stale` is true only when that batch is
 * older than the current calendar week, so the UI can label it "last week's
 * picks." A future-dated batch (generated early for the upcoming week) is shown
 * as fresh (not stale).
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

/** Stable YYYY-MM-DD key for BullMQ jobId dedup. */
export function weekStartKey(weekStart: Date): string {
  return weekStart.toISOString().slice(0, 10);
}
