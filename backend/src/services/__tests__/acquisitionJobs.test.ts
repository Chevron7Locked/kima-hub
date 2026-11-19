/**
 * Acquisition settles its download job through the download-job module: a Soulseek album that downloads completes
 * its job with the track counts, one that falls short or finds nothing fails it with the reason, a Lidarr album that
 * will not start fails it, each with the failure marks, and a Discover batch the job belongs to is told. A job another
 * path settled first is left as it is. Real database; Soulseek, Lidarr and MusicBrainz are stubbed.
 */
jest.mock("../soulseek", () => ({
    soulseekService: { searchAndDownloadAlbum: jest.fn(), isAvailable: jest.fn() },
}));
jest.mock("../simpleDownloadManager", () => ({ simpleDownloadManager: { startDownload: jest.fn() } }));

import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { soulseekService } from "../soulseek";
import { simpleDownloadManager } from "../simpleDownloadManager";
import * as downloadJobs from "../downloads/jobs";
import { connectJobOwners } from "../downloads/owners";
import { acquisitionService } from "../acquisitionService";
import { distributedLock } from "../../utils/distributedLock";
import { LockHeldError, LockUnavailableError } from "../../utils/lockErrors";

jest.setTimeout(30_000);

const USER = "acquisition_jobs_user";
const search = soulseekService.searchAndDownloadAlbum as unknown as jest.Mock;
const startDownload = simpleDownloadManager.startDownload as unknown as jest.Mock;
const TRACKS = [{ title: "One" }, { title: "Two" }, { title: "Three" }, { title: "Four" }];
const REQUEST = { artistName: "Brad Sucks", albumTitle: "Guess Who's a Mess", mbid: "d0484284-1ee7-4157-951a-50f003cbcfb4", requestedTracks: TRACKS };

const soulseek = (job: { id: string }) =>
    (acquisitionService as any).acquireAlbumViaSoulseek(REQUEST, { userId: USER, existingJobId: job.id });
const lidarr = (job: { id: string }) =>
    (acquisitionService as any).acquireAlbumViaLidarr(REQUEST, { userId: USER, existingJobId: job.id });

const newJob = (status = "pending", extra: Record<string, unknown> = {}) =>
    prisma.downloadJob.create({
        data: {
            userId: USER, type: "album", status, subject: "Brad Sucks - Guess Who's a Mess",
            metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who's a Mess", downloadType: "discovery" },
            ...extra,
        },
    });
const read = (id: string) => prisma.downloadJob.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
    connectJobOwners();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

beforeEach(() => {
    search.mockReset();
    startDownload.mockReset();
});

describe("a Soulseek album", () => {
    it("completes its job with the track counts, and keeps the metadata it had", async () => {
        search.mockResolvedValue({ successful: 3 });
        const job = await newJob();

        const result = await soulseek(job);

        expect(result).toMatchObject({ success: true, tracksDownloaded: 3, tracksTotal: 4 });
        const row = await read(job.id);
        expect(row).toMatchObject({ status: "completed", error: null });
        expect(row.completedAt).not.toBeNull();
        expect(row.metadata).toMatchObject({
            artistName: "Brad Sucks", currentSource: "soulseek", soulseekAttempts: 1, statusText: "Soulseek #1",
            tracksDownloaded: 3, tracksTotal: 4,
        });
    });

    it("fails its job when too few tracks come, with the counts", async () => {
        search.mockResolvedValue({ successful: 1 });
        const job = await newJob();

        const result = await soulseek(job);

        expect(result).toMatchObject({ success: false, error: "Only 1/4 tracks found" });
        const row = await read(job.id);
        expect(row).toMatchObject({ status: "failed", error: "Only 1/4 tracks found" });
        expect(row.metadata).toMatchObject({ statusText: "Only 1/4 tracks found", tracksDownloaded: 1, tracksTotal: 4 });
        expect(row.metadata).toHaveProperty("failedAt");
    });

    it("fails its job when Soulseek finds nothing, or throws", async () => {
        search.mockResolvedValueOnce({ successful: 0 }).mockRejectedValueOnce(new Error("slskd is down"));
        const none = await newJob();
        const broken = await newJob();

        await soulseek(none);
        await soulseek(broken);

        expect(await read(none.id)).toMatchObject({ status: "failed", error: "No tracks found on Soulseek (searched 4 tracks)" });
        expect((await read(none.id)).metadata).toHaveProperty("failedAt");
        expect(await read(broken.id)).toMatchObject({ status: "failed", error: "slskd is down" });
        expect((await read(broken.id)).metadata).toHaveProperty("failedAt");
    });

    it("tells the Discover batch its job belongs to, so the batch moves on", async () => {
        search.mockResolvedValue({ successful: 4 });
        const batch = await prisma.discoveryBatch.create({
            data: {
                userId: USER, weekStart: new Date("2026-08-03T00:00:00.000Z"), targetSongCount: 1, totalAlbums: 1,
                status: "downloading",
            },
        });
        const job = await newJob("pending", { discoveryBatchId: batch.id });

        await soulseek(job);
        await downloadJobs.whenIdle();

        expect(await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
            status: "scanning", completedAlbums: 1,
        });
    });

    it("leaves a job another path settled first as it is", async () => {
        search.mockResolvedValue({ successful: 4 });
        const job = await newJob("processing");
        await downloadJobs.cancel([job]);

        await soulseek(job);

        expect(await read(job.id)).toMatchObject({ status: "failed", error: "Cancelled by user" });
        expect((await read(job.id)).metadata).toMatchObject({ cancelled: true });
    });
});

describe("a Lidarr album", () => {
    it("fails its job when Lidarr will not start the download, with the failure marks", async () => {
        startDownload.mockResolvedValue({ success: false, error: "Lidarr has no such album" });
        const job = await newJob();

        const result = await lidarr(job);

        expect(result).toMatchObject({ success: false, error: "Lidarr has no such album" });
        const row = await read(job.id);
        expect(row).toMatchObject({ status: "failed", error: "Lidarr has no such album" });
        expect(row.metadata).toMatchObject({ currentSource: "lidarr", lidarrAttempts: 1, statusText: "Lidarr has no such album" });
        expect(row.metadata).toHaveProperty("failedAt");
    });

    it("fails its job, not completes it, when Lidarr's reason is an empty string", async () => {
        startDownload.mockResolvedValue({ success: false, error: "" });
        const job = await newJob();

        await lidarr(job);

        expect(await read(job.id)).toMatchObject({ status: "failed" });
    });

    it("fails its job when starting throws, and does not move back a job that was settled meanwhile", async () => {
        startDownload.mockRejectedValueOnce(new Error("socket hang up"));
        const job = await newJob();
        await lidarr(job);
        expect(await read(job.id)).toMatchObject({ status: "failed", error: "socket hang up" });

        startDownload.mockResolvedValueOnce({ success: false, error: "too late" });
        const settled = await newJob("processing");
        await downloadJobs.complete([settled]);
        await lidarr(settled);
        expect(await read(settled.id)).toMatchObject({ status: "completed", error: null });
    });

    it("keeps what a webhook wrote to the job's metadata while the attempt was recorded", async () => {
        startDownload.mockResolvedValue({ success: true, correlationId: "corr-1" });
        const job = await newJob("processing", {
            metadata: { downloadType: "library", webhookNote: "kept", lidarrAttempts: 2 },
        });

        await lidarr(job);

        expect((await read(job.id)).metadata).toMatchObject({ webhookNote: "kept", lidarrAttempts: 3, statusText: "Lidarr #3" });
    });
});

describe("finding a job for an album by name, under a lock", () => {
    const BY_NAME = { artistName: "Zz Lock Artist", albumTitle: "Zz Lock Album" };
    const find = () => acquisitionService.findOrCreateDownloadJob(BY_NAME, { userId: USER });
    afterEach(async () => {
        jest.restoreAllMocks();
        await prisma.downloadJob.deleteMany({ where: { userId: USER, subject: "Zz Lock Artist - Zz Lock Album" } });
    });

    const holder = async () => {
        const held = await distributedLock.acquire(`download-job:${USER}:${BY_NAME.artistName}::${BY_NAME.albumTitle}:null`, 5000);
        if (held.outcome !== "acquired") throw new Error("expected the lock");
        return held.lease;
    };

    it("answers with the job of the request that holds the lock, once that request has made it", async () => {
        const lease = await holder();
        try {
            const asking = find();
            await new Promise((resolve) => setTimeout(resolve, 300));
            const made = await prisma.downloadJob.create({
                data: { userId: USER, type: "album", status: "pending", subject: "Zz Lock Artist - Zz Lock Album", metadata: {} },
            });

            expect(await asking).toMatchObject({ created: false, job: { id: made.id } });
        } finally {
            await lease.release();
        }
    });

    it("throws LockHeldError, making no job, only when the holder's job never appears", async () => {
        const lease = await holder();
        try {
            await expect(find()).rejects.toBeInstanceOf(LockHeldError);
            expect(await prisma.downloadJob.count({ where: { userId: USER, subject: "Zz Lock Artist - Zz Lock Album" } })).toBe(0);
        } finally {
            await lease.release();
        }
    });

    it("still makes the job, once, when Redis is down and there is no lock to take", async () => {
        jest.spyOn(distributedLock, "withLock").mockRejectedValue(new LockUnavailableError("download-job"));

        const first = await find();
        const second = await find();

        expect(first.created).toBe(true);
        expect(second).toMatchObject({ created: false, job: { id: first.job.id } });
    });
});

describe("finding a job for an album, on the active-album index's own key", () => {
    const MBID = "a0c10000-1111-2222-3333-444455556666";
    const find = () =>
        acquisitionService.findOrCreateDownloadJob({ artistName: "Brad Sucks", albumTitle: "Guess Who's a Mess", mbid: MBID }, { userId: USER });
    afterEach(async () => {
        await prisma.downloadJob.deleteMany({ where: { userId: USER, targetMbid: MBID } });
    });

    it("takes a running job of the album even when the listener dismissed it from the list", async () => {
        const running = await newJob("processing", { targetMbid: MBID, cleared: true });

        const found = await find();

        expect(found).toMatchObject({ created: false, job: { id: running.id } });
    });

    it("makes an album job beside a track job that shares the target", async () => {
        const track = await newJob("processing", { targetMbid: MBID, type: "track" });

        const found = await find();

        expect(found.created).toBe(true);
        expect(found.job.id).not.toBe(track.id);
        expect(found.job.type).toBe("album");
    });
});
