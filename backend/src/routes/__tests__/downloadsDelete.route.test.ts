/**
 * DELETE /downloads/:id and /downloads/clear-all stop the unfinished jobs through the
 * download-job module before removing the rows, so the Discover batch that waits on them
 * is told (once per batch) and a job already settled is not settled or told again.
 * Real database and router; Lidarr and the batch's completion flow are stood in for.
 */

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../middleware/auth", () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "dld_user" };
        next();
    },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../services/lidarr", () => ({ lidarrService: { isEnabled: jest.fn().mockResolvedValue(true), unmonitorAlbum: jest.fn() } }));
jest.mock("../../services/lidarrFailures", () => ({ sweepFailedDownloads: jest.fn(), removeFailedDownload: jest.fn() }));
const mockCheckBatchCompletion = jest.fn();
jest.mock("../../services/discoverWeekly", () => ({
    discoverWeeklyService: { checkBatchCompletion: (...a: unknown[]) => mockCheckBatchCompletion(...a) },
}));

import express from "express";
import request from "supertest";
import downloadsRouter from "../downloads";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "dld_user";
const WEEK = new Date("2026-10-12T00:00:00.000Z");
const app = express().use(express.json()).use("/downloads", downloadsRouter);

let batchId: string;
const job = (id: string, status: string, data: Record<string, unknown> = {}) =>
    prisma.downloadJob.create({
        data: { id, userId: USER, subject: `Low - ${id}`, type: "album", status, targetMbid: `rg-${id}`, ...data },
    });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

beforeEach(async () => {
    mockCheckBatchCompletion.mockReset().mockResolvedValue(undefined);
    batchId = (await prisma.discoveryBatch.create({
        data: { userId: USER, weekStart: WEEK, targetSongCount: 2, totalAlbums: 2, status: "downloading" },
    })).id;
});

afterEach(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

describe("DELETE /downloads/:id", () => {
    it("cancels a running job of a batch before removing it, and tells the batch", async () => {
        await job("dld_run", "processing", { discoveryBatchId: batchId });
        let seenByBatch: { status: string; error: string | null; metadata: any } | null = null;
        mockCheckBatchCompletion.mockImplementation(async () => {
            const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: "dld_run" } });
            seenByBatch = { status: row.status, error: row.error, metadata: row.metadata };
        });

        const res = await request(app).delete("/downloads/dld_run");

        expect(res.body).toEqual({ success: true, deleted: true });
        expect(seenByBatch).toMatchObject({ status: "failed", error: "Cancelled by user", metadata: { cancelled: true } });
        expect(mockCheckBatchCompletion).toHaveBeenCalledTimes(1);
        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(batchId);
        expect(await prisma.downloadJob.count({ where: { id: "dld_run" } })).toBe(0);
    });

    it("tells nobody about a job that had already finished", async () => {
        await job("dld_done", "completed", { discoveryBatchId: batchId });

        const res = await request(app).delete("/downloads/dld_done");

        expect(res.body.deleted).toBe(true);
        expect(mockCheckBatchCompletion).not.toHaveBeenCalled();
    });

    it("does not touch another listener's job", async () => {
        const other = await prisma.user.create({ data: { id: "dld_other", username: "dld_other", passwordHash: "x", role: "user", tokenVersion: 0 } });
        await prisma.downloadJob.create({ data: { id: "dld_theirs", userId: other.id, subject: "x", type: "album", status: "processing", discoveryBatchId: batchId } });

        const res = await request(app).delete("/downloads/dld_theirs");

        expect(res.body.deleted).toBe(false);
        expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: "dld_theirs" } })).status).toBe("processing");
        expect(mockCheckBatchCompletion).not.toHaveBeenCalled();
        await prisma.downloadJob.deleteMany({ where: { userId: other.id } });
        await prisma.user.deleteMany({ where: { id: other.id } });
    });
});

describe("DELETE /downloads/clear-all", () => {
    it("cancels the unfinished jobs, tells their batch once, and removes every row", async () => {
        await job("dld_a", "processing", { discoveryBatchId: batchId });
        await job("dld_b", "pending", { discoveryBatchId: batchId });
        await job("dld_c", "completed", { discoveryBatchId: batchId });
        const seen: Record<string, string> = {};
        mockCheckBatchCompletion.mockImplementation(async () => {
            for (const row of await prisma.downloadJob.findMany({ where: { userId: USER } })) seen[row.id] = `${row.status}:${row.error}`;
        });

        const res = await request(app).delete("/downloads/clear-all");

        expect(res.body).toEqual({ success: true, deleted: 3 });
        expect(seen).toEqual({ dld_a: "failed:Cancelled by user", dld_b: "failed:Cancelled by user", dld_c: "completed:null" });
        expect(mockCheckBatchCompletion).toHaveBeenCalledTimes(1);
        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(batchId);
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(0);
    });
});
