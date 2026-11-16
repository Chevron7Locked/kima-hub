/**
 * The statuses a download job can have, and the groups of them every reader asks about. Re-exported by `jobs.ts`,
 * which everything but the notification policy imports them from. They live apart so the policy, which `jobs.ts`
 * itself calls, can ask the same question without importing `jobs.ts` back.
 *
 * The groups are plain `string[]` because Prisma's `in` / `notIn` refuse a readonly one, and a row's `status` is a
 * plain string. Do not change them. To ask a question of one job, use the predicates, not a group's `includes`.
 */

/** Every status a download job can have. */
export const JOB_STATUSES = ["pending", "processing", "completed", "failed"] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** A job that has not settled: waiting to start, or running. */
export const ACTIVE_STATUSES: string[] = ["pending", "processing"];

/** A job that ended without its album: failed, or cancelled by the user (a cancel is a failure the user asked for). */
export const FAILED_STATUSES: string[] = ["failed"];

/** A settled job has left pending and processing: completed or failed. */
export const SETTLED_STATUSES: string[] = ["completed", ...FAILED_STATUSES];

/** Whether a string (a query value, say) names a job status. */
export const isJobStatus = (status: string): status is JobStatus => (JOB_STATUSES as readonly string[]).includes(status);

/** Whether a job is waiting to start or running. */
export const isActive = (status: string): boolean => ACTIVE_STATUSES.includes(status);

/** Whether a job ended without its album. */
export const isFailed = (status: string): boolean => FAILED_STATUSES.includes(status);

/** Whether a job has left pending and processing. */
export const isSettled = (status: string): boolean => SETTLED_STATUSES.includes(status);

/** Whether a job ended with its album. */
export const isCompleted = (status: string): boolean => status === "completed";
