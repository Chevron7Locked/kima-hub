/**
 * Job state on the real test database: a parked download keeps its job waiting
 * and tells the user once, and a job that never started fails after ten minutes
 * unless it is held for Lidarr. Settling a job once is the download-jobs
 * module's own test (downloads/__tests__/jobs.test.ts).
 */

import { prisma } from "../../utils/db";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "sdm_life_user";

const job = (id: string, data: Record<string, unknown> = {}) =>
    prisma.downloadJob.create({
        data: {
            id,
            userId: USER,
            subject: "Brad Sucks - Guess Who’s a Mess",
            type: "album",
            status: "processing",
            targetMbid: `rg-${id}`,
            metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" },
            ...data,
        },
    });

const notices = (type: string) => prisma.notification.count({ where: { userId: USER, type } });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterEach(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("keeps a parked download's job waiting and says so once", async () => {
    await job("sdm_life_parked", { lidarrRef: "DL-PARKED" });

    expect(await simpleDownloadManager.onImportParked("DL-PARKED", "Tracks missing")).toBe(1);
    expect(await simpleDownloadManager.onImportParked("DL-PARKED", "Tracks missing")).toBe(0);

    const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_life_parked" } });
    expect(row.status).toBe("processing");
    expect((row.metadata as any).parked).toBe("Tracks missing");
    expect((row.metadata as any).statusText).toBe("Waiting in Lidarr: Tracks missing");
    expect((row.metadata as any).albumTitle).toBe("Guess Who’s a Mess");
    expect(await notices("download_waiting")).toBe(1);
    expect(await notices("download_failed")).toBe(0);
});

it("fails a job that never started after ten minutes, unless it is held for Lidarr", async () => {
    const old = new Date(Date.now() - 11 * 60_000);
    await job("sdm_life_stale", { status: "pending", createdAt: old });
    await job("sdm_life_held", { status: "pending", createdAt: old, metadata: { waitingForLidarr: true } });
    await job("sdm_life_new", { status: "pending" });

    await simpleDownloadManager.checkWaitingJobs(null);

    const status = async (id: string) => (await prisma.downloadJob.findUniqueOrThrow({ where: { id } })).status;
    expect(await status("sdm_life_stale")).toBe("failed");
    expect(await status("sdm_life_held")).toBe("pending");
    expect(await status("sdm_life_new")).toBe("pending");
});

it("fails held downloads when Lidarr is turned off", async () => {
    await job("sdm_life_held_off", { status: "pending", metadata: { waitingForLidarr: true } });
    expect(await simpleDownloadManager.failHeldDownloads()).toBe(1);
    const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_life_held_off" } });
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Lidarr is turned off");
});

it("leaves a download another user's job shares when one user cancels", async () => {
    const OTHER = "sdm_life_other";
    await prisma.user.deleteMany({ where: { id: OTHER } });
    await prisma.user.create({ data: { id: OTHER, username: OTHER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    try {
        const mine = await job("sdm_life_cancel_mine", { lidarrRef: "DL-SHARED", lidarrAlbumId: 39 });
        await prisma.downloadJob.create({
            data: {
                id: "sdm_life_cancel_theirs", userId: OTHER, subject: "Brad Sucks - Guess Who’s a Mess", type: "album",
                status: "processing", targetMbid: "rg-shared", lidarrRef: "DL-SHARED", lidarrAlbumId: 39, metadata: {},
            },
        });

        await simpleDownloadManager.cancelJobs([mine]);

        expect(await prisma.handledDownload.count({ where: { downloadId: "DL-SHARED" } })).toBe(0);
    } finally {
        await prisma.downloadJob.deleteMany({ where: { userId: OTHER } });
        await prisma.user.deleteMany({ where: { id: OTHER } });
    }
});
