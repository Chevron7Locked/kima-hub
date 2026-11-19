/**
 * The queue judge and Kima's one removal path, on the real test database and
 * Lidarr's own queue items from recorded runs: missing tracks are parked and
 * left alone, junk is removed with a blocklist so Lidarr tries the next
 * release (or left to the user's own setup when the switch is off), a
 * download is removed at most once, and only downloads of Kima jobs are touched.
 */

import { prisma } from "../../utils/db";
import { loadScenario, startLidarrReplay, type LidarrReplay, type LidarrScenario } from "../../__tests__/helpers/lidarrReplay";
import { useLidarr, useNoLidarr } from "../../__tests__/helpers/lidarrSettings";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { judgeQueueItem, rejectSingleTrackPost, sweepFailedDownloads } from "../lidarrFailures";
import { removeFailedDownload } from "../lidarrRemovals";
import { lidarrService } from "../lidarr";
import type { LidarrQueueItem } from "../../types/lidarr";

const USER = "lf_user";
const junkRun = loadScenario("junk-removed");
const parkedRun = loadScenario("missing-tracks");

/** The first queue reply in a run holding an item in this state, and that item. */
function queued(run: LidarrScenario, state: (item: LidarrQueueItem) => boolean) {
    for (const e of run.exchanges) {
        const records: LidarrQueueItem[] = (e.response as any)?.records ?? [];
        const item = e.path.startsWith("/api/v1/queue") ? records.find(state) : undefined;
        if (item) return { seq: e.seq, item };
    }
    throw new Error(`no such queue item in ${run.name}`);
}

const executable = queued(junkRun, (q) => q.statusMessages.some((sm) => sm.title.includes("executable")));
const missing = queued(parkedRun, (q) => q.trackedDownloadState === "importFailed");

let lidarr: LidarrReplay;

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

beforeEach(async () => {
    lidarr = await startLidarrReplay(junkRun);
    lidarr.at(executable.seq + 2);
    await useLidarr(lidarr.url);
});

afterEach(async () => {
    await lidarr.close();
    await prisma.handledDownload.deleteMany({});
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await useNoLidarr();
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

const job = (lidarrRef: string, attempts = 1) =>
    prisma.downloadJob.create({
        data: {
            userId: USER, subject: "Brad Sucks - Out of It", type: "album", status: "processing", attempts,
            targetMbid: "16f30346-886a-3144-9377-cbfceb32fd34", lidarrRef, lidarrAlbumId: 120,
            metadata: { artistName: "Brad Sucks", albumTitle: "Out of It" },
        },
    });

const deletes = () => lidarr.asked.filter((a) => a.method === "DELETE");

describe("judgeQueueItem on Lidarr's own queue items", () => {
    it("parks a download missing tracks", () => {
        expect(judgeQueueItem(missing.item)).toEqual({ action: "parked", reason: "Tracks missing" });
    });

    it("calls a download holding an executable junk, from the status title Lidarr writes it in", () => {
        expect(judgeQueueItem(executable.item)).toEqual({ action: "junk", reason: "Caution: Found executable file" });
    });

    it("turns away a single-track post by its title", () => {
        expect(judgeQueueItem({ ...executable.item, title: "Brad Sucks - Out of It [03/11] - 03 Feel Free.mp3" })?.action).toBe("reject");
    });
});

describe("sweepFailedDownloads", () => {
    it("removes junk with a blocklist, lets Lidarr search again and counts the attempt", async () => {
        const mine = await job(executable.item.downloadId, 2);

        const snapshot = await lidarrService.getReconciliationSnapshot();
        expect((await sweepFailedDownloads(snapshot)).removed).toBe(1);

        expect(deletes().map((d) => d.path)).toEqual([
            `/api/v1/queue/${executable.item.id}?removeFromClient=true&blocklist=true&skipRedownload=false`,
        ]);
        const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: mine.id } });
        expect(row.attempts).toBe(3);
        expect(row.lidarrRef).toBeNull();
        expect((row.metadata as any).previousDownloadIds).toEqual([executable.item.downloadId]);
    });

    it("leaves junk to the user's own setup when the switch is off, and the job waits", async () => {
        await useLidarr(lidarr.url, { lidarrRemoveJunk: false });
        const mine = await job(executable.item.downloadId);

        await sweepFailedDownloads(await lidarrService.getReconciliationSnapshot());

        expect(deletes()).toEqual([]);
        const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: mine.id } });
        expect(row.status).toBe("processing");
        expect((row.metadata as any).parked).toBe("Caution: Found executable file");
    });

    it("never touches a download no Kima job owns", async () => {
        await sweepFailedDownloads(await lidarrService.getReconciliationSnapshot());
        expect(deletes()).toEqual([]);
    });
});

describe("removeFailedDownload", () => {
    it("removes a download once however many callers ask", async () => {
        const reason = "Caution: Found executable file";
        expect(await removeFailedDownload(executable.item.downloadId, reason, { searchAgain: true })).toBe(true);
        expect(await removeFailedDownload(executable.item.downloadId, reason, { searchAgain: true })).toBe(false);
        expect(deletes()).toHaveLength(1);
    });
});

describe("rejectSingleTrackPost", () => {
    const post = "Brad Sucks - Out of It [03/11] - 03 Feel Free.mp3";

    it("turns a single-track post away at grab time when Kima removes junk", async () => {
        expect(await rejectSingleTrackPost(executable.item.downloadId, post)).toBe(true);
        expect(deletes()).toHaveLength(1);
    });

    it("leaves it to the user's own setup when the switch is off", async () => {
        await useLidarr(lidarr.url, { lidarrRemoveJunk: false });
        expect(await rejectSingleTrackPost(executable.item.downloadId, post)).toBe(false);
        expect(deletes()).toEqual([]);
    });

    it("leaves a whole album release alone", async () => {
        expect(await rejectSingleTrackPost(executable.item.downloadId, executable.item.title)).toBe(false);
        expect(deletes()).toEqual([]);
    });
});

describe("single-track posts, hi-res albums and dates", () => {
    it("never mistakes a hi-res album's bit depth and sample rate for a track number", () => {
        expect(judgeQueueItem({ ...executable.item, title: "Brad Sucks - Out of It [24/96] FLAC" })?.action).not.toBe("reject");
        expect(judgeQueueItem({ ...executable.item, title: "Brad Sucks - Out of It (2008) [16/44]" })?.action).not.toBe("reject");
    });

    it("never mistakes a month and year for a track number", () => {
        expect(judgeQueueItem({ ...executable.item, title: "Brad Sucks - Out of It [05/2012]" })?.action).not.toBe("reject");
    });
});
