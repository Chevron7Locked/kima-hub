/**
 * The stale-job cleanup settles download jobs through the download-job module: a stale job fails with its
 * failure marks and tells the Discover batch it belongs to, so a batch that was waiting on it can finish.
 * Real database.
 */
import { prisma } from "../../utils/db";
import { staleJobCleanupService } from "../staleJobCleanup";
import * as downloadJobs from "../downloads/jobs";
import { connectJobOwners } from "../downloads/owners";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(30_000);

const USER = "stale_jobs_user";
const HOURS = 60 * 60 * 1000;

beforeAll(async () => {
    connectJobOwners();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

const job = (status: string, ageMs: number, extra: Record<string, unknown> = {}) =>
    prisma.downloadJob.create({
        data: {
            userId: USER, type: "album", status, subject: "Brad Sucks - Guess Who's a Mess",
            createdAt: new Date(Date.now() - ageMs),
            metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who's a Mess", downloadType: "discovery" },
            ...extra,
        },
    });

it("fails a stale download job with its failure marks and leaves a recent one running", async () => {
    const stale = await job("processing", 3 * HOURS);
    const recent = await job("processing", 10 * 60 * 1000);

    const result = await staleJobCleanupService.cleanupAll();

    expect(result.downloadJobs.ids).toContain(stale.id);
    expect(result.downloadJobs.ids).not.toContain(recent.id);
    const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: stale.id } });
    expect(row).toMatchObject({ status: "failed", error: "Cleaned up as stale by user request" });
    expect(row.completedAt).not.toBeNull();
    expect(row.metadata).toMatchObject({ statusText: "Cleaned up as stale by user request" });
    expect(row.metadata).toHaveProperty("failedAt");
    expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: recent.id } })).status).toBe("processing");
});

it("tells the batch of a stale job, so a batch that was waiting on it moves on", async () => {
    const batch = await prisma.discoveryBatch.create({
        data: {
            userId: USER, weekStart: new Date("2026-10-12T00:00:00.000Z"), targetSongCount: 2, totalAlbums: 2,
            status: "downloading",
        },
    });
    await job("completed", 3 * HOURS, { discoveryBatchId: batch.id });
    await job("processing", 3 * HOURS, { discoveryBatchId: batch.id });

    await staleJobCleanupService.cleanupAll();
    await downloadJobs.whenIdle();

    expect(await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
        status: "scanning", completedAlbums: 1, failedAlbums: 1,
    });
});

it("fails the jobs of a stale batch with its reason and failure marks", async () => {
    const batch = await prisma.discoveryBatch.create({
        data: {
            userId: USER, weekStart: new Date("2026-10-19T00:00:00.000Z"), targetSongCount: 2, totalAlbums: 2,
            status: "downloading", createdAt: new Date(Date.now() - 2 * HOURS),
        },
    });
    const inBatch = await job("pending", 5 * 60 * 1000, { discoveryBatchId: batch.id });

    await staleJobCleanupService.cleanupAll();
    await downloadJobs.whenIdle();

    const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: inBatch.id } });
    expect(row).toMatchObject({ status: "failed", error: "Parent batch cleaned up as stale" });
    expect(row.metadata).toHaveProperty("failedAt");
    expect((await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("failed");
});
