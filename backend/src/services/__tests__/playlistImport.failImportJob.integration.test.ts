/**
 * An import is failed from outside the import (the stuck-work check, the stale-job cleanup) through one move: it only
 * leaves a state that is not final, and it tells the person's open import page, so the page stops spinning. Real
 * database and Redis.
 */
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { eventBus, type SSEEvent } from "../eventBus";
import { failImportJob, getImportJob } from "../playlistImport";
import { logger } from "../../utils/logger";
import { notificationService } from "../notificationService";
import * as downloadJobs from "../downloads/jobs";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "zz-fail-import-user";

const job = (status: string) =>
    prisma.spotifyImportJob.create({
        data: {
            userId: USER, spotifyPlaylistId: "37i9dQZF1DXcBWIGoYBM5M", playlistName: "Today's Top Hits",
            status, progress: 80, albumsTotal: 1, tracksTotal: 1, pendingTracks: [],
        },
    });

const downloadJob = (importJobId: string, status: string) =>
    prisma.downloadJob.create({
        data: {
            userId: USER, subject: `Album ${status}`, type: "album", status,
            metadata: { downloadType: "spotify_import", spotifyImportJobId: importJobId },
        },
    });

let notifyFailed: jest.SpyInstance;
let heard: SSEEvent[];
let stop: () => void;

beforeAll(async () => {
    await waitForRedisReady();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

beforeEach(() => {
    notifyFailed = jest.spyOn(notificationService, "notifyImportFailed").mockResolvedValue(undefined as never);
    heard = [];
    stop = eventBus.subscribe(USER, { send: (event) => (heard.push(event), true) });
});

afterEach(async () => {
    stop();
    notifyFailed.mockRestore();
    await downloadJobs.whenIdle();
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    const ids = (await prisma.spotifyImportJob.findMany({ where: { userId: USER }, select: { id: true } })).map((j) => j.id);
    await Promise.all(ids.map((id) => redisClient.del(`import:job:${id}`)));
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("fails an import that is still running, and tells the page and the cache", async () => {
    const running = await job("scanning");

    expect(await failImportJob(running.id, "Scan timed out after 30 minutes")).toBe(true);

    expect(await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
        status: "failed",
        error: "Scan timed out after 30 minutes",
    });
    expect(heard).toEqual([
        expect.objectContaining({
            type: "import:progress",
            payload: expect.objectContaining({ jobId: running.id, status: "failed", error: "Scan timed out after 30 minutes" }),
        }),
    ]);
    expect((await getImportJob(running.id))?.status).toBe("failed");
});

it("tells the person once, with the reason, and closes the import's unsettled downloads", async () => {
    const running = await job("downloading");
    const other = await job("downloading");
    const pending = await downloadJob(running.id, "pending");
    const processing = await downloadJob(running.id, "processing");
    const completed = await downloadJob(running.id, "completed");
    const failed = await downloadJob(running.id, "failed");
    const othersJob = await downloadJob(other.id, "pending");
    const settledBefore = await prisma.downloadJob.findMany({ where: { id: { in: [completed.id, failed.id] } }, orderBy: { id: "asc" } });

    expect(await failImportJob(running.id, "Cleaned up as stale")).toBe(true);
    await downloadJobs.whenIdle();

    expect(notifyFailed).toHaveBeenCalledTimes(1);
    expect(notifyFailed).toHaveBeenCalledWith(USER, running.id, "Today's Top Hits", "Cleaned up as stale");

    const rows = await prisma.downloadJob.findMany({ where: { id: { in: [pending.id, processing.id] } } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
        expect(row.status).toBe("failed");
        expect(downloadJobs.isCancelled(row)).toBe(true);
    }
    expect(await prisma.downloadJob.findMany({ where: { id: { in: [completed.id, failed.id] } }, orderBy: { id: "asc" } })).toEqual(settledBefore);
    expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: othersJob.id } })).status).toBe("pending");

    // Cancelling the downloads checks the import: it is closed, so the check leaves it as failed, with its reason, and tells nobody again.
    expect(await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
        status: "failed",
        error: "Cleaned up as stale",
    });
    expect(notifyFailed).toHaveBeenCalledTimes(1);
});

it("still fails the import and tells the person when its downloads cannot be cancelled", async () => {
    const running = await job("downloading");
    await downloadJob(running.id, "pending");
    const cancel = jest.spyOn(downloadJobs, "cancel").mockRejectedValueOnce(new Error("db down"));
    const logged = jest.spyOn(logger, "error").mockImplementation(() => undefined);

    expect(await failImportJob(running.id, "Scan timed out after 30 minutes")).toBe(true);

    expect((await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("failed");
    expect(notifyFailed).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(running.id), expect.any(Error));
    cancel.mockRestore();
    logged.mockRestore();
});

it.each(["completed", "failed", "cancelled"])("leaves an import that is already %s, and tells nobody", async (status) => {
    const closed = await job(status);
    await prisma.spotifyImportJob.update({ where: { id: closed.id }, data: { error: status === "failed" ? "first reason" : null } });

    expect(await failImportJob(closed.id, "late reason")).toBe(false);

    const row = await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.status).toBe(status);
    expect(row.error).toBe(status === "failed" ? "first reason" : null);
    expect(heard).toEqual([]);
});

it.each(["completed", "failed", "cancelled"])("sends no notice and cancels no download for an import already %s", async (status) => {
    const closed = await job(status);
    const pending = await downloadJob(closed.id, "pending");
    const processing = await downloadJob(closed.id, "processing");

    expect(await failImportJob(closed.id, "late reason")).toBe(false);
    await downloadJobs.whenIdle();

    expect(notifyFailed).not.toHaveBeenCalled();
    const rows = await prisma.downloadJob.findMany({ where: { id: { in: [pending.id, processing.id] } }, orderBy: { status: "asc" } });
    expect(rows.map((r) => r.status)).toEqual(["pending", "processing"]);
});

it("answers false for an import that is gone", async () => {
    expect(await failImportJob("import_gone", "x")).toBe(false);
    expect(heard).toEqual([]);
    expect(notifyFailed).not.toHaveBeenCalled();
});
