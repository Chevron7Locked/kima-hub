/**
 * A manual Soulseek download's job ends through the download-job module: complete or
 * fail, once, telling the user through the notification policy (one tray row) and the
 * event bus (one event). A job whose download did not reach a file fails with the
 * reason. Real database, router and notification policy; the Soulseek client stands in.
 */
const mockDownloadTrack = jest.fn();
jest.mock("../../services/soulseek", () => ({
    soulseekService: { isAvailable: jest.fn().mockResolvedValue(true), downloadTrack: (...a: unknown[]) => mockDownloadTrack(...a) },
}));
jest.mock("../../workers/scanRequest", () => ({ requestScan: jest.fn().mockResolvedValue({ queued: true }) }));

import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import soulseekRoutes from "../soulseek";
import { config, useMusicFolder } from "../../config";
import { eventBus } from "../../services/eventBus";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { expectLog } from "../../__tests__/helpers/expectedLogs";

const startFolder = config.music.musicPath;
const ADMIN = "zz-slsk-job-admin";
const app = express().use(express.json()).use("/soulseek", soulseekRoutes);
const asAdmin = `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;
let folder: string;

const download = () =>
    request(app).post("/soulseek/download").set("Authorization", asAdmin)
        .send({ username: "peer", filepath: "share\\Low\\Things\\03 Sunflower.flac", artist: "Low", title: "Sunflower", album: "Things" });
const theJob = () => prisma.downloadJob.findFirstOrThrow({ where: { userId: ADMIN } });
const notices = (type: string) => prisma.notification.count({ where: { userId: ADMIN, type } });

beforeAll(async () => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "slsk-job-"));
    useMusicFolder(folder);
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

beforeEach(() => mockDownloadTrack.mockReset());

afterEach(async () => {
    jest.restoreAllMocks();
    fs.rmSync(path.join(folder, "Low"), { recursive: true, force: true });
    await prisma.downloadJob.deleteMany({ where: { userId: ADMIN } });
    await prisma.notification.deleteMany({ where: { userId: ADMIN } });
});

afterAll(async () => {
    useMusicFolder(startFolder);
    fs.rmSync(folder, { recursive: true, force: true });
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await closeEngineConnections();
});

it("completes the job once, telling the user and the event bus once each", async () => {
    mockDownloadTrack.mockImplementation(async (_match: unknown, dest: string) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, "x");
        return { success: true };
    });
    const emit = jest.spyOn(eventBus, "emit");

    const res = await download();

    expect(res.status).toBe(200);
    const job = await theJob();
    expect(job.status).toBe("completed");
    expect(job.error).toBeNull();
    expect(job.metadata).toMatchObject({ notificationSent: true });
    expect(await notices("download_complete")).toBe(1);
    expect(emit.mock.calls.filter(([e]) => e.type === "download:complete")).toHaveLength(1);
});

it("fails the job with the reason when the file was not written", async () => {
    expectLog("error");
    mockDownloadTrack.mockResolvedValue({ success: true });

    const res = await download();

    expect(res.status).toBe(500);
    const job = await theJob();
    expect(job).toMatchObject({ status: "failed", error: "File not written to disk" });
    expect(job.metadata).toMatchObject({ statusText: "File not written to disk", notificationSent: true });
    expect(await notices("download_failed")).toBe(1);
});

it("fails the job with the peer's error when the download fails", async () => {
    mockDownloadTrack.mockResolvedValue({ success: false, error: "peer refused" });

    const res = await download();

    expect(res.status).toBe(500);
    expect(await theJob()).toMatchObject({ status: "failed", error: "peer refused" });
    expect(await notices("download_failed")).toBe(1);
});

it("fails the job when the download throws", async () => {
    expectLog("error");
    mockDownloadTrack.mockRejectedValue(new Error("connection reset"));

    await download();

    expect(await theJob()).toMatchObject({ status: "failed", error: "connection reset" });
    expect(await notices("download_failed")).toBe(1);
});
