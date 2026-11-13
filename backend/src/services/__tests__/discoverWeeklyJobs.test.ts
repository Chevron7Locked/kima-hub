/**
 * Discover Weekly settles its download jobs through the download-job module: an album that cannot be acquired, or
 * whose acquisition throws, fails its job with the failure marks; a job another path settled first is not moved back;
 * and a batch that timed out fails its waiting jobs and tells the batch, which then moves on. Real database; the
 * recommendations and the acquisition itself are stubbed.
 */
import { randomUUID } from "crypto";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { discoveryAlbumLifecycle, discoverySeeding } from "../discovery";
import { acquisitionService } from "../acquisitionService";
import * as downloadJobs from "../downloads/jobs";

jest.setTimeout(60_000);

const USER = "discover_jobs_user";
const MINUTES = 60 * 1000;

let discoverWeeklyService: typeof import("../discoverWeekly").discoverWeeklyService;

beforeAll(async () => {
    ({ discoverWeeklyService } = await import("../discoverWeekly"));
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.userDiscoverConfig.create({ data: { userId: USER, enabled: true, playlistSize: 4 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

afterEach(() => jest.restoreAllMocks());

const album = (title: string) => ({
    artistName: "Brad Sucks", albumTitle: title, albumMbid: randomUUID(), similarity: 0.8, tier: "medium" as const,
});

describe("generating the playlist", () => {
    it("fails an album that cannot be acquired and one whose acquisition throws, and leaves a settled job and a started one as they are", async () => {
        const [nothing, throws, settledFirst, started] = [album("Nothing"), album("Throws"), album("Settled first"), album("Started")];
        jest.spyOn(discoveryAlbumLifecycle, "processBeforeGeneration").mockResolvedValue(undefined as never);
        jest.spyOn(discoverySeeding, "getSeedArtists").mockResolvedValue([{ name: "Brad Sucks", mbid: null }] as never);
        jest.spyOn(discoverWeeklyService as never, "prefetchSimilarArtists").mockResolvedValue(new Map() as never);
        jest.spyOn(discoverWeeklyService as never, "findRecommendedAlbumsMultiStrategy").mockResolvedValue(
            [nothing, throws, settledFirst, started] as never
        );
        jest.spyOn(acquisitionService, "acquireAlbum").mockImplementation((async (request: { mbid: string }, context: { existingJobId: string }) => {
            const job = { id: context.existingJobId };
            if (request.mbid === nothing.albumMbid) return { success: false, error: "nothing found" };
            if (request.mbid === throws.albumMbid) throw new Error("boom");
            if (request.mbid === settledFirst.albumMbid) {
                // A webhook settled the job before acquisition came back.
                await downloadJobs.fail([job], "Lidarr said no");
                return { success: true, source: "lidarr", correlationId: "corr-1" };
            }
            await downloadJobs.start(job.id, { correlationId: "corr-2", lidarrAlbumId: 7 });
            return { success: true, source: "lidarr", correlationId: "corr-2" };
        }) as never);

        const { batchId } = await discoverWeeklyService.generatePlaylist(USER);

        const jobs = await prisma.downloadJob.findMany({ where: { discoveryBatchId: batchId } });
        const byMbid = (mbid: string) => jobs.find((j) => j.targetMbid === mbid)!;
        expect(byMbid(nothing.albumMbid)).toMatchObject({ status: "failed", error: "nothing found" });
        expect(byMbid(nothing.albumMbid).metadata).toMatchObject({ statusText: "nothing found" });
        expect(byMbid(nothing.albumMbid).metadata).toHaveProperty("failedAt");
        expect(byMbid(throws.albumMbid)).toMatchObject({ status: "failed", error: "boom" });
        expect(byMbid(throws.albumMbid).metadata).toHaveProperty("failedAt");
        expect(byMbid(settledFirst.albumMbid)).toMatchObject({ status: "failed", error: "Lidarr said no" });
        // The correlation id is not a download id: the job still waits for Lidarr's grab, which matches it.
        expect(byMbid(started.albumMbid)).toMatchObject({ status: "processing", lidarrRef: null, correlationId: "corr-2" });
        const { simpleDownloadManager } = await import("../simpleDownloadManager");
        expect(await simpleDownloadManager.onDownloadGrabbed("dl-real-1", started.albumMbid, "Started", "Brad Sucks", 7)).toEqual({
            matched: true, jobId: byMbid(started.albumMbid).id,
        });
        expect(await prisma.downloadJob.findUniqueOrThrow({ where: { id: byMbid(started.albumMbid).id } })).toMatchObject({
            status: "processing", lidarrRef: "dl-real-1",
        });
        expect((await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("downloading");
    });

    it("does not skip an album because another user's job for it is in the queue", async () => {
        const wanted = album("Someone else has it");
        const OTHER = "discover_jobs_other";
        await prisma.user.deleteMany({ where: { id: OTHER } });
        await prisma.user.create({ data: { id: OTHER, username: OTHER, passwordHash: "x", role: "user", tokenVersion: 0 } });
        await prisma.downloadJob.create({
            data: {
                userId: OTHER, type: "album", status: "pending", subject: "Brad Sucks - Someone else has it",
                targetMbid: wanted.albumMbid, metadata: { artistName: "Brad Sucks", albumTitle: wanted.albumTitle },
            },
        });
        jest.spyOn(discoveryAlbumLifecycle, "processBeforeGeneration").mockResolvedValue(undefined as never);
        jest.spyOn(discoverySeeding, "getSeedArtists").mockResolvedValue([{ name: "Brad Sucks", mbid: null }] as never);
        jest.spyOn(discoverWeeklyService as never, "prefetchSimilarArtists").mockResolvedValue(new Map() as never);
        jest.spyOn(discoverWeeklyService as never, "findRecommendedAlbumsMultiStrategy").mockResolvedValue([wanted] as never);
        jest.spyOn(acquisitionService, "acquireAlbum").mockResolvedValue({ success: false, error: "nothing found" } as never);

        try {
            const { batchId } = await discoverWeeklyService.generatePlaylist(USER);
            const mine = await prisma.downloadJob.findMany({ where: { discoveryBatchId: batchId, targetMbid: wanted.albumMbid } });
            expect(mine).toHaveLength(1);
            expect(mine[0].userId).toBe(USER);
        } finally {
            await prisma.user.deleteMany({ where: { id: OTHER } });
        }
    });
});

describe("a batch that ran too long", () => {
    const batchWith = async (ageMs: number, weekStart: string) =>
        prisma.discoveryBatch.create({
            data: {
                userId: USER, weekStart: new Date(weekStart), targetSongCount: 2, totalAlbums: 2, status: "downloading",
                createdAt: new Date(Date.now() - ageMs),
            },
        });
    const job = (batchId: string, status: string) =>
        prisma.downloadJob.create({
            data: {
                userId: USER, discoveryBatchId: batchId, type: "album", status, subject: "Brad Sucks - A Record",
                metadata: { artistName: "Brad Sucks", albumTitle: "A Record", downloadType: "discovery" },
            },
        });

    it("fails the jobs still waiting, with the failure marks, and the batch moves on with what finished", async () => {
        const batch = await batchWith(45 * MINUTES, "2026-09-07T00:00:00.000Z");
        await job(batch.id, "completed");
        const waiting = await job(batch.id, "processing");

        await discoverWeeklyService.checkStuckBatches();
        await downloadJobs.whenIdle();

        const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: waiting.id } });
        expect(row).toMatchObject({ status: "failed", error: "Batch timeout - download took too long" });
        expect(row.metadata).toHaveProperty("failedAt");
        expect(await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
            status: "scanning", completedAlbums: 1, failedAlbums: 1,
        });
    });

    it("force-fails a batch past two hours with its jobs, with the failure marks", async () => {
        const batch = await batchWith(3 * 60 * MINUTES, "2026-09-14T00:00:00.000Z");
        const waiting = await job(batch.id, "pending");

        await discoverWeeklyService.checkStuckBatches();
        await downloadJobs.whenIdle();

        const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: waiting.id } });
        expect(row).toMatchObject({ status: "failed", error: "Batch force-failed due to timeout" });
        expect(row.metadata).toHaveProperty("failedAt");
        expect((await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("failed");
    });
});
