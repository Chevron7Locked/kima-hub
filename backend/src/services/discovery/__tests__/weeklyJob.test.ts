/**
 * Queuing a user's Discover Weekly job. The job id is the user and the generation week, so a second add is ignored by
 * the queue; a job that already finished this week is put back to waiting in one step, never removed first, so a failure
 * between the two steps cannot leave the week with no job. Real BullMQ queue on the suite's Redis, no worker running.
 */
import { Worker } from "bullmq";
import { discoverQueue } from "../../../workers/queues";
import { queueConnection } from "../../../workers/queueConnection";
import { closeQueue } from "../../../__tests__/helpers/closeQueue";
import { redisClient } from "../../../utils/redis";
import { closeClient } from "../../../utils/closeRedisClient";
import { queueWeeklyJob, weeklyJobId } from "../weeklyJob";

const USER = "zz-weeklyJob-user";
const jobId = weeklyJobId(USER);
const TOKEN = "weekly-job-test";

// Takes jobs off the queue by hand, as a worker would, without processing any.
let worker: Worker;

beforeAll(async () => {
    worker = new Worker("discover-weekly-v2", async () => undefined, { connection: queueConnection(), autorun: false });
    await worker.waitUntilReady();
});

afterAll(async () => {
    await worker.close();
    await closeQueue(discoverQueue);
    await closeClient(redisClient);
});

async function clear() {
    const job = await discoverQueue.getJob(jobId);
    if (job) await job.remove().catch(() => undefined);
}
beforeEach(clear);
afterEach(clear);

/** A job for this week's id, run by hand to `state` ("completed" or "failed"). */
async function finishedJob(state: "completed" | "failed") {
    const job = await discoverQueue.add("discover-weekly", { userId: USER }, { jobId, attempts: 1 });
    const taken = await worker.getNextJob(TOKEN);
    expect(taken?.id).toBe(job.id);
    if (state === "completed") await taken!.moveToCompleted({}, TOKEN, false);
    else await taken!.moveToFailed(new Error("boom"), TOKEN, false);
    expect(await job.getState()).toBe(state);
    return job;
}

it("adds the job under the user's week id when there is none", async () => {
    const id = await queueWeeklyJob(USER);

    expect(id).toBe(jobId);
    expect(jobId).toMatch(/^discover-weekly-zz-weeklyJob-user-\d{4}-\d{2}-\d{2}$/);
    expect(await (await discoverQueue.getJob(jobId))!.getState()).toBe("waiting");
    expect((await discoverQueue.getJob(jobId))!.data).toEqual({ userId: USER });
});

it.each(["completed", "failed"] as const)("puts a %s job of this week back to waiting, with its attempts reset, and never removes it", async (state) => {
    const finished = await finishedJob(state);
    const remove = jest.spyOn(finished.constructor.prototype, "remove");

    const id = await queueWeeklyJob(USER);

    expect(id).toBe(jobId);
    const again = await discoverQueue.getJob(jobId);
    expect(again).not.toBeNull();
    expect(await again!.getState()).toBe("waiting");
    expect(again!.attemptsMade).toBe(0);
    expect(again!.data).toEqual({ userId: USER });
    expect(remove).not.toHaveBeenCalled();
    remove.mockRestore();
});

it("leaves the finished job in place when putting it back fails, so the week still has its job", async () => {
    const finished = await finishedJob("completed");
    jest.spyOn(finished.constructor.prototype, "retry").mockRejectedValueOnce(new Error("redis down"));

    await expect(queueWeeklyJob(USER)).rejects.toThrow("redis down");

    expect(await discoverQueue.getJob(jobId)).not.toBeNull();
    jest.restoreAllMocks();
});

it("leaves a job that is waiting alone", async () => {
    await discoverQueue.add("discover-weekly", { userId: USER }, { jobId });

    await queueWeeklyJob(USER);

    expect(await (await discoverQueue.getJob(jobId))!.getState()).toBe("waiting");
    expect(await discoverQueue.getJobCountByTypes("waiting")).toBeGreaterThanOrEqual(1);
});

it("changes nothing when the lock it runs under was lost before the job was touched", async () => {
    const finished = await finishedJob("completed");
    const lost = new AbortController();
    lost.abort(new Error("lock lost"));

    await expect(queueWeeklyJob(USER, lost.signal)).rejects.toThrow("lock lost");

    expect(await finished.getState()).toBe("completed");
});

it("adds nothing when the lock it runs under was lost before the add", async () => {
    const lost = new AbortController();
    lost.abort(new Error("lock lost"));

    await expect(queueWeeklyJob(USER, lost.signal)).rejects.toThrow("lock lost");

    expect(await discoverQueue.getJob(jobId)).toBeUndefined();
});
