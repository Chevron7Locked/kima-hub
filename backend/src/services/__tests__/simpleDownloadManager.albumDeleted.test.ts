/**
 * When Lidarr deletes an album, the job downloading it fails at once and
 * Discover forgets the Lidarr id; other jobs are untouched.
 */

import { prisma } from "../../utils/db";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "sdm_album_deleted_user";

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({
        data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 },
    });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("fails the running job and clears the Discover album's Lidarr id", async () => {
    const job = (id: string, status: string, lidarrAlbumId: number) =>
        prisma.downloadJob.create({
            data: { id, userId: USER, subject: id, type: "album", status, targetMbid: `rg-${id}`, lidarrAlbumId },
        });
    await job("sdm_del_running", "processing", 42);
    await job("sdm_del_done", "completed", 42);
    await job("sdm_del_other", "processing", 43);
    await prisma.discoveryAlbum.create({
        data: { userId: USER, rgMbid: "rg-1", artistName: "A", albumTitle: "B", lidarrAlbumId: 42, weekStartDate: new Date() },
    });

    expect(await simpleDownloadManager.onAlbumDeleted(42)).toBe("sdm_del_running");

    const status = async (id: string) => (await prisma.downloadJob.findUniqueOrThrow({ where: { id } })).status;
    expect(await status("sdm_del_running")).toBe("failed");
    expect(await status("sdm_del_done")).toBe("completed");
    expect(await status("sdm_del_other")).toBe("processing");
    const failed = await prisma.downloadJob.findUniqueOrThrow({ where: { id: "sdm_del_running" } });
    expect(failed.error).toBe("Album removed from Lidarr");
    const discovery = await prisma.discoveryAlbum.findFirstOrThrow({ where: { userId: USER } });
    expect(discovery.lidarrAlbumId).toBeNull();
});

it("fails a pending job on the album too, and names the first job it actually settled", async () => {
    const job = (id: string, status: string, lidarrAlbumId: number, createdAt: Date) =>
        prisma.downloadJob.create({
            data: { id, userId: USER, subject: id, type: "album", status, targetMbid: `rg-${id}`, lidarrAlbumId, createdAt },
        });
    await job("sdm_del_settled", "completed", 44, new Date(Date.now() - 3000));
    await job("sdm_del_pending", "pending", 44, new Date(Date.now() - 2000));
    await job("sdm_del_proc", "processing", 44, new Date(Date.now() - 1000));

    expect(await simpleDownloadManager.onAlbumDeleted(44)).toBe("sdm_del_pending");

    const status = async (id: string) => (await prisma.downloadJob.findUniqueOrThrow({ where: { id } })).status;
    expect(await status("sdm_del_pending")).toBe("failed");
    expect(await status("sdm_del_proc")).toBe("failed");
    expect(await status("sdm_del_settled")).toBe("completed");
});

it("names no job when none of the album's jobs was still active", async () => {
    await prisma.downloadJob.create({
        data: { id: "sdm_del_only_done", userId: USER, subject: "x", type: "album", status: "completed", targetMbid: "rg-x", lidarrAlbumId: 45 },
    });
    expect(await simpleDownloadManager.onAlbumDeleted(45)).toBeUndefined();
});
