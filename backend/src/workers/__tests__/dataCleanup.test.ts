/**
 * The cleanup cron deletes each finished kind past its own retention period.
 * Real database; rows just either side of each period are seeded, and what is left is checked.
 */

import { runDataCleanup } from "../dataCleanup";
import { prisma } from "../../utils/db";

const P = "zz-dataCleanup-";
const USER = `${P}user`;

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

async function wipe() {
    await prisma.user.deleteMany({ where: { id: USER } }); // its jobs and batches go too
    await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: P } } });
}

const job = (n: string, status: string, completedDaysAgo: number | null) =>
    prisma.downloadJob.create({
        data: {
            id: `${P}job-${n}`, userId: USER, subject: n, type: "album", status,
            completedAt: completedDaysAgo === null ? null : daysAgo(completedDaysAgo),
        },
    });

const webhook = (n: string, processed: boolean, createdDaysAgo: number) =>
    prisma.webhookEvent.create({
        data: {
            eventId: `${P}event-${n}`, source: "lidarr", eventType: "Grab", payload: {},
            processed, createdAt: daysAgo(createdDaysAgo),
        },
    });

const batch = (n: string, status: string, completedDaysAgo: number | null) =>
    prisma.discoveryBatch.create({
        data: {
            id: `${P}batch-${n}`, userId: USER, weekStart: new Date("2026-01-05T00:00:00Z"), targetSongCount: 10, status,
            completedAt: completedDaysAgo === null ? null : daysAgo(completedDaysAgo),
        },
    });

const jobsLeft = async () => (await prisma.downloadJob.findMany({ where: { userId: USER }, orderBy: { id: "asc" } })).map((j) => j.id.slice(P.length));
const eventsLeft = async () => (await prisma.webhookEvent.findMany({ where: { eventId: { startsWith: P } }, orderBy: { eventId: "asc" } })).map((e) => e.eventId.slice(P.length));
const batchesLeft = async () => (await prisma.discoveryBatch.findMany({ where: { userId: USER }, orderBy: { id: "asc" } })).map((b) => b.id.slice(P.length));

describe("Data Cleanup", () => {
    beforeAll(async () => {
        await wipe();
        await runDataCleanup(); // rows other files left past their period would skew the counts
    });
    afterAll(wipe);
    beforeEach(async () => {
        await wipe();
        await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    });

    it("should clean up old download jobs", async () => {
        await job("old-done", "completed", 31);
        await job("old-failed", "failed", 31);
        await job("recent", "completed", 29);
        await job("old-pending", "pending", null);
        await job("old-processing", "processing", null);

        const result = await runDataCleanup();

        expect(result.downloadJobs).toBe(2);
        expect(result.total).toBe(2);
        expect(await jobsLeft()).toEqual(["job-old-pending", "job-old-processing", "job-recent"]);
    });

    it("should clean up old webhook events", async () => {
        await webhook("old-done", true, 31);
        await webhook("recent", true, 29);
        await webhook("old-unprocessed", false, 31);

        const result = await runDataCleanup();

        expect(result.webhookEvents).toBe(1);
        expect(result.total).toBe(1);
        expect(await eventsLeft()).toEqual(["event-old-unprocessed", "event-recent"]);
    });

    it("should clean up old discovery batches", async () => {
        await batch("old-done", "completed", 61);
        await batch("recent", "completed", 59);
        await batch("old-failed", "failed", 61);

        const result = await runDataCleanup();

        expect(result.discoveryBatches).toBe(1);
        expect(result.total).toBe(1);
        expect(await batchesLeft()).toEqual(["batch-old-failed", "batch-recent"]);
    });

    it("should clean up all types in one run", async () => {
        await job("a", "completed", 40);
        await job("b", "failed", 40);
        await webhook("a", true, 40);
        await webhook("b", true, 40);
        await webhook("c", true, 40);
        await batch("a", "completed", 90);

        const result = await runDataCleanup();

        expect(result.downloadJobs).toBe(2);
        expect(result.webhookEvents).toBe(3);
        expect(result.discoveryBatches).toBe(1);
        expect(result.total).toBe(6);
    });

    it("should use correct retention periods", async () => {
        // Just either side of each period: jobs and webhook events 30 days, discovery batches 60.
        await job("30-in", "completed", 29.9);
        await job("30-out", "completed", 30.1);
        await webhook("30-in", true, 29.9);
        await webhook("30-out", true, 30.1);
        await batch("60-in", "completed", 59.9);
        await batch("60-out", "completed", 60.1);

        await runDataCleanup();

        expect(await jobsLeft()).toEqual(["job-30-in"]);
        expect(await eventsLeft()).toEqual(["event-30-in"]);
        expect(await batchesLeft()).toEqual(["batch-60-in"]);
    });
});
