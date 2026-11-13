/**
 * POST /notifications/downloads/:id/retry starts a fresh job from a failed one and settles it
 * through the download-job module: a Soulseek success or failure completes or fails the job,
 * merging into the metadata it holds (a write that landed meanwhile survives) and telling the
 * Spotify import it belongs to. The failure marks of the old job do not follow the copy.
 * Real database and router; Soulseek, the download manager and the import are stood in for.
 */

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
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
import { mergeMetadata, whenIdle } from "../../services/downloads/jobs";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "nrt_user";
const IMPORT = "nrt_import";
const MBID = "e1e10000-1111-2222-3333-444455556666";
const app = express().use(express.json()).use("/notifications", notificationRoutes);

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
        await whenIdle();
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
        await whenIdle();
        expect(mockCheckImportCompletion).toHaveBeenCalledWith(IMPORT);
    });

    it("fails the new job with Lidarr's reason when the fallback does not start", async () => {
        const old = await failedJob();
        mockSearchAndDownloadBatch.mockResolvedValue({ successful: 0, failed: 1, files: [] });
        mockStartDownload.mockResolvedValue({ success: false, error: "Lidarr has no such album" });

        const res = await retry(old.id);
        await waitFor(settled(res.body.newJobId), "new job settled");

        expect(await newJobOf(old.id, res.body.newJobId)).toMatchObject({ status: "failed", error: "Lidarr has no such album" });
        await whenIdle();
        expect(mockCheckImportCompletion).toHaveBeenCalledWith(IMPORT);
    });

    it("fails the new job with the error when Soulseek throws", async () => {
        const old = await failedJob();
        mockSearchAndDownloadBatch.mockRejectedValue(new Error("slskd unreachable"));

        const res = await retry(old.id);
        await waitFor(settled(res.body.newJobId), "new job settled");

        expect(await newJobOf(old.id, res.body.newJobId)).toMatchObject({ status: "failed", error: "slskd unreachable" });
        await whenIdle();
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
