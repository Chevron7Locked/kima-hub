/**
 * The statuses a download job can have, and the groups of them every reader asks about. Re-exported by `jobs.ts`,
 * which everything but the notification policy imports them from. They live apart so the policy, which `jobs.ts`
 * itself calls, can ask the same question without importing `jobs.ts` back.
 *
 * The arrays are plain `string[]` because Prisma's `in` / `notIn` refuse a readonly one. Do not change them.
 */

/** Every status a download job can have. */
export const JOB_STATUSES: readonly string[] = ["pending", "processing", "completed", "failed"];

/** A job that has not settled: waiting to start, or running. */
export const ACTIVE_STATUSES: string[] = ["pending", "processing"];

/** A job that ended without its album: failed, or cancelled by the user (a cancel is a failure the user asked for). */
export const FAILED_STATUSES: string[] = ["failed"];

/** A settled job has left pending and processing: completed or failed. */
export const SETTLED_STATUSES: string[] = ["completed", ...FAILED_STATUSES];
