/**
 * The download-job moves (start, complete, fail, cancel, retry) on the real test
 * database and Redis: each runs only from a state it can leave, so a settled job
 * is never settled again; each merges metadata instead of overwriting it; and each
 * tells the user (through the notification policy), the Discover batch and the
 * Spotify import.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../../../utils/db";
import * as downloadJobs from "../jobs";
import { connectJobOwners } from "../owners";
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
    connectJobOwners();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.userDiscoverConfig.deleteMany({ where: { userId: USER } });
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

    it("keeps the attempt count of a job that was retried, and counts a first start as attempt 1", async () => {
        const j = await job("dl_start_retried", { status: "failed", error: "boom", attempts: 3 });
        await downloadJobs.retry([j]);
        expect(await downloadJobs.start(j.id, { correlationId: "corr-r", lidarrAlbumId: 5, metadata: {} })).toBe(true);
        expect((await row(j.id)).attempts).toBe(3);

        await job("dl_start_first", { status: "pending", attempts: 0 });
        await downloadJobs.start("dl_start_first", { correlationId: "corr-f", lidarrAlbumId: 6, metadata: {} });
        expect((await row("dl_start_first")).attempts).toBe(1);
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
        await downloadJobs.whenIdle();

        expect((await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("scanning");
    });

    it("tells the import once for a job it settled, and not for one already settled", async () => {
        const { playlistImportService } = await import("../../playlistImport");
        const told = jest.spyOn(playlistImportService, "checkImportCompletion").mockResolvedValue();
        const j = await job("dl_done_import", {
            metadata: { spotifyImportJobId: "imp-1", artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" },
        });

        await downloadJobs.complete([j]);
        await downloadJobs.complete([j]);
        await downloadJobs.whenIdle();

        expect(told.mock.calls).toEqual([["imp-1"]]);
    });

    it("tells the batch and the import once each however many of their jobs it completes", async () => {
        const { playlistImportService } = await import("../../playlistImport");
        const { discoverWeeklyService } = await import("../../discoverWeekly");
        const importTold = jest.spyOn(playlistImportService, "checkImportCompletion").mockResolvedValue();
        const batchTold = jest.spyOn(discoverWeeklyService, "checkBatchCompletion").mockResolvedValue();
        const batch = await batchOf(2);
        const a = await job("dl_done_many_a", { discoveryBatchId: batch.id, metadata: { spotifyImportJobId: "imp-2" } });
        const b = await job("dl_done_many_b", { discoveryBatchId: batch.id, metadata: { spotifyImportJobId: "imp-2" } });

        await downloadJobs.complete([a, b]);
        await downloadJobs.whenIdle();

        expect(batchTold.mock.calls).toEqual([[batch.id]]);
        expect(importTold.mock.calls).toEqual([["imp-2"]]);
    });
});

describe("fail", () => {
    it("counts a job whose row is already gone as done, and still moves the others", async () => {
        const gone = await job("dl_fail_gone");
        const here = await job("dl_fail_here");
        await prisma.downloadJob.delete({ where: { id: gone.id } });

        const settled = await downloadJobs.fail([gone, here], "Import failed");

        expect(settled.map((s) => s.id)).toEqual([here.id]);
        expect((await row(here.id)).error).toBe("Import failed");
        expect(await downloadJobs.fail([gone], "Import failed")).toEqual([]);
    });

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
        await downloadJobs.whenIdle();

        expect((await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("failed");
    });

    it("tells the import, and not again for a job already failed", async () => {
        const { playlistImportService } = await import("../../playlistImport");
        const told = jest.spyOn(playlistImportService, "checkImportCompletion").mockResolvedValue();
        const j = await job("dl_fail_import", { metadata: { spotifyImportJobId: "imp-3" } });

        await downloadJobs.fail([j], "gone");
        await downloadJobs.fail([j], "gone again");
        await downloadJobs.whenIdle();

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

    it("counts a job whose row is already gone as done, and still moves the others", async () => {
        const gone = await job("dl_cancel_gone");
        const here = await job("dl_cancel_here");
        await prisma.downloadJob.delete({ where: { id: gone.id } });

        const settled = await downloadJobs.cancel([gone, here]);

        expect(settled.map((s) => s.id)).toEqual([here.id]);
        expect((await row(here.id)).status).toBe("failed");
        expect(await downloadJobs.cancel([gone])).toEqual([]);
    });

    it("tells the batch and the import", async () => {
        const { playlistImportService } = await import("../../playlistImport");
        const importTold = jest.spyOn(playlistImportService, "checkImportCompletion").mockResolvedValue();
        const batch = await batchOf(1);
        const j = await job("dl_cancel_told", { discoveryBatchId: batch.id, metadata: { spotifyImportJobId: "imp-4" } });

        await downloadJobs.cancel([j]);
        await downloadJobs.whenIdle();

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

describe("park", () => {
    it("parks a running job once, tells the user through the notification policy, and keeps the job running", async () => {
        const j = await job("dl_park", { metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess", keep: "me" } });
        const asked = jest.spyOn(notificationPolicyService, "evaluateNotification");

        const parked = await downloadJobs.park([j], "Tracks missing");

        expect(parked.map((p) => p.id)).toEqual([j.id]);
        expect(asked).toHaveBeenCalledWith(j.id, "parked");
        const r = await row(j.id);
        expect(r.status).toBe("processing");
        expect(await meta(j.id)).toMatchObject({ keep: "me", parked: "Tracks missing", statusText: "Waiting in Lidarr: Tracks missing" });
        expect(await notices("download_waiting")).toBe(1);
        expect(await meta(j.id)).not.toHaveProperty("notificationSent");
    });

    it("parks a job once, however many paths reach it at the same time", async () => {
        const j = await job("dl_park_race", { metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" } });
        const results = await Promise.all([
            downloadJobs.park([j], "Tracks missing"),
            downloadJobs.park([j], "Tracks missing"),
            downloadJobs.park([j], "Tracks missing"),
        ]);
        expect(results.flat()).toHaveLength(1);
        expect(await notices("download_waiting")).toBe(1);
    });

    it("leaves a job that is not running alone, and one the policy keeps quiet for gets no tray row", async () => {
        const pending = await job("dl_park_pending", { status: "pending" });
        expect(await downloadJobs.park([pending], "Tracks missing")).toHaveLength(0);
        expect(await meta(pending.id)).not.toHaveProperty("parked");

        const discover = await job("dl_park_discover", { metadata: { downloadType: "discovery" } });
        expect(await downloadJobs.park([discover], "Tracks missing")).toHaveLength(1);
        expect(await notices("download_waiting")).toBe(0);
    });

    it("lets a parked job tell the user when it completes", async () => {
        const j = await job("dl_park_then_done", { metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" } });
        await downloadJobs.park([j], "Tracks missing");
        await downloadJobs.complete([j]);
        expect(await notices("download_complete")).toBe(1);
    });
});

describe("park with no reason", () => {
    it("parks once and tells once, because the guard is whether the job is parked, not what the reason says", async () => {
        const j = await job("dl_park_blank", { metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" } });

        expect(await downloadJobs.park([j], "")).toHaveLength(1);
        expect(await downloadJobs.park([j], "")).toHaveLength(0);
        expect(await downloadJobs.park([j], "Tracks missing")).toHaveLength(0);

        expect(await notices("download_waiting")).toBe(1);
        expect(Boolean((await meta(j.id)).parked)).toBe(true);
    });
});

describe("create", () => {
    const input = { userId: USER, subject: "Brad Sucks - Guess Who’s a Mess", type: "album", targetMbid: "rg-create", metadata: { artistName: "Brad Sucks" } };

    it("opens a job pending, with the metadata it was given", async () => {
        const made = await downloadJobs.create(input);
        expect(await row(made.id)).toMatchObject({ status: "pending", attempts: 0, userId: USER, type: "album", targetMbid: "rg-create", startedAt: null });
        expect(await meta(made.id)).toEqual({ artistName: "Brad Sucks" });
    });

    it("opens a job processing when its download is already under way: attempt 1, started now", async () => {
        const made = await downloadJobs.create({ ...input, status: "processing", targetMbid: null });
        const r = await row(made.id);
        expect(r).toMatchObject({ status: "processing", attempts: 1 });
        expect(r.startedAt).toBeInstanceOf(Date);
    });

    it("opens a job inside the caller's transaction, so it is gone when the transaction rolls back", async () => {
        let id = "";
        await expect(
            prisma.$transaction(async (tx) => {
                id = (await downloadJobs.create(input, tx)).id;
                throw new Error("rollback");
            })
        ).rejects.toThrow("rollback");
        expect(await prisma.downloadJob.findUnique({ where: { id } })).toBeNull();
    });
});

describe("hold and resume", () => {
    it("holds a running job as pending in one write, with the metadata merged, and leaves a settled job alone", async () => {
        const running = await job("dl_hold_running", { metadata: { keep: "me", notificationSent: true } });
        const done = await job("dl_hold_done", { status: "completed" });

        const held = await downloadJobs.hold([running, done], { artistName: "Brad Sucks", albumTitle: "A Record" });

        expect(held.map((h) => h.id)).toEqual([running.id]);
        expect((await row(running.id)).status).toBe("pending");
        expect(await meta(running.id)).toMatchObject({
            keep: "me", notificationSent: true, artistName: "Brad Sucks", albumTitle: "A Record", waitingForLidarr: true, statusText: "Waiting for Lidarr",
        });
        expect((await row(done.id)).status).toBe("completed");
        expect(await meta(done.id)).not.toHaveProperty("waitingForLidarr");
    });

    it("resumes a held job once however many paths reach it, and a job that is not held not at all", async () => {
        const held = await job("dl_resume", { status: "pending", metadata: { waitingForLidarr: true, artistName: "Brad Sucks", keep: "me" } });
        const plain = await job("dl_resume_plain", { status: "pending" });

        const results = await Promise.all([downloadJobs.resume([held, plain]), downloadJobs.resume([held])]);

        const resumed = results.flat();
        expect(resumed.map((r) => r.id)).toEqual([held.id]);
        expect((resumed[0].metadata as any).artistName).toBe("Brad Sucks");
        const m = await meta(held.id);
        expect(m).toMatchObject({ keep: "me", artistName: "Brad Sucks" });
        expect(m).not.toHaveProperty("waitingForLidarr");
        expect(typeof m.pendingSince).toBe("string");
        expect((await row(held.id)).status).toBe("pending");
    });

    it("keeps what another path wrote between the read and the resume", async () => {
        const held = await job("dl_resume_keeps", { status: "pending", metadata: { waitingForLidarr: true } });
        await downloadJobs.mergeMetadata(held.id, { notificationSent: true });
        await downloadJobs.resume([held]);
        expect(await meta(held.id)).toMatchObject({ notificationSent: true });
    });
});

describe("grab", () => {
    const grab = { downloadId: "DL-1", lidarrAlbumId: 42, albumMbid: "rg-grab", bundle: false };

    it("takes Lidarr's download for the jobs waiting for it, dropping a park and keeping what else the metadata holds", async () => {
        const waiting = await job("dl_grab_waiting", { status: "pending", targetMbid: null, metadata: { keep: "me", parked: "Tracks missing", statusText: "Waiting in Lidarr: Tracks missing" } });
        const running = await job("dl_grab_running", { lidarrAlbumId: 7, metadata: { notificationSent: true } });

        const grabbed = await downloadJobs.grab([waiting, running], grab);

        expect(grabbed.map((g) => g.id).sort()).toEqual([running.id, waiting.id]);
        expect(await row(waiting.id)).toMatchObject({ status: "processing", lidarrRef: "DL-1", lidarrAlbumId: 42, targetMbid: "rg-grab" });
        const m = await meta(waiting.id);
        expect(m).toMatchObject({ keep: "me", downloadId: "DL-1", lidarrMbid: "rg-grab", grabbedAsBundle: false });
        expect(typeof m.grabbedAt).toBe("string");
        expect(m).not.toHaveProperty("parked");
        expect(m).not.toHaveProperty("statusText");
        expect(m).not.toHaveProperty("hadBundle");
        expect(await row(running.id)).toMatchObject({ lidarrRef: "DL-1", targetMbid: `rg-dl_grab_running`, lidarrAlbumId: 42 });
        expect(await meta(running.id)).toMatchObject({ notificationSent: true });
    });

    it("keeps the Lidarr album id a job has when the grab names none, and records a bundle for good", async () => {
        const j = await job("dl_grab_bundle", { lidarrAlbumId: 7 });
        await downloadJobs.grab([j], { ...grab, lidarrAlbumId: 0, bundle: true });
        expect((await row(j.id)).lidarrAlbumId).toBe(7);
        expect(await meta(j.id)).toMatchObject({ grabbedAsBundle: true, hadBundle: true });

        await prisma.downloadJob.update({ where: { id: j.id }, data: { lidarrRef: null } });
        await downloadJobs.grab([j], { ...grab, downloadId: "DL-2", bundle: false });
        expect(await meta(j.id)).toMatchObject({ downloadId: "DL-2", grabbedAsBundle: false, hadBundle: true });
    });

    it("leaves a settled job and a job that already has a download alone, and a job two paths grab is grabbed once", async () => {
        const done = await job("dl_grab_done", { status: "completed" });
        const taken = await job("dl_grab_taken", { lidarrRef: "DL-OLD" });
        expect(await downloadJobs.grab([done, taken], grab)).toHaveLength(0);
        expect((await row(done.id)).status).toBe("completed");
        expect((await row(taken.id)).lidarrRef).toBe("DL-OLD");

        const one = await job("dl_grab_once", { status: "pending" });
        const results = await Promise.all([downloadJobs.grab([one], grab), downloadJobs.grab([one], { ...grab, downloadId: "DL-2" })]);
        expect(results.flat()).toHaveLength(1);
    });

    it("does not bring back a job that was cancelled while the grab read it", async () => {
        const j = await job("dl_grab_cancelled", { status: "pending" });
        await downloadJobs.cancel([j]);
        expect(await downloadJobs.grab([j], grab)).toHaveLength(0);
        expect(await meta(j.id)).toMatchObject({ cancelled: true });
        expect((await row(j.id)).status).toBe("failed");
    });
});

describe("what the module says about a job", () => {
    it("tells a cancelled job from a failed one", async () => {
        const a = await job("dl_is_cancelled", { metadata: {} });
        const b = await job("dl_is_failed", { metadata: {} });
        const [cancelled] = await downloadJobs.cancel([a]);
        const [failed] = await downloadJobs.fail([b], "boom");
        expect(downloadJobs.isCancelled(cancelled)).toBe(true);
        expect(downloadJobs.isCancelled(failed)).toBe(false);
        expect(downloadJobs.isCancelled({ metadata: null })).toBe(false);
    });

    it("lists the statuses a job can have", () => {
        expect([...downloadJobs.JOB_STATUSES]).toEqual(["pending", "processing", "completed", "failed"]);
    });

    it("groups them as active, failed and settled, with every status in one of active or settled", () => {
        expect(downloadJobs.ACTIVE_STATUSES).toEqual(["pending", "processing"]);
        expect(downloadJobs.FAILED_STATUSES).toEqual(["failed"]);
        expect(downloadJobs.SETTLED_STATUSES).toEqual(["completed", "failed"]);
        expect([...downloadJobs.ACTIVE_STATUSES, ...downloadJobs.SETTLED_STATUSES].sort()).toEqual([...downloadJobs.JOB_STATUSES].sort());
    });
});

describe("releaseDownload", () => {
    it("moves a running job off the download it holds, onto the next, and records the old one once", async () => {
        await job("dl_release_ok", { lidarrRef: "old", metadata: { keep: "me", previousDownloadIds: ["older"] } });

        expect(await downloadJobs.releaseDownload("dl_release_ok", "old", "new")).toBe(true);
        expect(await downloadJobs.releaseDownload("dl_release_ok", "old", "new")).toBe(false);

        expect((await row("dl_release_ok")).lidarrRef).toBe("new");
        expect(await meta("dl_release_ok")).toMatchObject({ keep: "me", previousDownloadIds: ["older", "old"] });
    });

    it("lets a job go when no next download is given, and leaves one that holds another download alone", async () => {
        await job("dl_release_none", { lidarrRef: "old", metadata: {} });
        await job("dl_release_other", { lidarrRef: "other", metadata: {} });

        expect(await downloadJobs.releaseDownload("dl_release_none", "old")).toBe(true);
        expect(await downloadJobs.releaseDownload("dl_release_other", "old")).toBe(false);

        expect((await row("dl_release_none")).lidarrRef).toBeNull();
        expect((await row("dl_release_other")).lidarrRef).toBe("other");
    });
});

describe("noteArtist", () => {
    it("records the artist on a job that has none and keeps one it has", async () => {
        await job("dl_artist_new", { artistMbid: null });
        await job("dl_artist_old", { artistMbid: "first" });

        await downloadJobs.noteArtist("dl_artist_new", "mbid-a");
        await downloadJobs.noteArtist("dl_artist_old", "mbid-b");

        expect((await row("dl_artist_new")).artistMbid).toBe("mbid-a");
        expect((await row("dl_artist_old")).artistMbid).toBe("first");
    });
});

describe("countFailedRelease", () => {
    const counted = { downloadId: "dl-1", reason: "no tracks in the download" };
    const of = async (id: string) => {
        const { userId } = await row(id);
        return { id, userId };
    };

    it("counts a failed release against a running job, merging what a webhook wrote meanwhile", async () => {
        await job("dl_count_ok", { lidarrRef: "dl-1", attempts: 1, metadata: { searchCommandId: 4, parked: "tracks missing", keep: "me", previousDownloadIds: ["older"] } });

        const result = await downloadJobs.countFailedRelease(await of("dl_count_ok"), counted);

        expect(result).toMatchObject({ attempts: 2, exhausted: false, counted: true });
        expect(await row("dl_count_ok")).toMatchObject({ status: "processing", lidarrRef: null, attempts: 2 });
        const m = await meta("dl_count_ok");
        expect(m).toMatchObject({ keep: "me", searchCommandId: 4, lastError: counted.reason, previousDownloadIds: ["older", "dl-1"], statusText: "Lidarr #2" });
        expect(m.parked).toBeUndefined();
        expect(typeof m.startedAt).toBe("string");
        expect(result?.metadata).toMatchObject({ statusText: "Lidarr #2" });
    });

    it("keeps the attempt count and the start time of a job that has used its releases, and says so", async () => {
        await job("dl_count_last", { lidarrRef: "dl-1", attempts: 3, metadata: { startedAt: "2026-11-01T00:00:00.000Z" } });

        const result = await downloadJobs.countFailedRelease(await of("dl_count_last"), counted);

        expect(result).toMatchObject({ attempts: 3, exhausted: true, counted: true });
        expect(await row("dl_count_last")).toMatchObject({ attempts: 3, lidarrRef: null });
        expect(await meta("dl_count_last")).toMatchObject({ startedAt: "2026-11-01T00:00:00.000Z", statusText: "Lidarr #3", lastError: counted.reason });
    });

    it("takes the limit from the person's own setting, three when they have none", async () => {
        await prisma.userDiscoverConfig.create({ data: { userId: USER, maxRetryAttempts: 5 } });
        await job("dl_count_own_limit", { lidarrRef: "dl-1", attempts: 3, metadata: {} });
        await job("dl_count_own_limit_last", { lidarrRef: "dl-1", attempts: 5, metadata: {} });

        expect(await downloadJobs.countFailedRelease(await of("dl_count_own_limit"), counted)).toMatchObject({ attempts: 4, exhausted: false });
        expect(await downloadJobs.countFailedRelease(await of("dl_count_own_limit_last"), counted)).toMatchObject({ attempts: 5, exhausted: true });
        await prisma.userDiscoverConfig.deleteMany({ where: { userId: USER } });
    });

    it("counts a release once, however many times Lidarr reports it, and the job goes on being tried", async () => {
        await job("dl_count_twice", { lidarrRef: "dl-1", attempts: 2, metadata: {} });

        expect(await downloadJobs.countFailedRelease(await of("dl_count_twice"), counted)).toMatchObject({ attempts: 3, counted: true });
        const again = await downloadJobs.countFailedRelease(await of("dl_count_twice"), counted);

        expect(again).toMatchObject({ attempts: 3, exhausted: false, counted: false });
        expect(await row("dl_count_twice")).toMatchObject({ attempts: 3 });
        expect((await meta("dl_count_twice")).previousDownloadIds).toEqual(["dl-1"]);
    });

    it("lets only one of two releases failing at once take the last attempt", async () => {
        await job("dl_count_race", { lidarrRef: "dl-1", attempts: 2, metadata: {} });
        const target = await of("dl_count_race");

        const results = await Promise.all([
            downloadJobs.countFailedRelease(target, { downloadId: "dl-a", reason: "a" }),
            downloadJobs.countFailedRelease(target, { downloadId: "dl-b", reason: "b" }),
        ]);

        expect(results.map((r) => r?.exhausted).sort()).toEqual([false, true]);
        expect(await row("dl_count_race")).toMatchObject({ attempts: 3 });
        expect((await meta("dl_count_race")).previousDownloadIds).toHaveLength(2);
    });

    it("leaves a job that is not running alone", async () => {
        await job("dl_count_settled", { status: "failed", attempts: 2, metadata: { keep: "me" } });

        expect(await downloadJobs.countFailedRelease(await of("dl_count_settled"), counted)).toBeNull();

        expect(await row("dl_count_settled")).toMatchObject({ status: "failed", attempts: 2 });
        expect(await meta("dl_count_settled")).toEqual({ keep: "me" });
    });

    it("writes inside the caller's transaction", async () => {
        await job("dl_count_tx", { lidarrRef: "dl-1", attempts: 1, metadata: {} });
        const asRead = await of("dl_count_tx");

        await expect(
            prisma.$transaction(async (tx) => {
                await downloadJobs.countFailedRelease(asRead, counted, tx);
                throw new Error("roll back");
            })
        ).rejects.toThrow("roll back");

        expect(await row("dl_count_tx")).toMatchObject({ attempts: 1, lidarrRef: "dl-1" });
    });
});

describe("job statuses", () => {
    it("names each status once, in the group or groups the readers ask about", () => {
        const groups = (status: string) => ({
            active: downloadJobs.isActive(status),
            failed: downloadJobs.isFailed(status),
            settled: downloadJobs.isSettled(status),
            completed: downloadJobs.isCompleted(status),
        });

        expect([...downloadJobs.JOB_STATUSES]).toEqual(["pending", "processing", "completed", "failed"]);
        expect(groups("pending")).toEqual({ active: true, failed: false, settled: false, completed: false });
        expect(groups("processing")).toEqual({ active: true, failed: false, settled: false, completed: false });
        expect(groups("completed")).toEqual({ active: false, failed: false, settled: true, completed: true });
        expect(groups("failed")).toEqual({ active: false, failed: true, settled: true, completed: false });
        expect(groups("exhausted")).toEqual({ active: false, failed: false, settled: false, completed: false });
    });

    it("keeps the groups the database filters on in step with the predicates", () => {
        for (const status of downloadJobs.JOB_STATUSES) {
            expect(downloadJobs.ACTIVE_STATUSES.includes(status)).toBe(downloadJobs.isActive(status));
            expect(downloadJobs.FAILED_STATUSES.includes(status)).toBe(downloadJobs.isFailed(status));
            expect(downloadJobs.SETTLED_STATUSES.includes(status)).toBe(downloadJobs.isSettled(status));
            expect(downloadJobs.isActive(status) !== downloadJobs.isSettled(status)).toBe(true);
        }
    });

    it("tells a status from any other string", () => {
        expect(downloadJobs.isJobStatus("failed")).toBe(true);
        expect(downloadJobs.isJobStatus("exhausted")).toBe(false);
        expect(downloadJobs.isJobStatus("")).toBe(false);
    });
});

describe("findRetryable", () => {
    it("finds the person's own failed job and nothing else", async () => {
        await job("dl_find_failed", { status: "failed" });
        await job("dl_find_running", { status: "processing", targetMbid: "rg-other" });
        await job("dl_find_done", { status: "completed", targetMbid: "rg-done" });

        expect(await downloadJobs.findRetryable(USER, "dl_find_failed")).toMatchObject({ id: "dl_find_failed" });
        expect(await downloadJobs.findRetryable("someone-else", "dl_find_failed")).toBeNull();
        expect(await downloadJobs.findRetryable(USER, "dl_find_running")).toBeNull();
        expect(await downloadJobs.findRetryable(USER, "dl_find_done")).toBeNull();
        expect(await downloadJobs.findRetryable(USER, "dl_find_nothing")).toBeNull();
    });
});

describe("planRetry", () => {
    const plan = (data: { subject?: string; targetMbid?: string | null; metadata?: Prisma.JsonObject | null }) =>
        downloadJobs.planRetry({ subject: "Low - Sunflower", targetMbid: "rg-1", metadata: null, ...data });

    it("sends a retry of a playlist's pending song back to that song", () => {
        expect(plan({ metadata: { downloadType: "pending-track-retry", playlistId: "pl", pendingTrackId: "pt" } })).toEqual({
            kind: "pending-track", playlistId: "pl", pendingTrackId: "pt",
        });
    });

    it("refuses a pending song's retry that does not say which song", () => {
        expect(plan({ metadata: { downloadType: "pending-track-retry", playlistId: "pl" } })).toEqual({
            refused: "Cannot retry: missing playlistId or pendingTrackId",
        });
    });

    it("reads a Spotify import album's names from its record, and its album id when it has a real one", () => {
        const metadata = { downloadType: "spotify_import", artistName: "Low", albumTitle: "Secret Name" };
        expect(plan({ metadata })).toEqual({ kind: "import", artistName: "Low", albumTitle: "Secret Name", targetMbid: "rg-1" });
        expect(plan({ metadata, targetMbid: `${downloadJobs.NO_ALBUM_ID}123` })).toMatchObject({ kind: "import", targetMbid: null });
        expect(plan({ metadata, targetMbid: null })).toMatchObject({ kind: "import", targetMbid: null });
    });

    it("refuses a Spotify import album that lost its names", () => {
        expect(plan({ metadata: { downloadType: "spotify_import", artistName: "Low" } })).toEqual({
            refused: "Cannot retry: missing artist/album info",
        });
    });

    it("takes a library album's names from its record, then from its subject, splitting at the first ' - '", () => {
        expect(plan({ metadata: { artistName: "Godspeed You! Black Emperor - Live", albumTitle: "Slow Riot" } })).toEqual({
            kind: "album", targetMbid: "rg-1", artistName: "Godspeed You! Black Emperor - Live", albumTitle: "Slow Riot",
        });
        expect(plan({ subject: "Low - Things We Lost - Remastered" })).toMatchObject({
            artistName: "Low", albumTitle: "Things We Lost - Remastered",
        });
        expect(plan({ subject: "Just A Name" })).toMatchObject({ artistName: "Just A Name", albumTitle: "Just A Name" });
    });

    it("refuses a library album with no album id", () => {
        expect(plan({ targetMbid: null })).toEqual({ refused: "Cannot retry: missing album MBID" });
        expect(plan({ targetMbid: "" })).toEqual({ refused: "Cannot retry: missing album MBID" });
    });
});

describe("retryAlbum", () => {
    const albumPlanOf = (failed: Parameters<typeof downloadJobs.planRetry>[0]) => {
        const plan = downloadJobs.planRetry(failed);
        if (!("kind" in plan) || plan.kind === "pending-track") throw new Error("expected an album plan");
        return plan;
    };

    it("makes a pending copy of a failed library job, without the marks of its failure", async () => {
        const failed = await job("dl_ra_lib", {
            status: "failed", targetMbid: "rg-ra", artistMbid: "ar-1",
            metadata: { downloadType: "library", artistName: "Low", albumTitle: "Secret Name", notificationSent: true, failedAt: "2026-01-01T00:00:00.000Z", statusText: "old", keep: "me" },
        });

        const outcome = await downloadJobs.retryAlbum(failed, albumPlanOf(failed));

        expect(outcome).toHaveProperty("replacement");
        const made = (outcome as { replacement: { id: string } }).replacement;
        expect(await row(made.id)).toMatchObject({ status: "pending", type: "album", targetMbid: "rg-ra", artistMbid: "ar-1", subject: failed.subject });
        const m = await meta(made.id);
        expect(m).toMatchObject({ keep: "me", artistName: "Low" });
        expect(m.notificationSent).toBeUndefined();
        expect(m.failedAt).toBeUndefined();
        expect((await row(failed.id)).cleared).toBe(true);
    });

    it("makes a running copy of a failed Spotify import album, marked as a retry, under a placeholder id when it had none", async () => {
        const failed = await job("dl_ra_import", {
            status: "failed", targetMbid: null,
            metadata: { downloadType: "spotify_import", artistName: "Low", albumTitle: "Secret Name", spotifyImportJobId: "imp", notificationSent: true },
        });

        const outcome = await downloadJobs.retryAlbum(failed, albumPlanOf(failed));

        const made = await row((outcome as { replacement: { id: string } }).replacement.id);
        expect(made).toMatchObject({ status: "processing", subject: "Low - Secret Name", attempts: 1 });
        expect(made.targetMbid?.startsWith(downloadJobs.NO_ALBUM_ID)).toBe(true);
        expect(made.metadata).toMatchObject({ retryAttempt: true, spotifyImportJobId: "imp" });
        expect((made.metadata as any).notificationSent).toBeUndefined();
    });

    it("gives each placeholder id of a Spotify import retry its own value, even within one millisecond", async () => {
        const meta = { downloadType: "spotify_import", artistName: "Low", albumTitle: "Secret Name", spotifyImportJobId: "imp" };
        const first = await job("dl_ra_ph1", { status: "failed", targetMbid: null, metadata: meta });
        const second = await job("dl_ra_ph2", { status: "failed", targetMbid: null, metadata: { ...meta, albumTitle: "Other Name" } });
        const now = jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
        try {
            const a = await downloadJobs.retryAlbum(first, albumPlanOf(first));
            const b = await downloadJobs.retryAlbum(second, albumPlanOf(second));
            expect(a).toHaveProperty("replacement");
            expect(b).toHaveProperty("replacement");
            const ids = [a, b].map((o) => (o as { replacement: { targetMbid: string } }).replacement.targetMbid);
            expect(new Set(ids).size).toBe(2);
        } finally {
            now.mockRestore();
        }
    });

    it("answers the job already downloading the album when a failed job is retried twice", async () => {
        const failed = await job("dl_ra_twice", { status: "failed", targetMbid: "rg-twice", metadata: {} });
        const plan = albumPlanOf(failed);

        expect(await downloadJobs.retryAlbum(failed, plan)).toHaveProperty("replacement");
        expect(await downloadJobs.retryAlbum(failed, plan)).toHaveProperty("running");
        expect(await prisma.downloadJob.count({ where: { userId: USER, status: { in: ["pending", "processing"] } } })).toBe(1);
    });

    it.each([
        ["library album", "dl_ra_rollback_lib", {}],
        ["Spotify import album", "dl_ra_rollback_imp", { downloadType: "spotify_import", artistName: "Low", albumTitle: "Secret Name" }],
    ])("leaves the failed %s job on the list when its replacement cannot be created", async (_name, id, metadata) => {
        const failed = await job(id, { status: "failed", targetMbid: `rg-${id}`, metadata });
        // A batch that does not exist makes the replacement's insert fail.
        const broken = { ...failed, discoveryBatchId: "no-such-batch" };

        await expect(downloadJobs.retryAlbum(broken, albumPlanOf(failed))).rejects.toThrow();

        expect(await prisma.downloadJob.findMany({ where: { userId: USER } })).toMatchObject([{ id, status: "failed", cleared: false }]);
    });
});

describe("recentlyFailed", () => {
    const key = { userId: USER, type: "album", targetMbid: "rg-recent" };

    it("is true for an album that failed in the last 30 seconds, and false for one that failed earlier", async () => {
        await job("dl_recent_new", { status: "failed", targetMbid: "rg-recent", completedAt: new Date(Date.now() - 5_000) });
        expect(await prisma.$transaction((tx) => downloadJobs.recentlyFailed(key, tx))).toBe(true);

        await prisma.downloadJob.update({ where: { id: "dl_recent_new" }, data: { completedAt: new Date(Date.now() - 120_000) } });
        expect(await prisma.$transaction((tx) => downloadJobs.recentlyFailed(key, tx))).toBe(false);
    });

    it("looks at the person's own library job of that album only", async () => {
        const recent = { status: "failed", targetMbid: "rg-recent", completedAt: new Date() };
        const week = await batchOf(1);
        await job("dl_recent_batch", { ...recent, discoveryBatchId: week.id });
        await job("dl_recent_track", { ...recent, type: "track" });
        await job("dl_recent_running", { status: "processing", targetMbid: "rg-recent", completedAt: new Date() });

        expect(await prisma.$transaction((tx) => downloadJobs.recentlyFailed(key, tx))).toBe(false);
        expect(await prisma.$transaction((tx) => downloadJobs.recentlyFailed({ ...key, userId: "someone-else" }, tx))).toBe(false);
    });
});

describe("telling the user", () => {
    it("tells once when two settlers of the same job both pass the policy before either has told", async () => {
        const j = await job("dl_claim", { metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" } });
        const real = notificationPolicyService.evaluateNotification.bind(notificationPolicyService);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let calls = 0;
        jest.spyOn(notificationPolicyService, "evaluateNotification").mockImplementation(async (id, event) => {
            const decision = await real(id, event);
            if (++calls === 1) await gate;
            return decision;
        });

        const first = downloadJobs.fail([j], "boom");
        while (calls < 1) await new Promise((r) => setTimeout(r, 10));
        await downloadJobs.retry([j]);
        await downloadJobs.complete([j]);
        release();
        await first;

        expect((await notices("download_complete")) + (await notices("download_failed"))).toBe(1);
    });

    it("gives the claim back when the tray row cannot be made, so a later settler can tell", async () => {
        const j = await job("dl_claim_back", { metadata: { artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" } });
        const { notificationService } = await import("../../notificationService");
        jest.spyOn(notificationService, "notifyDownloadFailed").mockRejectedValueOnce(new Error("tray down"));

        await downloadJobs.fail([j], "boom");
        expect(await meta(j.id)).not.toHaveProperty("notificationSent");

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

describe("settling answers promptly", () => {
    it("returns before the batch's completion check ends, and the check still runs", async () => {
        const { discoverWeeklyService } = await import("../../discoverWeekly");
        let release!: () => void;
        const checking = new Promise<void>((resolve) => (release = resolve));
        const check = jest.spyOn(discoverWeeklyService, "checkBatchCompletion").mockReturnValue(checking);
        const batch = await batchOf(1);
        const j = await job("dl_prompt_batch", { discoveryBatchId: batch.id });

        const settled = await downloadJobs.fail([j], "gone");

        expect(settled).toHaveLength(1);
        let idle = false;
        const waiting = downloadJobs.whenIdle().then(() => (idle = true));
        await new Promise((r) => setTimeout(r, 50));
        expect(check.mock.calls).toEqual([[batch.id]]);
        expect(idle).toBe(false);
        release();
        await waiting;
        expect(idle).toBe(true);
    });

    it("stops waiting for a check that is still running after the time it is given", async () => {
        const { discoverWeeklyService } = await import("../../discoverWeekly");
        let release!: () => void;
        const checking = new Promise<void>((resolve) => (release = resolve));
        jest.spyOn(discoverWeeklyService, "checkBatchCompletion").mockReturnValue(checking);
        const batch = await batchOf(1);
        const j = await job("dl_prompt_capped", { discoveryBatchId: batch.id });
        await downloadJobs.fail([j], "gone");

        const started = Date.now();
        await downloadJobs.whenIdle(80);

        expect(Date.now() - started).toBeLessThan(2000);
        release();
        await downloadJobs.whenIdle();
    });

    it("returns before the import's completion check ends", async () => {
        const { playlistImportService } = await import("../../playlistImport");
        let release!: () => void;
        const checking = new Promise<void>((resolve) => (release = resolve));
        const check = jest.spyOn(playlistImportService, "checkImportCompletion").mockReturnValue(checking);
        const j = await job("dl_prompt_import", { metadata: { spotifyImportJobId: "imp-9" } });

        await downloadJobs.complete([j]);

        await new Promise((r) => setTimeout(r, 50));
        expect(check.mock.calls).toEqual([["imp-9"]]);
        release();
        await downloadJobs.whenIdle();
    });

    it("whenIdle also waits for a move that has written the job but is still telling the user, and for the check that follows", async () => {
        const { playlistImportService } = await import("../../playlistImport");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let reached!: () => void;
        const writing = new Promise<void>((resolve) => (reached = resolve));
        // A Spotify import's job tells the user nothing, but the policy is still asked: the move waits there.
        const evaluate = notificationPolicyService.evaluateNotification.bind(notificationPolicyService);
        jest.spyOn(notificationPolicyService, "evaluateNotification").mockImplementation(async (...args) => {
            reached();
            await gate;
            return evaluate(...args);
        });
        const told = jest.spyOn(playlistImportService, "checkImportCompletion").mockResolvedValue();
        const j = await job("dl_idle_move", { metadata: { spotifyImportJobId: "imp-idle", artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" } });

        const move = downloadJobs.complete([j]);
        // The job is completed in the database and the move is held in the middle of telling the user.
        await writing;
        expect((await row(j.id)).status).toBe("completed");
        expect(told).not.toHaveBeenCalled();

        const idle = downloadJobs.whenIdle();
        release();
        await idle;

        expect(told.mock.calls).toEqual([["imp-idle"]]);
        await move;
    });

    it("logs a check that throws, and the move has still settled the job", async () => {
        const { discoverWeeklyService } = await import("../../discoverWeekly");
        const { logger } = await import("../../../utils/logger");
        jest.spyOn(discoverWeeklyService, "checkBatchCompletion").mockRejectedValue(new Error("scan queue down"));
        const logged = jest.spyOn(logger, "error").mockImplementation(() => undefined);
        const batch = await batchOf(1);
        const j = await job("dl_prompt_throws", { discoveryBatchId: batch.id });

        await expect(downloadJobs.fail([j], "gone")).resolves.toHaveLength(1);
        await downloadJobs.whenIdle();

        expect((await row(j.id)).status).toBe("failed");
        expect(logged).toHaveBeenCalledWith(expect.stringContaining(batch.id), expect.any(Error));
    });
});

describe("the owner of a settled job", () => {
    // Each case registers its own check for the owner it settles a job of, and puts the server's back after.
    afterEach(() => connectJobOwners());

    it("is told through the check registered for its kind, and the job's module imports no owner", async () => {
        const batches: string[] = [];
        const imports: string[] = [];
        downloadJobs.onOwnerSettled("discoverBatch", async (id) => void batches.push(id));
        downloadJobs.onOwnerSettled("import", async (id) => void imports.push(id));
        const batch = await batchOf(1);
        const a = await job("dl_owner_batch", { discoveryBatchId: batch.id });
        const b = await job("dl_owner_import", { metadata: { spotifyImportJobId: "imp-owner" } });

        await downloadJobs.complete([a, b]);
        await downloadJobs.whenIdle();

        expect(batches).toEqual([batch.id]);
        expect(imports).toEqual(["imp-owner"]);
    });

    it("replaces an earlier check of the same kind", async () => {
        const first = jest.fn(async () => undefined);
        const second = jest.fn(async () => undefined);
        downloadJobs.onOwnerSettled("import", first);
        downloadJobs.onOwnerSettled("import", second);
        const j = await job("dl_owner_replaced", { metadata: { spotifyImportJobId: "imp-replaced" } });

        await downloadJobs.fail([j], "gone");
        await downloadJobs.whenIdle();

        expect(first).not.toHaveBeenCalled();
        expect(second.mock.calls).toEqual([["imp-replaced"]]);
    });

    it("with no check registered, is logged as not told, and the job still settles", async () => {
        downloadJobs.onOwnerSettled("discoverBatch", async () => undefined)();
        const { logger } = await import("../../../utils/logger");
        const logged = jest.spyOn(logger, "error").mockImplementation(() => undefined);
        const batch = await batchOf(1);
        const j = await job("dl_owner_missing", { discoveryBatchId: batch.id });

        await expect(downloadJobs.fail([j], "gone")).resolves.toHaveLength(1);
        await downloadJobs.whenIdle();

        expect((await row(j.id)).status).toBe("failed");
        expect(logged).toHaveBeenCalledWith(expect.stringContaining(batch.id));
    });
});

describe("withoutFailureMarks", () => {
    it("drops the marks of a failure and keeps the rest", () => {
        expect(
            downloadJobs.withoutFailureMarks({
                artistName: "Brad Sucks", notificationSent: true, failedAt: "t", cancelled: true, parked: "x", statusText: "boom",
            })
        ).toEqual({ artistName: "Brad Sucks" });
        expect(downloadJobs.withoutFailureMarks(null)).toEqual({});
    });

    it("names the marks retry clears, so a retried job and a copy of a failed one carry the same", async () => {
        const marks = { notificationSent: true, failedAt: "t", cancelled: true, parked: "x", statusText: "boom" };
        const j = await job("dl_marks", { status: "failed", metadata: { artistName: "Brad Sucks", ...marks } });

        await downloadJobs.retry([j]);

        const kept = await meta(j.id);
        expect(kept).toMatchObject({ artistName: "Brad Sucks", statusText: "Retrying" });
        for (const mark of downloadJobs.FAILURE_MARKS) {
            if (mark !== "statusText") expect(kept).not.toHaveProperty(mark);
        }
    });
});

describe("findActive asks what the active-album index enforces", () => {
    const key = (data: Record<string, unknown> = {}) => ({
        userId: USER, type: "album", targetMbid: "rg-same", discoveryBatchId: null as string | null, ...data,
    });

    it("finds a running job of the album even when it was dismissed from the list", async () => {
        const running = await job("dl_find_cleared", { targetMbid: "rg-same", cleared: true });

        expect((await downloadJobs.findActive(key()))?.id).toBe(running.id);
    });

    it("finds a pending job and ignores a settled one", async () => {
        await job("dl_find_done", { targetMbid: "rg-same", status: "completed" });
        await job("dl_find_failed", { targetMbid: "rg-same", status: "failed" });
        expect(await downloadJobs.findActive(key())).toBeNull();

        const pending = await job("dl_find_pending", { targetMbid: "rg-same", status: "pending" });
        expect((await downloadJobs.findActive(key()))?.id).toBe(pending.id);
    });

    it("keeps a track job, a job of another type, and another person's job apart from the album's", async () => {
        await job("dl_find_track", { targetMbid: "rg-same", type: "track" });
        await prisma.user.deleteMany({ where: { id: "dl_jobs_other" } });
        await prisma.user.create({ data: { id: "dl_jobs_other", username: "dl_jobs_other", passwordHash: "x", role: "user", tokenVersion: 0 } });
        await job("dl_find_other_user", { targetMbid: "rg-same", userId: "dl_jobs_other" });

        expect(await downloadJobs.findActive(key())).toBeNull();
        expect((await downloadJobs.findActive(key({ type: "track" })))?.id).toBe("dl_find_track");
        await prisma.user.deleteMany({ where: { id: "dl_jobs_other" } });
    });

    it("keeps a Discover batch's job apart from a library job, and one batch's from another's", async () => {
        const week = await batchOf(1);
        const other = await prisma.discoveryBatch.create({
            data: { userId: USER, weekStart: new Date("2026-10-19T00:00:00.000Z"), targetSongCount: 1, totalAlbums: 1, status: "downloading" },
        });
        const inBatch = await job("dl_find_batch", { targetMbid: "rg-same", discoveryBatchId: week.id });

        expect(await downloadJobs.findActive(key())).toBeNull();
        expect(await downloadJobs.findActive(key({ discoveryBatchId: other.id }))).toBeNull();
        expect((await downloadJobs.findActive(key({ discoveryBatchId: week.id })))?.id).toBe(inBatch.id);

        const library = await job("dl_find_library", { targetMbid: "rg-same" });
        expect((await downloadJobs.findActive(key()))?.id).toBe(library.id);
    });

    it("sees the job the index would collide with", async () => {
        await job("dl_find_collide", { targetMbid: "rg-same", cleared: true });

        expect(await downloadJobs.findActive(key())).not.toBeNull();
        await expect(job("dl_find_collide2", { targetMbid: "rg-same" })).rejects.toMatchObject({ code: "P2002" });
    });
});

describe("dismiss takes a settled job off the list and leaves a running one", () => {
    it.each(["completed", "failed"])("dismisses a %s job", async (status) => {
        const j = await job(`dl_dismiss_${status}`, { status });

        expect(await downloadJobs.dismiss(USER, j.id)).toBe("dismissed");
        expect((await row(j.id)).cleared).toBe(true);
    });

    it.each(["pending", "processing"])("refuses a %s job and leaves it untouched", async (status) => {
        const j = await job(`dl_dismiss_${status}`, { status });

        expect(await downloadJobs.dismiss(USER, j.id)).toBe("running");
        expect((await row(j.id)).cleared).toBe(false);
    });

    it("answers missing for a job that is not there or is another person's", async () => {
        const j = await job("dl_dismiss_other", { status: "failed" });

        expect(await downloadJobs.dismiss("someone-else", j.id)).toBe("missing");
        expect(await downloadJobs.dismiss(USER, "dl_dismiss_nothing")).toBe("missing");
        expect((await row(j.id)).cleared).toBe(false);
    });

    it("dismisses every settled job of the person in bulk and no running one", async () => {
        const done = await job("dl_bulk_done", { status: "completed" });
        const failed = await job("dl_bulk_failed", { status: "failed", targetMbid: "rg-b" });
        const running = await job("dl_bulk_running", { status: "processing", targetMbid: "rg-c" });
        const pending = await job("dl_bulk_pending", { status: "pending", targetMbid: "rg-d" });

        expect(await downloadJobs.dismissAllSettled(USER)).toBe(2);

        expect((await row(done.id)).cleared).toBe(true);
        expect((await row(failed.id)).cleared).toBe(true);
        expect((await row(running.id)).cleared).toBe(false);
        expect((await row(pending.id)).cleared).toBe(false);
    });
});

describe("retryOnce", () => {
    const album = { type: "album", targetMbid: "rg-retry" };
    const replacement = (tx: Parameters<typeof downloadJobs.create>[1], data: Record<string, unknown> = {}) =>
        downloadJobs.create({ userId: USER, subject: "x", type: "album", targetMbid: "rg-retry", status: "pending", ...data }, tx);

    it("clears the failed job and makes the replacement in one go", async () => {
        const failed = await job("dl_ro_failed", { status: "failed", targetMbid: "rg-retry" });

        const outcome = await downloadJobs.retryOnce(failed, album, (tx) => replacement(tx));

        expect(outcome).toHaveProperty("replacement");
        expect((await row(failed.id)).cleared).toBe(true);
        expect(await prisma.downloadJob.count({ where: { userId: USER, status: "pending" } })).toBe(1);
    });

    it("answers with the running job, even a dismissed one, clears the failed job and creates nothing", async () => {
        const failed = await job("dl_ro_failed2", { status: "failed", targetMbid: "rg-retry" });
        const running = await job("dl_ro_running", { status: "processing", targetMbid: "rg-retry", cleared: true });
        const make = jest.fn();

        const outcome = await downloadJobs.retryOnce(failed, album, make);

        expect(outcome).toEqual({ running: expect.objectContaining({ id: running.id }) });
        expect(make).not.toHaveBeenCalled();
        expect((await row(failed.id)).cleared).toBe(true);
    });

    it("looks for the failed job's own Discover batch, so another batch's running job does not stand in", async () => {
        const week = await batchOf(1);
        const failed = await job("dl_ro_batch_failed", { status: "failed", targetMbid: "rg-retry", discoveryBatchId: week.id });
        await job("dl_ro_library_running", { status: "processing", targetMbid: "rg-retry" });

        const outcome = await downloadJobs.retryOnce(failed, album, (tx) =>
            replacement(tx, { discoveryBatchId: failed.discoveryBatchId })
        );

        expect(outcome).toHaveProperty("replacement");
        const made = (outcome as { replacement: { discoveryBatchId: string | null } }).replacement;
        expect(made.discoveryBatchId).toBe(week.id);
    });

    it("answers already retried, and makes nothing, when another retry cleared the failed job and nothing is running", async () => {
        const failed = await job("dl_ro_cleared", { status: "failed", cleared: true });
        const make = jest.fn();

        expect(await downloadJobs.retryOnce(failed, null, make)).toEqual({ alreadyRetried: true });
        expect(await downloadJobs.retryOnce(failed, album, make)).toEqual({ alreadyRetried: true });
        expect(make).not.toHaveBeenCalled();
    });

    it("answers the running job when the insert meets another retry's, without a second try to create", async () => {
        const failed = await job("dl_ro_race_failed", { status: "failed", targetMbid: "rg-retry" });
        let winner: { id: string } | undefined;
        // The other retry commits its job between our lookup and our insert, so the insert meets the unique index.
        const make = jest.fn(async (tx: Parameters<typeof downloadJobs.create>[1]) => {
            winner = await job("dl_ro_race_winner", { status: "processing", targetMbid: "rg-retry" });
            return replacement(tx);
        });

        const outcome = await downloadJobs.retryOnce(failed, album, make);

        expect(outcome).toEqual({ running: expect.objectContaining({ id: winner!.id }) });
        expect(make).toHaveBeenCalledTimes(1);
        expect((await row(failed.id)).cleared).toBe(true);
        expect(await prisma.downloadJob.count({ where: { userId: USER, status: { in: ["pending", "processing"] } } })).toBe(1);
    });

    it("leaves the failed job on the list when the insert meets a job that has ended since", async () => {
        const failed = await job("dl_ro_race_ended", { status: "failed", targetMbid: "rg-retry" });
        const make = jest.fn(async (tx: Parameters<typeof downloadJobs.create>[1]) => {
            const winner = await job("dl_ro_race_ended_winner", { status: "processing", targetMbid: "rg-retry" });
            try {
                return await replacement(tx);
            } finally {
                await prisma.downloadJob.update({ where: { id: winner.id }, data: { status: "completed" } });
            }
        });

        expect(await downloadJobs.retryOnce(failed, album, make)).toEqual({ alreadyRetried: true });
        expect((await row(failed.id)).cleared).toBe(false);
    });
});

describe("a track job has one active job per song, as an album has", () => {
    const input = (data: Record<string, unknown> = {}) => ({
        userId: USER, subject: "Low - Sunflower", type: "track", targetMbid: "pendingTrack:one", status: "processing" as const, ...data,
    });

    it("refuses a second active job of the same song for the same person and Discover batch", async () => {
        await downloadJobs.create(input());

        await expect(downloadJobs.create(input())).rejects.toMatchObject({ code: "P2002" });
    });

    it("allows a new job once the first has settled, and a job of another song or batch", async () => {
        const first = await downloadJobs.create(input());
        const week = await batchOf(1);
        await downloadJobs.create(input({ targetMbid: "pendingTrack:two" }));
        await downloadJobs.create(input({ discoveryBatchId: week.id }));
        await downloadJobs.fail([first], "gone");

        await expect(downloadJobs.create(input())).resolves.toMatchObject({ status: "processing" });
    });
});

describe("createOnce", () => {
    const input = (data: Record<string, unknown> = {}) => ({
        userId: USER, subject: "Low - Sunflower", type: "track", targetMbid: "pendingTrack:once", status: "processing" as const, ...data,
    });

    it("opens the job when none of the song is running", async () => {
        const outcome = await downloadJobs.createOnce(input());

        expect(outcome).toEqual({ created: expect.objectContaining({ status: "processing", targetMbid: "pendingTrack:once" }) });
    });

    it("answers the running job, dismissed or not, and creates nothing", async () => {
        const running = await job("dl_once_running", { type: "track", targetMbid: "pendingTrack:once", cleared: true });

        expect(await downloadJobs.createOnce(input())).toEqual({ running: expect.objectContaining({ id: running.id }) });
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(1);
    });

    it("makes one job when called twice at once, and answers the other with it", async () => {
        const [a, b] = await Promise.all([downloadJobs.createOnce(input()), downloadJobs.createOnce(input())]);

        const made = [a, b].filter((outcome) => "created" in outcome);
        const answered = [a, b].filter((outcome) => "running" in outcome);
        expect(made).toHaveLength(1);
        expect(answered).toHaveLength(1);
        expect((answered[0] as { running: { id: string } }).running.id).toBe((made[0] as { created: { id: string } }).created.id);
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(1);
    });

    it("lets a conflict that is no running job's through", async () => {
        const failing = jest.spyOn(prisma.downloadJob, "create").mockRejectedValueOnce(Object.assign(new Error("other"), { code: "P2002" }));

        await expect(downloadJobs.createOnce(input())).rejects.toMatchObject({ code: "P2002" });
        failing.mockRestore();
    });
});
