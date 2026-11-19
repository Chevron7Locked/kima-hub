/**
 * DELETE /downloads/:id and /downloads/clear-all stop the unfinished jobs through the
 * download-job module before removing the rows, so the Discover batch that waits on them
 * is told (once per batch) and a job already settled is not settled or told again.
 * Real database and router; Lidarr and the batch's completion flow are stood in for.
 */

jest.mock("../../middleware/auth", () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "dld_user" };
        next();
    },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../services/lidarr", () => ({ lidarrService: { isEnabled: jest.fn().mockResolvedValue(true), unmonitorAlbum: jest.fn() } }));
jest.mock("../../services/lidarrFailures", () => ({ sweepFailedDownloads: jest.fn() }));
jest.mock("../../services/lidarrRemovals", () => ({ removeFailedDownload: jest.fn() }));
const mockCheckBatchCompletion = jest.fn();
jest.mock("../../services/discoverWeekly", () => ({
    discoverWeeklyService: { checkBatchCompletion: (...a: unknown[]) => mockCheckBatchCompletion(...a) },
}));

import express from "express";
import request from "supertest";
import downloadsRouter from "../downloads";
import { prisma } from "../../utils/db";
import * as downloadJobs from "../../services/downloads/jobs";
import { connectJobOwners } from "../../services/downloads/owners";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { mountAsServer } from "./helpers/serverMount";

const USER = "dld_user";
const WEEK = new Date("2026-10-12T00:00:00.000Z");
const app = mountAsServer(express().use(express.json()), "/downloads", downloadsRouter, "/api/downloads");

let batchId: string;
const job = (id: string, status: string, data: Record<string, unknown> = {}) =>
    prisma.downloadJob.create({
        data: { id, userId: USER, subject: `Low - ${id}`, type: "album", status, targetMbid: `rg-${id}`, ...data },
    });

beforeAll(async () => {
    connectJobOwners();
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

        const res = await request(app).delete("/downloads/dld_run");
        await downloadJobs.whenIdle();

        expect(res.body).toEqual({ success: true, deleted: true });
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
        await downloadJobs.whenIdle();

        expect(res.body).toEqual({ success: true, deleted: 3 });
        expect(mockCheckBatchCompletion).toHaveBeenCalledTimes(1);
        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(batchId);
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(0);
        // The batch's check read the rows before they were removed, the unfinished ones cancelled.
        expect(seen).toEqual({ dld_a: "failed:Cancelled by user", dld_b: "failed:Cancelled by user", dld_c: "completed:null" });
    });

    it("does not wait past a moment for a batch's check that is still running", async () => {
        await job("dld_slow", "processing", { discoveryBatchId: batchId });
        let release!: () => void;
        mockCheckBatchCompletion.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));

        const res = await request(app).delete("/downloads/clear-all");

        expect(res.body).toEqual({ success: true, deleted: 1 });
        release();
        await downloadJobs.whenIdle();
    }, 15_000);

    it("keeps the rows until a check queued behind a slow one has read them, however long the slow one takes", async () => {
        await job("dld_first", "processing", { discoveryBatchId: batchId });
        await job("dld_second", "processing", { discoveryBatchId: batchId });
        let release!: () => void;
        const seen: string[] = [];
        mockCheckBatchCompletion.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
        mockCheckBatchCompletion.mockImplementation(async () => {
            for (const row of await prisma.downloadJob.findMany({ where: { userId: USER } })) seen.push(row.id);
        });
        // A first settle starts the batch's check, which is still running when the user clears everything.
        await downloadJobs.fail([{ id: "dld_first" }], "Import failed");

        const res = await request(app).delete("/downloads/clear-all");

        expect(res.body).toEqual({ success: true, deleted: 2 });
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(2);
        expect(await prisma.downloadJob.count({ where: { userId: USER, cleared: true } })).toBe(2);
        release();
        await downloadJobs.whenIdle();
        expect(seen.sort()).toEqual(["dld_first", "dld_second"]);
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(0);
    });

    it("refuses a status that is not one a job can have, and removes nothing", async () => {
        await job("dld_keep", "completed");

        const res = await request(app).delete("/downloads/clear-all").query({ status: "not-a-status" });

        expect(res.status).toBe(400);
        expect(await prisma.downloadJob.count({ where: { id: "dld_keep" } })).toBe(1);
    });

    it("removes only the jobs of a status it is given", async () => {
        await job("dld_old", "completed");
        await job("dld_new", "processing");

        const res = await request(app).delete("/downloads/clear-all").query({ status: "completed" });

        expect(res.body).toEqual({ success: true, deleted: 1 });
        expect(await prisma.downloadJob.findMany({ where: { userId: USER }, select: { id: true } })).toEqual([{ id: "dld_new" }]);
    });
});
