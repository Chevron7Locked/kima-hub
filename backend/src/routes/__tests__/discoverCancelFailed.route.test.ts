/**
 * DELETE /discover/batch marks the cancelled batch failed with completedAt and a
 * message, so the completed-only lookup behind /current skips it. Real database
 * and router; the Bull queues are stood in for, since nothing here is queued.
 */

// Sign-in is passed through; the app below sets the user.
jest.mock("../../middleware/auth", () => ({
    ...jest.requireActual("../../middleware/auth"),
    requireAuthOrToken: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    requireAcquirePermission: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../workers/queues", () => require("./helpers/discoverMocks").discoverQueuesMock());

import express from "express";
import request from "supertest";
import { addWeeks, startOfWeek } from "date-fns";
import discoverRoutes from "../discover";
import { prisma } from "../../utils/db";
import { WEEK_STARTS_ON } from "../../lib/discoveryWeek";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import * as downloadJobs from "../../services/downloads/jobs";

const MARK = "zz-cancel";
let listener: string;

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
    req.user = { id: listener, username: `${MARK}-listener`, role: "user" };
    next();
});
app.use("/discover", discoverRoutes);

const THIS_WEEK = startOfWeek(new Date(), { weekStartsOn: WEEK_STARTS_ON });
const LAST_WEEK = addWeeks(THIS_WEEK, -1);

async function cleanup() {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
}

beforeAll(cleanup);
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    // The router pulls in services/listenBrainz, which opens the shared Redis
    // client at import. Left open, Jest finishes the suite and outlives the
    // process on that socket.
    await closeClient(redisClient);
});

beforeEach(async () => {
    await cleanup();
    listener = (await prisma.user.create({ data: { username: `${MARK}-listener`, passwordHash: "x" } })).id;
});

describe("DELETE /discover/batch -- cancel marks the batch failed, not completed", () => {
    it("writes a cancelled active batch as failed with completedAt and an error message", async () => {
        const before = Date.now();
        const stuck = await prisma.discoveryBatch.create({
            data: { userId: listener, weekStart: THIS_WEEK, targetSongCount: 5, status: "downloading" },
        });

        const res = await request(app).delete("/discover/batch");

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.batchesCancelled).toBe(1);
        expect(res.body.batchIds).toEqual([stuck.id]);

        // "completed" would make /current read the cancelled batch as a real, empty week.
        const batch = await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: stuck.id } });
        expect(batch.status).toBe("failed");
        expect(batch.errorMessage).toBe("Cancelled by user");
        // completedAt marks the batch terminal, so terminal lookups still find it.
        expect(batch.completedAt).toBeInstanceOf(Date);
        expect(batch.completedAt!.getTime()).toBeGreaterThanOrEqual(before);
        expect(batch.completedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("fails the batch's unfinished downloads and leaves the finished ones", async () => {
        const stuck = await prisma.discoveryBatch.create({
            data: { userId: listener, weekStart: THIS_WEEK, targetSongCount: 5, status: "downloading" },
        });
        const job = (status: string, mbid: string) =>
            prisma.downloadJob.create({
                data: { userId: listener, subject: `${MARK} ${mbid}`, type: "album", status, targetMbid: `${MARK}-${mbid}`, discoveryBatchId: stuck.id },
            });
        await job("pending", "pending");
        await job("processing", "processing");
        await job("completed", "done");

        const res = await request(app).delete("/discover/batch").expect(200);

        expect(res.body.downloadJobsCancelled).toBe(2);
        const jobs = await prisma.downloadJob.findMany({ where: { discoveryBatchId: stuck.id } });
        const byMbid = Object.fromEntries(jobs.map((j) => [j.targetMbid, j]));
        expect(byMbid[`${MARK}-pending`]).toMatchObject({ status: "failed", error: "Cancelled by user" });
        expect(byMbid[`${MARK}-processing`]).toMatchObject({ status: "failed", error: "Cancelled by user", metadata: { cancelled: true } });
        expect(byMbid[`${MARK}-done`]).toMatchObject({ status: "completed", error: null });
    });

    it("cancels the jobs through the download-job module without finishing the batch it is cancelling", async () => {
        const stuck = await prisma.discoveryBatch.create({
            data: { userId: listener, weekStart: THIS_WEEK, targetSongCount: 5, status: "downloading" },
        });
        await prisma.downloadJob.create({
            data: { userId: listener, subject: `${MARK} one`, type: "album", status: "processing", targetMbid: `${MARK}-one`, discoveryBatchId: stuck.id },
        });
        const cancel = jest.spyOn(downloadJobs, "cancel");
        const { discoverWeeklyService } = await import("../../services/discoverWeekly");
        const check = jest.spyOn(discoverWeeklyService, "checkBatchCompletion");

        await request(app).delete("/discover/batch").expect(200);

        expect(cancel).toHaveBeenCalledTimes(1);
        // The batch is already failed when the module tells it, so its completion flow stands down.
        expect(check).toHaveBeenCalledWith(stuck.id);
        const batch = await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: stuck.id } });
        expect(batch).toMatchObject({ status: "failed", errorMessage: "Cancelled by user" });
        expect(await prisma.playlist.count({ where: { userId: listener } })).toBe(0);
        cancel.mockRestore();
        check.mockRestore();
    });

    it("keeps a cancelled batch out of the completed-only lookup behind /current", async () => {
        // The listener's last completed batch is last week's. The batch cancelled now is newer, so
        // had cancelling marked it completed, /current would show its (empty) week instead.
        await prisma.discoveryBatch.create({
            data: { userId: listener, weekStart: LAST_WEEK, targetSongCount: 5, status: "completed", completedAt: new Date(), createdAt: addWeeks(new Date(), -1) },
        });
        await prisma.discoveryBatch.create({
            data: { userId: listener, weekStart: THIS_WEEK, targetSongCount: 5, status: "downloading" },
        });

        await request(app).delete("/discover/batch").expect(200);
        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        expect(new Date(res.body.weekStart).getTime()).toBe(LAST_WEEK.getTime());
        expect(res.body.stale).toBe(true);
    });

    it("falls back to the calendar week when the only batch was cancelled", async () => {
        await prisma.discoveryBatch.create({
            data: { userId: listener, weekStart: LAST_WEEK, targetSongCount: 5, status: "downloading" },
        });

        await request(app).delete("/discover/batch").expect(200);
        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        expect(new Date(res.body.weekStart).getTime()).toBe(THIS_WEEK.getTime());
        expect(res.body.stale).toBe(false);
    });
});
