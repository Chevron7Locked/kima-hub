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
        const { spotifyImportService } = await import("../../spotifyImport");
        const told = jest.spyOn(spotifyImportService, "checkImportCompletion").mockResolvedValue();
        const j = await job("dl_done_import", {
            metadata: { spotifyImportJobId: "imp-1", artistName: "Brad Sucks", albumTitle: "Guess Who’s a Mess" },
        });

        await downloadJobs.complete([j]);
        await downloadJobs.complete([j]);
        await downloadJobs.whenIdle();

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
        await downloadJobs.whenIdle();

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
        await downloadJobs.whenIdle();

        expect((await prisma.discoveryBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("failed");
    });

    it("tells the import, and not again for a job already failed", async () => {
        const { spotifyImportService } = await import("../../spotifyImport");
        const told = jest.spyOn(spotifyImportService, "checkImportCompletion").mockResolvedValue();
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

    it("tells the batch and the import", async () => {
        const { spotifyImportService } = await import("../../spotifyImport");
        const importTold = jest.spyOn(spotifyImportService, "checkImportCompletion").mockResolvedValue();
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
        expect([...downloadJobs.JOB_STATUSES]).toEqual(["pending", "processing", "completed", "failed", "exhausted"]);
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
        const { spotifyImportService } = await import("../../spotifyImport");
        let release!: () => void;
        const checking = new Promise<void>((resolve) => (release = resolve));
        const check = jest.spyOn(spotifyImportService, "checkImportCompletion").mockReturnValue(checking);
        const j = await job("dl_prompt_import", { metadata: { spotifyImportJobId: "imp-9" } });

        await downloadJobs.complete([j]);

        await new Promise((r) => setTimeout(r, 50));
        expect(check.mock.calls).toEqual([["imp-9"]]);
        release();
        await downloadJobs.whenIdle();
    });

    it("whenIdle also waits for a move that has written the job but is still telling the user, and for the check that follows", async () => {
        const { spotifyImportService } = await import("../../spotifyImport");
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
        const told = jest.spyOn(spotifyImportService, "checkImportCompletion").mockResolvedValue();
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
