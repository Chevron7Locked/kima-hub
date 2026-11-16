/**
 * POST /notifications/downloads/:id/retry starts a fresh job from a failed one and settles it
 * through the download-job module: a Soulseek success or failure completes or fails the job,
 * merging into the metadata it holds (a write that landed meanwhile survives) and telling the
 * Spotify import it belongs to. The failure marks of the old job do not follow the copy.
 * A replacement that cannot start ends failed, so the user always sees it. A retry is idempotent: a second retry of
 * the same failed job (a double-click, or a stale page) makes nothing, and a retry that finds the album already
 * downloading clears the failed job and answers with the running one. A library retry searches for the artist the job
 * names, even when the name holds " - ".
 * Real database and router; Soulseek, the download manager and the import are stood in for.
 */

jest.mock("../../middleware/auth", () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "nrt_user", role: "user" };
        next();
    },
}));
const mockSearchAndDownloadBatch = jest.fn();
jest.mock("../../services/soulseek", () => ({
    soulseekService: { searchAndDownloadBatch: (...a: unknown[]) => mockSearchAndDownloadBatch(...a) },
}));
const mockRequestScan = jest.fn();
jest.mock("../../workers/scanRequest", () => ({ requestScan: (...a: unknown[]) => mockRequestScan(...a) }));
const mockStartDownload = jest.fn();
jest.mock("../../services/simpleDownloadManager", () => ({
    simpleDownloadManager: { startDownload: (...a: unknown[]) => mockStartDownload(...a) },
}));
const mockCheckImportCompletion = jest.fn();
jest.mock("../../services/spotifyImport", () => ({
    spotifyImportService: { checkImportCompletion: (...a: unknown[]) => mockCheckImportCompletion(...a) },
}));
jest.mock("../../services/discoverWeekly", () => ({
    discoverWeeklyService: { checkBatchCompletion: jest.fn() },
}));

import express from "express";
import request from "supertest";
import notificationRoutes from "../notifications";
import { prisma } from "../../utils/db";
import { mergeMetadata, whenIdle } from "../../services/downloads/jobs";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";

const USER = "nrt_user";
const IMPORT = "nrt_import";
const MBID = "e1e10000-1111-2222-3333-444455556666";
const app = mountAsServer(express().use(express.json()), "/notifications", notificationRoutes, "/api/notifications");

const failedJob = (data: Record<string, unknown> = {}) =>
    prisma.downloadJob.create({
        data: {
            userId: USER,
            subject: "Low - Things We Lost in the Fire",
            type: "album",
            status: "failed",
            error: "earlier failure",
            targetMbid: MBID,
            metadata: {
                downloadType: "spotify_import",
                artistName: "Low",
                albumTitle: "Things We Lost in the Fire",
                spotifyImportJobId: IMPORT,
                notificationSent: true,
                failedAt: "2026-01-01T00:00:00.000Z",
                statusText: "earlier failure",
            },
            ...data,
        },
    });
const newJobOf = async (oldId: string, newJobId: string) => {
    expect(newJobId).not.toBe(oldId);
    return prisma.downloadJob.findUniqueOrThrow({ where: { id: newJobId } });
};
const meta = (j: { metadata: unknown }) => j.metadata as Record<string, any>;
async function waitFor(predicate: () => Promise<boolean>, label: string) {
    for (let i = 0; i < 300; i++) {
        if (await predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitFor timed out: ${label}`);
}
const settled = (id: string) => async () => !["pending", "processing"].includes((await prisma.downloadJob.findUniqueOrThrow({ where: { id } })).status);
// A job reads settled a moment before its import is told, so a test waits on the import's check, then lets it finish.
const importTold = async () => {
    await waitFor(async () => mockCheckImportCompletion.mock.calls.length > 0, "import told");
    await whenIdle();
};
const retry = (id: string) => request(app).post(`/notifications/downloads/${id}/retry`);

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

beforeEach(() => {
    mockSearchAndDownloadBatch.mockReset();
    mockStartDownload.mockReset();
    mockRequestScan.mockReset().mockResolvedValue({ queued: true });
    mockCheckImportCompletion.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

describe("a retried Spotify import album, tried on Soulseek first", () => {
    it("completes the new job, keeping what was written to its metadata meanwhile, and tells the import", async () => {
        const old = await failedJob();
        let startedWith: Record<string, any> = {};
        let newId = "";
        mockSearchAndDownloadBatch.mockImplementation(async () => {
            const job = await prisma.downloadJob.findFirstOrThrow({ where: { userId: USER, id: { not: old.id } } });
            newId = job.id;
            startedWith = meta(job);
            await mergeMetadata(job.id, { webhookSaw: "me" });
            return { successful: 3, failed: 0, files: ["a.flac"] };
        });

        const res = await retry(old.id);
        expect(res.body.success).toBe(true);
        await waitFor(settled(res.body.newJobId), "new job settled");

        const job = await newJobOf(old.id, res.body.newJobId);
        expect(job.status).toBe("completed");
        expect(job.error).toBeNull();
        expect(meta(job)).toMatchObject({
            spotifyImportJobId: IMPORT, artistName: "Low", retryAttempt: true,
            source: "soulseek", tracksDownloaded: 3, webhookSaw: "me",
        });
        // The old job's failure marks did not come along to the new one.
        expect(startedWith).not.toHaveProperty("failedAt");
        expect(startedWith).not.toHaveProperty("notificationSent");
        expect(newId).toBe(job.id);
        await importTold();
        expect(mockCheckImportCompletion).toHaveBeenCalledWith(IMPORT);
    });

    it("fails the new job and tells the import when Soulseek finds nothing and there is no MusicBrainz id", async () => {
        const old = await failedJob({ targetMbid: null });
        mockSearchAndDownloadBatch.mockResolvedValue({ successful: 0, failed: 1, files: [] });

        const res = await retry(old.id);
        await waitFor(settled(res.body.newJobId), "new job settled");

        const job = await newJobOf(old.id, res.body.newJobId);
        expect(job).toMatchObject({ status: "failed", error: "No tracks found on Soulseek, no MBID for Lidarr fallback" });
        expect(meta(job)).toMatchObject({ spotifyImportJobId: IMPORT, failedAt: expect.any(String) });
        await importTold();
        expect(mockCheckImportCompletion).toHaveBeenCalledWith(IMPORT);
    });

    it("fails the new job with Lidarr's reason when the fallback does not start", async () => {
        const old = await failedJob();
        mockSearchAndDownloadBatch.mockResolvedValue({ successful: 0, failed: 1, files: [] });
        mockStartDownload.mockResolvedValue({ success: false, error: "Lidarr has no such album" });

        const res = await retry(old.id);
        await waitFor(settled(res.body.newJobId), "new job settled");

        expect(await newJobOf(old.id, res.body.newJobId)).toMatchObject({ status: "failed", error: "Lidarr has no such album" });
        await importTold();
        expect(mockCheckImportCompletion).toHaveBeenCalledWith(IMPORT);
    });

    it("fails the new job with the error when Soulseek throws", async () => {
        expectLog("error");
        const old = await failedJob();
        mockSearchAndDownloadBatch.mockRejectedValue(new Error("slskd unreachable"));

        const res = await retry(old.id);
        await waitFor(settled(res.body.newJobId), "new job settled");

        expect(await newJobOf(old.id, res.body.newJobId)).toMatchObject({ status: "failed", error: "slskd unreachable" });
        await importTold();
        expect(mockCheckImportCompletion).toHaveBeenCalledWith(IMPORT);
    });
});

describe("a retried Spotify import album that Soulseek found", () => {
    it("asks for its scan before the job reads completed", async () => {
        const old = await failedJob();
        let statusWhenScanAsked = "";
        mockSearchAndDownloadBatch.mockResolvedValue({ successful: 2, failed: 0, files: ["a.flac"] });
        mockRequestScan.mockImplementation(async () => {
            statusWhenScanAsked = (await prisma.downloadJob.findFirstOrThrow({ where: { userId: USER, id: { not: old.id } } })).status;
            return { queued: true };
        });

        const res = await retry(old.id);
        await waitFor(settled(res.body.newJobId), "new job settled");

        expect(statusWhenScanAsked).toBe("processing");
        expect(mockRequestScan).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, source: "retry-spotify-import" }));
        expect((await newJobOf(old.id, res.body.newJobId)).status).toBe("completed");
        await importTold();
    });

    it("logs a scan that could not be asked for, and the job still completes", async () => {
        const logged = expectLog("error");
        const old = await failedJob();
        mockSearchAndDownloadBatch.mockResolvedValue({ successful: 2, failed: 0, files: ["a.flac"] });
        mockRequestScan.mockRejectedValue(new Error("queue is down"));

        const res = await retry(old.id);
        await waitFor(settled(res.body.newJobId), "new job settled");

        const job = await newJobOf(old.id, res.body.newJobId);
        expect(job).toMatchObject({ status: "completed", error: null });
        expect(logged).toHaveBeenCalledWith(expect.stringContaining("scan"), expect.any(Error));
        await importTold();
    });
});

describe("a retried library album", () => {
    it("starts a pending copy of the job without the old failure marks", async () => {
        const old = await failedJob({
            metadata: { downloadType: "library", albumTitle: "Things We Lost in the Fire", notificationSent: true, failedAt: "2026-01-01T00:00:00.000Z", parked: "Tracks missing", statusText: "Tracks missing" },
        });
        mockStartDownload.mockResolvedValue({ success: true });

        const res = await retry(old.id);

        expect(res.body.success).toBe(true);
        const job = await newJobOf(old.id, res.body.newJobId);
        expect(job.status).toBe("pending");
        expect(meta(job)).toEqual({ downloadType: "library", albumTitle: "Things We Lost in the Fire" });
        expect(mockStartDownload).toHaveBeenCalledWith(job.id, "Low", "Things We Lost in the Fire", MBID, false);
    });
});

describe("a retry whose replacement cannot start", () => {
    it("fails the new Spotify import job with the reason, and the old one is cleared", async () => {
        expectLog("error");
        const old = await failedJob();
        mockSearchAndDownloadBatch.mockImplementation(() => {
            throw new Error("slskd exploded");
        });

        const res = await retry(old.id).expect(200);

        expect(res.body).toMatchObject({ success: false, newJobId: expect.any(String), error: "slskd exploded" });
        const job = await newJobOf(old.id, res.body.newJobId);
        expect(job).toMatchObject({ status: "failed", error: "slskd exploded", cleared: false });
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: old.id } })).cleared).toBe(true);
        await whenIdle();
        expect(mockCheckImportCompletion).toHaveBeenCalledWith(IMPORT);
    });

    it("fails the new library job with the reason, and the old one is cleared", async () => {
        expectLog("error");
        const old = await failedJob({ metadata: { downloadType: "library", albumTitle: "Things We Lost in the Fire" } });
        mockStartDownload.mockRejectedValue(new Error("lidarr exploded"));

        const res = await retry(old.id).expect(200);

        expect(res.body).toMatchObject({ success: false, newJobId: expect.any(String), error: "lidarr exploded" });
        const job = await newJobOf(old.id, res.body.newJobId);
        expect(job).toMatchObject({ status: "failed", error: "lidarr exploded", cleared: false });
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: old.id } })).cleared).toBe(true);
    });
});

describe("a retry of a download whose album is already downloading", () => {
    const runningJob = () =>
        prisma.downloadJob.create({
            data: { userId: USER, subject: "Low - Things We Lost in the Fire", type: "album", status: "processing", targetMbid: MBID, metadata: {} },
        });

    it.each([
        ["Spotify import album", () => failedJob()],
        ["library album", () => failedJob({ metadata: { downloadType: "library", albumTitle: "Things We Lost in the Fire" } })],
    ])("answers deduplicated with the running job, clears the failed %s job, and starts nothing", async (_name, make) => {
        const old = await make();
        const running = await runningJob();

        const res = await retry(old.id).expect(200);

        expect(res.body).toEqual({ success: true, newJobId: running.id, deduplicated: true });
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: old.id } })).cleared).toBe(true);
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(2);
        expect(mockSearchAndDownloadBatch).not.toHaveBeenCalled();
        expect(mockStartDownload).not.toHaveBeenCalled();
    });
});

describe("a retry beside a job the dedupe must read the way the active-album index does", () => {
    const libraryMeta = { downloadType: "library", albumTitle: "Things We Lost in the Fire" };
    const sibling = (data: Record<string, unknown>) =>
        prisma.downloadJob.create({
            data: { userId: USER, subject: "Low - Things We Lost in the Fire", type: "album", status: "processing", targetMbid: MBID, metadata: {}, ...data },
        });
    const batch = () =>
        prisma.discoveryBatch.create({
            data: { userId: USER, weekStart: new Date("2026-10-12T00:00:00.000Z"), targetSongCount: 1, totalAlbums: 1, status: "downloading" },
        });

    it.each([
        ["Spotify import album", () => failedJob()],
        ["library album", () => failedJob({ metadata: libraryMeta })],
    ])("answers deduplicated, not 500, for a %s whose album has a running job the user dismissed", async (_name, make) => {
        const old = await make();
        const running = await sibling({ cleared: true });

        const res = await retry(old.id).expect(200);

        expect(res.body).toEqual({ success: true, newJobId: running.id, deduplicated: true });
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(2);
    });

    it("does not dedupe a library retry against a track job of the same target", async () => {
        mockStartDownload.mockResolvedValue({ success: true });
        const old = await failedJob({ metadata: libraryMeta });
        const track = await sibling({ type: "track", subject: "Low - Sunflower" });

        const res = await retry(old.id).expect(200);

        expect(res.body.deduplicated).toBeUndefined();
        expect(res.body.newJobId).not.toBe(track.id);
        expect(await newJobOf(old.id, res.body.newJobId)).toMatchObject({ type: "album", status: "pending" });
    });

    it("does not dedupe a library retry against a Discover batch's job of the same album", async () => {
        mockStartDownload.mockResolvedValue({ success: true });
        const old = await failedJob({ metadata: libraryMeta });
        const week = await batch();
        const inBatch = await sibling({ discoveryBatchId: week.id });

        const res = await retry(old.id).expect(200);

        expect(res.body.deduplicated).toBeUndefined();
        expect(res.body.newJobId).not.toBe(inBatch.id);
        expect((await newJobOf(old.id, res.body.newJobId)).discoveryBatchId).toBeNull();
    });

    it.each([
        ["Spotify import album", (week: string) => failedJob({ discoveryBatchId: week })],
        ["library album", (week: string) => failedJob({ discoveryBatchId: week, metadata: libraryMeta })],
    ])("keeps the Discover batch on the replacement of a %s job", async (_name, make) => {
        mockStartDownload.mockResolvedValue({ success: true });
        mockSearchAndDownloadBatch.mockResolvedValue({ successful: 0, failed: 1, files: [] });
        const week = await batch();
        const old = await make(week.id);
        // A library job of the same album running beside the batch's own failed job is no duplicate of it.
        await sibling({});

        const res = await retry(old.id).expect(200);

        expect(res.body.deduplicated).toBeUndefined();
        expect((await newJobOf(old.id, res.body.newJobId)).discoveryBatchId).toBe(week.id);
        await whenIdle();
    });
});

describe("retrying the same failed download twice", () => {
    const replacementsOf = (oldId: string) => prisma.downloadJob.findMany({ where: { userId: USER, id: { not: oldId } } });
    const kinds: [string, () => ReturnType<typeof failedJob>][] = [
        ["Spotify import album", () => failedJob()],
        ["library album", () => failedJob({ metadata: { downloadType: "library", albumTitle: "Things We Lost in the Fire" } })],
    ];

    it.each(kinds)("makes one replacement for a double-click on a %s job", async (_name, make) => {
        // The background Soulseek download stays running until both clicks are answered: a replacement that had
        // already ended by the second click would rightly answer "already retried".
        let finish!: () => void;
        const downloading = new Promise<void>((resolve) => (finish = resolve));
        mockSearchAndDownloadBatch.mockImplementation(() =>
            downloading.then(() => ({ successful: 1, failed: 0, files: ["a.flac"] }))
        );
        mockStartDownload.mockResolvedValue({ success: true });
        const old = await make();

        const [a, b] = await Promise.all([retry(old.id), retry(old.id)]);
        finish();

        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect([a.body, b.body].filter((body) => body.deduplicated)).toHaveLength(1);
        expect(await replacementsOf(old.id)).toHaveLength(1);
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: old.id } })).cleared).toBe(true);
        await whenIdle();
    });

    it.each(kinds)("creates nothing for a second retry of a %s job whose replacement already ended", async (_name, make) => {
        expectLog("error");
        mockSearchAndDownloadBatch.mockRejectedValue(new Error("slskd unreachable"));
        mockStartDownload.mockRejectedValue(new Error("lidarr unreachable"));
        const old = await make();
        const first = await retry(old.id).expect(200);
        await waitFor(settled(first.body.newJobId), "first replacement settled");

        const second = await retry(old.id).expect(409);

        expect(second.body.success).toBeUndefined();
        expect(second.body.error).toEqual(expect.any(String));
        expect(await replacementsOf(old.id)).toHaveLength(1);
        await whenIdle();
    });

    it.each(kinds)("answers 409, and creates nothing, for a %s job that was dismissed with nothing running", async (_name, make) => {
        const old = await make();
        await prisma.downloadJob.update({ where: { id: old.id }, data: { cleared: true } });

        const res = await retry(old.id).expect(409);

        expect(res.body.success).toBeUndefined();
        expect(await replacementsOf(old.id)).toHaveLength(0);
        expect(mockSearchAndDownloadBatch).not.toHaveBeenCalled();
        expect(mockStartDownload).not.toHaveBeenCalled();
    });

    it("answers 404 for a download that is not there", async () => {
        await retry("nrt_nothing").expect(404);
    });

    it("answers success, never 500, when three failed jobs of one album are retried at once", async () => {
        mockStartDownload.mockResolvedValue({ success: true });
        const libraryMeta = { downloadType: "library", albumTitle: "Things We Lost in the Fire" };
        const failed = await Promise.all([failedJob({ metadata: libraryMeta }), failedJob({ metadata: libraryMeta }), failedJob({ metadata: libraryMeta })]);

        const answers = await Promise.all(failed.map((f) => retry(f.id)));

        expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
        expect(answers.filter((a) => a.body.deduplicated)).toHaveLength(2);
        const active = await prisma.downloadJob.findMany({ where: { userId: USER, status: { in: ["pending", "processing"] } } });
        expect(active).toHaveLength(1);
        expect(answers.filter((a) => !a.body.deduplicated)[0].body.newJobId).toBe(active[0].id);
        expect(await prisma.downloadJob.count({ where: { userId: USER, cleared: true } })).toBe(3);
    });

    it("makes one replacement when two failed jobs of one album are retried at once", async () => {
        mockStartDownload.mockResolvedValue({ success: true });
        const libraryMeta = { downloadType: "library", albumTitle: "Things We Lost in the Fire" };
        const first = await failedJob({ metadata: libraryMeta });
        const second = await failedJob({ metadata: libraryMeta });

        const [a, b] = await Promise.all([retry(first.id), retry(second.id)]);

        expect([a.status, b.status]).toEqual([200, 200]);
        expect([a.body, b.body].filter((body) => body.deduplicated)).toHaveLength(1);
        const active = await prisma.downloadJob.findMany({ where: { userId: USER, status: { in: ["pending", "processing"] } } });
        expect(active).toHaveLength(1);
        expect(await prisma.downloadJob.count({ where: { userId: USER, cleared: true } })).toBe(2);
    });
});

describe("a retried library album from before its artist and album were recorded", () => {
    it("takes the artist before the first ' - ' of the subject and the album after it", async () => {
        const old = await failedJob({ subject: "Low - Songs for a Dead Pilot - Part 2", metadata: { downloadType: "library" } });
        mockStartDownload.mockResolvedValue({ success: true });

        const res = await retry(old.id).expect(200);

        expect(mockStartDownload).toHaveBeenCalledWith(res.body.newJobId, "Low", "Songs for a Dead Pilot - Part 2", MBID, false);
    });
});

describe("a retried library album whose artist's name holds ' - '", () => {
    it("searches for the artist named in the job's metadata, not the part of the subject before the first ' - '", async () => {
        const old = await failedJob({
            subject: "Crosby - Stills - Deja Vu",
            metadata: { downloadType: "library", artistName: "Crosby - Stills", albumTitle: "Deja Vu" },
        });
        mockStartDownload.mockResolvedValue({ success: true });

        const res = await retry(old.id).expect(200);

        expect(mockStartDownload).toHaveBeenCalledWith(res.body.newJobId, "Crosby - Stills", "Deja Vu", MBID, false);
    });
});
