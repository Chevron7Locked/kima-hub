/**
 * POST /notifications/downloads/:id/retry starts a fresh job from a failed one and settles it
 * through the download-job module: a Soulseek success or failure completes or fails the job,
 * merging into the metadata it holds (a write that landed meanwhile survives) and telling the
 * Spotify import it belongs to. The failure marks of the old job do not follow the copy.
 * A retry clears the failed job only together with creating its replacement, and a replacement that
 * cannot start ends failed, so the user always sees one of them. A retry is idempotent: a second retry of
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
jest.mock("../../workers/scanRequest", () => ({ requestScan: jest.fn().mockResolvedValue({ queued: true }) }));
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
import * as downloadJobs from "../../services/downloads/jobs";
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
    mockCheckImportCompletion.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
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

describe("a retry whose replacement cannot be created", () => {
    const jobsOf = () => prisma.downloadJob.findMany({ where: { userId: USER }, orderBy: { createdAt: "asc" } });

    it.each([
        ["Spotify import album", () => failedJob()],
        ["library album", () => failedJob({ metadata: { downloadType: "library", albumTitle: "Things We Lost in the Fire" } })],
    ])("leaves the failed %s job on the user's list", async (_name, make) => {
        expectLog("error");
        const old = await make();
        jest.spyOn(downloadJobs, "create").mockRejectedValueOnce(new Error("database went away"));

        await retry(old.id).expect(500);

        const rows = await jobsOf();
        expect(rows.map((j) => j.id)).toEqual([old.id]);
        expect(rows[0]).toMatchObject({ status: "failed", cleared: false });
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

describe("retrying the same failed download twice", () => {
    const replacementsOf = (oldId: string) => prisma.downloadJob.findMany({ where: { userId: USER, id: { not: oldId } } });
    const kinds: [string, () => ReturnType<typeof failedJob>][] = [
        ["Spotify import album", () => failedJob()],
        ["library album", () => failedJob({ metadata: { downloadType: "library", albumTitle: "Things We Lost in the Fire" } })],
    ];

    it.each(kinds)("makes one replacement for a double-click on a %s job", async (_name, make) => {
        mockSearchAndDownloadBatch.mockResolvedValue({ successful: 1, failed: 0, files: ["a.flac"] });
        mockStartDownload.mockResolvedValue({ success: true });
        const old = await make();

        const [a, b] = await Promise.all([retry(old.id), retry(old.id)]);

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

        const second = await retry(old.id).expect(200);

        expect(second.body).toMatchObject({ success: true, deduplicated: true });
        expect(await replacementsOf(old.id)).toHaveLength(1);
        await whenIdle();
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
