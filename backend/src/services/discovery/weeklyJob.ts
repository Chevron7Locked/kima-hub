/**
 * Queuing a user's Discover Weekly job: the one place the cron and the generate route do it.
 *
 * The job id is the user and the generation week, so the queue ignores a second add. A job that already finished this
 * week (a generation run earlier in it, or one that failed) is put back to waiting by `retry`, which moves it in one
 * step. It is never removed first: with remove then add, a failure between the two left the week with no job.
 * Callers hold the `discover:generate:<userId>` lock and pass its signal; past a lost lock nothing is touched.
 */
import { discoverQueue } from "../../workers/queues";
import { resolveGenerationWeekStart, weekStartKey } from "../../lib/discoveryWeek";

export const weeklyJobId = (userId: string, now = new Date()) =>
    `discover-weekly-${userId}-${weekStartKey(resolveGenerationWeekStart(now))}`;

/** Queues (or re-queues) the user's job for this generation week and answers its id. */
export async function queueWeeklyJob(userId: string, signal?: AbortSignal): Promise<string | undefined> {
    const jobId = weeklyJobId(userId);
    const existing = await discoverQueue.getJob(jobId);
    if (existing) {
        const state = await existing.getState();
        if (state === "completed" || state === "failed") {
            // The state seen above is only good while the lock is: past a lost one another request may have queued.
            signal?.throwIfAborted();
            await existing.retry(state, { resetAttemptsMade: true, resetAttemptsStarted: true });
            return existing.id;
        }
    }
    signal?.throwIfAborted();
    // A job still waiting or running is answered as it is: the queue ignores the add.
    const job = await discoverQueue.add("discover-weekly", { userId }, { jobId });
    return job.id;
}
