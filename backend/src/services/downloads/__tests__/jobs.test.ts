/**
 * The download-job moves (start, complete, fail, cancel, retry) on the real test
 * database and Redis: each runs only from a state it can leave, so a settled job
 * is never settled again; each merges metadata instead of overwriting it; and each
 * tells the user (through the notification policy), the Discover batch and the
 * Spotify import.
 */

import { prisma } from "../../../utils/db";
import * as downloadJobs from "../jobs";
import { notificationPolicyService } from "../../notificationPolicyService";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(30_000);

const USER = "dl_jobs_user";
const WEEK = new Date("2026-10-12T00:00:00.000Z");

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

const row = (id: string) => prisma.downloadJob.findUniqueOrThrow({ where: { id } });
const meta = async (id: string) => (await row(id)).metadata as Record<string, any>;
const notices = (type: string) => prisma.notification.count({ where: { userId: USER, type } });
const batchOf = (totalAlbums: number) =>
    prisma.discoveryBatch.create({
        data: { userId: USER, weekStart: WEEK, targetSongCount: totalAlbums, totalAlbums, status: "downloading" },
    });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
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

describe("start", () => {
    it("starts a pending job, keeping the metadata it already had", async () => {
        await job("dl_start_ok", { status: "pending", metadata: { downloadType: "discovery", waitingForLidarr: true, keep: "me" } });

        const started = await downloadJobs.start("dl_start_ok", {
            correlationId: "corr-1",
            lidarrAlbumId: 77,
            artistMbid: "artist-mbid",
            metadata: { currentSource: "lidarr", statusText: "Searching", searchCommandId: 5 },
        });

        expect(started).toBe(true);
        const r = await row("dl_start_ok");
        expect(r).toMatchObject({ status: "processing", correlationId: "corr-1", lidarrAlbumId: 77, artistMbid: "artist-mbid", attempts: 1 });
        expect(r.startedAt).toBeInstanceOf(Date);
        expect(await meta("dl_start_ok")).toMatchObject({
            downloadType: "discovery", keep: "me", currentSource: "lidarr", statusText: "Searching", searchCommandId: 5,
        });
    });

    it("calls a job a library download when nothing said otherwise, and clears a field set to null", async () => {
        await job("dl_start_default", { status: "pending", metadata: { searchCommandId: 9 } });
        await downloadJobs.start("dl_start_default", { correlationId: "corr-2", lidarrAlbumId: 1, metadata: { searchCommandId: null } });
        const m = await meta("dl_start_default");
        expect(m.downloadType).toBe("library");
        expect(m).not.toHaveProperty("searchCommandId");
    });

    it("takes over an existing download reference when given one", async () => {
        await job("dl_start_join", { status: "pending" });
        await downloadJobs.start("dl_start_join", { correlationId: "corr-3", lidarrAlbumId: 2, lidarrRef: "DL-9", metadata: {} });
        expect((await row("dl_start_join")).lidarrRef).toBe("DL-9");
    });

    it.each(["completed", "failed"])("does not start a %s job", async (status) => {
        await job("dl_start_settled", { status, metadata: { keep: "me" } });
        expect(await downloadJobs.start("dl_start_settled", { correlationId: "corr-4", lidarrAlbumId: 3, metadata: { x: 1 } })).toBe(false);
        const r = await row("dl_start_settled");
        expect(r.status).toBe(status);
        expect(r.correlationId).toBeNull();
        expect(await meta("dl_start_settled")).toEqual({ keep: "me" });
    });
});

describe("complete", () => {
    it("completes a job, merges the metadata, clears the error and parked, and tells the user once", async () => {
        const j = await job("dl_done", {
            error: "earlier",
            metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess", parked: "Tracks missing", keep: "me" },
        });

        const settled = await downloadJobs.complete([j], { statusText: "Already in library" });

        expect(settled.map((s) => s.id)).toEqual([j.id]);
        const r = await row(j.id);
        expect(r.status).toBe("completed");
        expect(r.error).toBeNull();
        expect(r.completedAt).toBeInstanceOf(Date);
        const m = await meta(j.id);
        expect(m).toMatchObject({ keep: "me", statusText: "Already in library", albumTitle: "Guess Who’s a Mess", notificationSent: true });
        expect(m).not.toHaveProperty("parked");
        expect(typeof m.completedAt).toBe("string");
        expect(await notices("download_complete")).toBe(1);
    });

    it("never completes a settled job again, and says nothing the second time", async () => {
        const j = await job("dl_done_twice");
        expect(await downloadJobs.complete([j])).toHaveLength(1);
        expect(await downloadJobs.complete([j])).toHaveLength(0);
        expect(await notices("download_complete")).toBe(1);

        const failed = await job("dl_done_failed", { status: "failed", error: "boom" });
        expect(await downloadJobs.complete([failed])).toHaveLength(0);
        expect((await row(failed.id)).status).toBe("failed");
    });

    it("completes a pending job too", async () => {
        const j = await job("dl_done_pending", { status: "pending" });
        expect(await downloadJobs.complete([j])).toHaveLength(1);
        expect((await row(j.id)).status).toBe("completed");
    });

    it("asks the notification policy, which keeps quiet for a Discover job", async () => {
        const j = await job("dl_done_quiet", {
            metadata: { downloadType: "discovery", artistName: "Brad Sucks", albumTitle: "I Don't Know What I'm Doing" },
        });
        await downloadJobs.complete([j]);
        expect(await notices("download_complete")).toBe(0);
        expect(await meta(j.id)).not.toHaveProperty("notificationSent");
    });

    it("tells the batch: a batch whose last job completes moves to the scan step", async () => {
        const batch = await batchOf(1);
        const j = await job("dl_done_batch", { discoveryBatchId: batch.id });

        await downloadJobs.complete([j]);

        expect((await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("scanning");
    });

    it("tells the import once for a job it settled, and not for one already settled", async () => {
        const { spotifyImportService } = await import("../../spotifyImport");
        const told = jest.spyOn(spotifyImportService, "checkImportCompletion").mockResolvedValue();
        const j = await job("dl_done_import", {
            metadata: { spotifyImportJobId: "imp-1", artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" },
        });

        await downloadJobs.complete([j]);
        await downloadJobs.complete([j]);

        expect(told.mock.calls).toEqual([["imp-1"]]);
    });

    it("tells the batch and the import once each however many of their jobs it completes", async () => {
        const { spotifyImportService } = await import("../../spotifyImport");
        const { discoverWeeklyService } = await import("../../discoverWeekly");
        const importTold = jest.spyOn(spotifyImportService, "checkImportCompletion").mockResolvedValue();
        const batchTold = jest.spyOn(discoverWeeklyService, "checkBatchCompletion").mockResolvedValue();
        const batch = await batchOf(2);
        const a = await job("dl_done_many_a", { discoveryBatchId: batch.id, metadata: { spotifyImportJobId: "imp-2" } });
        const b = await job("dl_done_many_b", { discoveryBatchId: batch.id, metadata: { spotifyImportJobId: "imp-2" } });

        await downloadJobs.complete([a, b]);

        expect(batchTold.mock.calls).toEqual([[batch.id]]);
        expect(importTold.mock.calls).toEqual([["imp-2"]]);
    });
});

describe("fail", () => {
    it("fails a job once however many paths reach it, and tells the user once", async () => {
        const j = await job("dl_fail");

        expect(await downloadJobs.fail([j], "Lidarr removed the download without importing it")).toHaveLength(1);
        expect(await downloadJobs.fail([j], "Download never started - timed out")).toHaveLength(0);

        const r = await row(j.id);
        expect(r.status).toBe("failed");
        expect(r.error).toBe("Lidarr removed the download without importing it");
        expect(r.completedAt).toBeInstanceOf(Date);
        expect(await meta(j.id)).toMatchObject({
            albumTitle: "Guess Who’s a Mess",
            statusText: "Lidarr removed the download without importing it",
            notificationSent: true,
        });
        expect(await notices("download_failed")).toBe(1);
    });

    it("never fails a job that already completed", async () => {
        const j = await job("dl_fail_done", { status: "completed" });
        expect(await downloadJobs.fail([j], "late failure")).toHaveLength(0);
        expect((await row(j.id)).status).toBe("completed");
        expect(await notices("download_failed")).toBe(0);
    });

    it("lets the caller's metadata patch win over the default status text", async () => {
        const j = await job("dl_fail_patch");
        await downloadJobs.fail([j], "Not here", { statusText: "No sources available" });
        expect((await meta(j.id)).statusText).toBe("No sources available");
    });

    it("asks the notification policy before it tells the user", async () => {
        const asked = jest.spyOn(notificationPolicyService, "evaluateNotification");
        const j = await job("dl_fail_policy", { metadata: { downloadType: "discovery" } });
        await downloadJobs.fail([j], "gone");
        expect(asked).toHaveBeenCalledWith(j.id, "failed");
        expect(await notices("download_failed")).toBe(0);
    });

    it("tells the batch: a batch whose only job fails ends as failed", async () => {
        const batch = await batchOf(1);
        const j = await job("dl_fail_batch", { discoveryBatchId: batch.id });

        await downloadJobs.fail([j], "gone");

        expect((await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("failed");
    });

    it("tells the import, and not again for a job already failed", async () => {
        const { spotifyImportService } = await import("../../spotifyImport");
        const told = jest.spyOn(spotifyImportService, "checkImportCompletion").mockResolvedValue();
        const j = await job("dl_fail_import", { metadata: { spotifyImportJobId: "imp-3" } });

        await downloadJobs.fail([j], "gone");
        await downloadJobs.fail([j], "gone again");

        expect(told.mock.calls).toEqual([["imp-3"]]);
    });
});

describe("cancel", () => {
    it("settles an active job as failed 'Cancelled by user', merges metadata, and does not tell the user", async () => {
        const j = await job("dl_cancel", { metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess", keep: "me" } });

        const settled = await downloadJobs.cancel([j]);

        expect(settled).toHaveLength(1);
        const r = await row(j.id);
        expect(r).toMatchObject({ status: "failed", error: "Cancelled by user" });
        expect(r.completedAt).toBeInstanceOf(Date);
        expect(await meta(j.id)).toMatchObject({ keep: "me", cancelled: true, statusText: "Cancelled" });
        expect(await notices("download_failed")).toBe(0);
    });

    it("takes the reason the caller gives", async () => {
        const j = await job("dl_cancel_reason");
        await downloadJobs.cancel([j], "Parent batch cleaned up as stale");
        expect((await row(j.id)).error).toBe("Parent batch cleaned up as stale");
    });

    it("leaves a settled job alone", async () => {
        const done = await job("dl_cancel_done", { status: "completed" });
        const failed = await job("dl_cancel_failed", { status: "failed", error: "boom" });
        expect(await downloadJobs.cancel([done, failed])).toHaveLength(0);
        expect((await row(done.id)).status).toBe("completed");
        expect((await row(failed.id)).error).toBe("boom");
    });

    it("tells the batch and the import", async () => {
        const { spotifyImportService } = await import("../../spotifyImport");
        const importTold = jest.spyOn(spotifyImportService, "checkImportCompletion").mockResolvedValue();
        const batch = await batchOf(1);
        const j = await job("dl_cancel_told", { discoveryBatchId: batch.id, metadata: { spotifyImportJobId: "imp-4" } });

        await downloadJobs.cancel([j]);

        expect((await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("failed");
        expect(importTold.mock.calls).toEqual([["imp-4"]]);
    });
});

describe("retry", () => {
    it("puts a failed job back to pending, keeping its metadata and letting its next outcome notify", async () => {
        const j = await job("dl_retry", {
            status: "failed",
            error: "boom",
            completedAt: new Date(),
            metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess", keep: "me", notificationSent: true, failedAt: "x" },
        });

        const retried = await downloadJobs.retry([j]);

        expect(retried.map((r) => r.id)).toEqual([j.id]);
        const r = await row(j.id);
        expect(r).toMatchObject({ status: "pending", error: null, completedAt: null });
        const m = await meta(j.id);
        expect(m).toMatchObject({ keep: "me", artistName: "Brad Sucks", statusText: "Retrying" });
        expect(m).not.toHaveProperty("notificationSent");
        expect(m).not.toHaveProperty("failedAt");
    });

    it.each(["pending", "processing", "completed"])("does not retry a %s job", async (status) => {
        const j = await job(`dl_retry_${status}`, { status });
        expect(await downloadJobs.retry([j])).toHaveLength(0);
        expect((await row(j.id)).status).toBe(status);
    });

    it("retries a job once, however many paths reach it", async () => {
        const j = await job("dl_retry_twice", { status: "failed", error: "boom" });
        expect(await downloadJobs.retry([j])).toHaveLength(1);
        expect(await downloadJobs.retry([j])).toHaveLength(0);
    });

    it("lets the job fail again and tell the user of that outcome", async () => {
        const j = await job("dl_retry_again", {
            status: "failed",
            error: "boom",
            metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess", notificationSent: true },
        });
        await downloadJobs.retry([j]);
        await downloadJobs.fail([j], "boom again");
        expect(await notices("download_failed")).toBe(1);
    });
});

describe("mergeMetadata", () => {
    it("adds fields, clears a field set to null, and keeps the rest", async () => {
        const j = await job("dl_merge", { metadata: { a: 1, b: 2 } });
        await downloadJobs.mergeMetadata(j.id, { b: null, c: 3, d: undefined });
        expect(await meta(j.id)).toEqual({ a: 1, c: 3 });
    });
});
