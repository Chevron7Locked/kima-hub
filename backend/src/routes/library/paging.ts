const MAX_LIMIT = 10000;

/** A page size from a query value: `fallback` when absent or not a number, at least 1, never above 10000. A negative value would make Prisma read from the end of the set, so it is clamped. */
export function parseLimit(raw: unknown, fallback: number): number {
  return Math.max(1, Math.min(parseInt(raw as string, 10) || fallback, MAX_LIMIT));
}

/** Where a page starts from a query value: 0 when absent, not a number or negative (the database refuses a negative one). */
export function parseOffset(raw: unknown): number {
  return Math.max(0, parseInt(raw as string, 10) || 0);
}
