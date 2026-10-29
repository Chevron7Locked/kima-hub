/**
 * The download pipeline against what a real Lidarr said. Each scenario was run
 * end to end on a throwaway Lidarr 3.1 with qBittorrent and free Brad Sucks
 * albums (scratch rig, scripts/record-lidarr.ts); its exchanges and the
 * webhooks Lidarr sent are replayed here into Kima on the real test database.
 */

import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import type { ReplayServer } from "../../__tests__/helpers/replayServer";
import { loadScenario, startLidarrReplay, type LidarrReplay, type LidarrScenario } from "../../__tests__/helpers/lidarrReplay";
import { clearDownloads, setUpPipeline, tearDownPipeline } from "./helpers/lidarrPipeline";

jest.setTimeout(60_000);

const USER = "lidarr_pipeline_user";
const ARTIST = "Brad Sucks";
const ALBUMS = {
    gwam: { mbid: "d0484284-1ee7-4157-951a-50f003cbcfb4", title: "Guess Who’s a Mess" },
    outOfIt: { mbid: "16f30346-886a-3144-9377-cbfceb32fd34", title: "Out of It" },
    idk: { mbid: "10e85e9b-0f07-33d4-a927-18a273f86eca", title: "I Don't Know What I'm Doing" },
    naturally: { mbid: "75947e63-09d5-4652-b6c7-55cebf2b5fee", title: "Naturally" },
    remixed: { mbid: "65fd0a70-9b0b-3828-9879-10e15e0ca660", title: "I Don't Know What I'm Doing Remixed" },
};

let mb: ReplayServer;
let lidarr: LidarrReplay;
let manager: typeof import("../simpleDownloadManager").simpleDownloadManager;
let dispatch: typeof import("../webhookHandlers").dispatchWebhookEvent;
let sweep: typeof import("../lidarrFailures").sweepFailedDownloads;
let lidarrService: typeof import("../lidarr").lidarrService;
let useLidarr: typeof import("../../__tests__/helpers/lidarrSettings").useLidarr;

beforeAll(async () => {
    let lidarrModule: typeof import("../lidarr");
    ({ mb, lidarr: lidarrModule, manager, dispatch, sweep, useLidarr } = await setUpPipeline(USER));
    ({ lidarrService } = lidarrModule);
});

afterEach(async () => {
    await lidarr?.close();
    await clearDownloads(USER);
});

// A grab starts the queue cleaner's 30-second loop; it would outlive the suite.
afterAll(() => tearDownPipeline(USER, mb));

/** Lidarr as it was in a recorded run, with Kima pointed at it. */
async function scenario(name: string, settings: Record<string, unknown> = {}): Promise<LidarrScenario> {
    const recorded = loadScenario(name);
    lidarr = await startLidarrReplay(recorded);
    await useLidarr(lidarr.url, settings);
    await redisClient.del(...Object.values(ALBUMS).map((a) => `mb:rg:${a.mbid}`));
    return recorded;
}

/** The job the request route creates, then the download started on it as the route does. */
async function request(album: { mbid: string; title: string }) {
    const job = await prisma.downloadJob.create({
        data: {
            userId: USER,
            subject: `${ARTIST} - ${album.title}`,
            type: "album",
            targetMbid: album.mbid,
            status: "pending",
            metadata: { artistName: ARTIST, albumTitle: album.title, downloadType: "library", rootFolderPath: "/music" },
        },
    });
    await manager.startDownload(job.id, ARTIST, album.title, album.mbid);
    return () => prisma.downloadJob.findUniqueOrThrow({ where: { id: job.id } });
}

/** The exchanges Kima made while starting the download: everything before the watcher first read Lidarr's queue or history. */
function requestPhase(recorded: LidarrScenario): number {
    const watcher = recorded.exchanges.find((e) => e.path.startsWith("/api/v1/queue") || e.path.startsWith("/api/v1/history"));
    return (watcher?.seq ?? Infinity) - 1;
}

const webhooks = (recorded: LidarrScenario, type: string) => recorded.webhooks.filter((w) => w.eventType === type);

describe("a complete album", () => {
    it("is asked for by its id, linked on the grab and completed on the import", async () => {
        const recorded = await scenario("complete");
        lidarr.replay(requestPhase(recorded));
        const job = await request(ALBUMS.gwam);

        let row = await job();
        expect(row.status).toBe("processing");
        const search = lidarr.asked.find((a) => a.method === "POST" && (a.body as any)?.name === "AlbumSearch");
        expect((search?.body as any).albumIds).toEqual([row.lidarrAlbumId]);
        expect((row.metadata as any).lidarrMbid).toBe(ALBUMS.gwam.mbid);

        const [grab] = webhooks(recorded, "Grab");
        await dispatch("Grab", grab.payload);
        row = await job();
        expect(row.lidarrRef).toBe(grab.payload.downloadId);

        await dispatch("Download", webhooks(recorded, "Download")[0].payload);
        row = await job();
        expect(row.status).toBe("completed");
    });
});

describe("a download missing tracks", () => {
    it("stays in Lidarr's queue untouched while the job waits and the user is told once", async () => {
        const recorded = await scenario("missing-tracks");
        lidarr.replay(requestPhase(recorded));
        const job = await request(ALBUMS.gwam);
        await dispatch("Grab", webhooks(recorded, "Grab")[0].payload);
        await dispatch("ImportFailure", webhooks(recorded, "ImportFailure")[0].payload);
        expect((await job()).attempts).toBe(1);

        const parkedQueue = recorded.exchanges.find(
            (e) => e.path.startsWith("/api/v1/queue") && (e.response as any)?.records?.some((q: any) => q.trackedDownloadState === "importFailed")
        )!;
        lidarr.at(parkedQueue.seq);
        const snapshot = await lidarrService.getReconciliationSnapshot();
        await sweep(snapshot);
        await sweep(snapshot);

        const row = await job();
        expect(row.status).toBe("processing");
        expect((row.metadata as any).parked).toBe("Tracks missing");
        expect(lidarr.asked.some((a) => a.method === "DELETE")).toBe(false);
        expect(await prisma.notification.count({ where: { userId: USER, type: "download_waiting" } })).toBe(1);
    });
});

describe("a search that grabs nothing", () => {
    it("fails with Lidarr's own reason when every release was rejected", async () => {
        const recorded = await scenario("rejected");
        lidarr.replay(requestPhase(recorded));
        const job = await request(ALBUMS.idk);

        const row = await job();
        expect(row.status).toBe("failed");
        expect(row.error).toBe(`No releases available for "I Don't Know What I'm Doing" - 1 found, none approved: MP3-128 is not wanted in profile (1)`);
    });

    it("says nothing was found when the indexers had no release", async () => {
        const recorded = await scenario("nothing-found");
        lidarr.replay(requestPhase(recorded));
        const job = await request(ALBUMS.naturally);

        const row = await job();
        expect(row.status).toBe("failed");
        expect(row.error).toBe(`No releases available for "Naturally" - indexers found no releases`);
    });
});

describe("an album the artist's list in Lidarr leaves out", () => {
    it("is added to Lidarr by its id, never swapped for a similar title", async () => {
        const recorded = await scenario("not-in-artist-list");
        lidarr.replay(requestPhase(recorded));
        await request(ALBUMS.remixed);

        expect(lidarr.asked.some((a) => a.method === "GET" && a.path === `/api/v1/album/lookup?term=lidarr:${ALBUMS.remixed.mbid}`)).toBe(true);
        const added = lidarr.asked.find((a) => a.method === "POST" && a.path === "/api/v1/album");
        expect((added?.body as any).foreignAlbumId).toBe(ALBUMS.remixed.mbid);
        const search = lidarr.asked.find((a) => a.method === "POST" && (a.body as any)?.name === "AlbumSearch");
        const addedId = (recorded.exchanges.find((e) => e.method === "POST" && e.path === "/api/v1/album")!.response as any).id;
        expect((search?.body as any).albumIds).toEqual([addedId]);
    });
});

describe("an album removed from Lidarr", () => {
    it("fails the job downloading it, without asking for anything else", async () => {
        const recorded = loadScenario("album-deleted");
        const event = recorded.webhooks[0].payload;
        const job = await prisma.downloadJob.create({
            data: {
                userId: USER, subject: `${ARTIST} - Naturally`, type: "album", status: "processing",
                targetMbid: event.album.mbId, lidarrAlbumId: event.album.id, lidarrRef: "DL-NATURALLY",
                metadata: { artistName: ARTIST, albumTitle: "Naturally" },
            },
        });

        await dispatch("AlbumDelete", event);

        const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: job.id } });
        expect(row.status).toBe("failed");
        expect(row.error).toBe("Album removed from Lidarr");
        expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(1);
    });
});

describe("a release Lidarr imports as another album", () => {
    // Lidarr goes by the files' tags: "Out of It" holding "Guess Who's a Mess"
    // files went in as the latter. Its webhook came for that album; its history
    // then recorded the finished download against "Out of It", with no files.
    const imports = (recorded: LidarrScenario) => {
        const [asOther, asOwn] = webhooks(recorded, "Download");
        expect(asOther.payload.album.title).toBe("Guess Who’s a Mess");
        expect(asOther.payload.trackFiles.length).toBeGreaterThan(0);
        expect(asOwn.payload.album.title).toBe("Out of It");
        expect(asOwn.payload.trackFiles).toEqual([]);
        return { asOther, asOwn };
    };
    const markedFailed = (recorded: LidarrScenario) =>
        recorded.exchanges.find((e) => e.method === "POST" && e.path.startsWith("/api/v1/history/failed/"))!;

    it("leaves the job on the other album's import; its own empty record is a failed release Lidarr blocklists", async () => {
        const recorded = await scenario("junk-removed");
        lidarr.replay(requestPhase(recorded));
        const job = await request(ALBUMS.outOfIt);
        const { asOther, asOwn } = imports(recorded);
        const [grab] = webhooks(recorded, "Grab");

        await dispatch("Grab", grab.payload);
        lidarr.at(markedFailed(recorded).seq);
        await dispatch("Download", asOther.payload);
        expect(await job()).toMatchObject({ status: "processing", attempts: 1, lidarrRef: grab.payload.downloadId });

        await dispatch("Download", asOwn.payload);
        const row = await job();
        expect(row).toMatchObject({ status: "processing", attempts: 2, lidarrRef: null });
        expect((row.metadata as any).lastError).toBe(`Lidarr found no tracks of "Out of It" in the download`);
        expect(lidarr.asked.filter((a) => a.method === "POST").map((a) => a.path)).toContain(markedFailed(recorded).path);

        // Lidarr's own report of the release Kima marked failed.
        const reported = webhooks(recorded, "DownloadFailure").find((w) => w.payload.downloadId === grab.payload.downloadId)!;
        await dispatch("DownloadFailure", reported.payload);
        expect((await job()).attempts).toBe(2);
    });

    it("fails the job saying no tracks of it came when Kima leaves junk to the user's setup", async () => {
        const recorded = await scenario("junk-removed", { lidarrRemoveJunk: false });
        lidarr.replay(requestPhase(recorded));
        const job = await request(ALBUMS.outOfIt);
        const { asOther, asOwn } = imports(recorded);

        await dispatch("Grab", webhooks(recorded, "Grab")[0].payload);
        lidarr.at(markedFailed(recorded).seq);
        await dispatch("Download", asOther.payload);
        await dispatch("Download", asOwn.payload);

        const row = await job();
        expect(row.status).toBe("failed");
        expect(row.error).toBe(`Lidarr found no tracks of "Out of It" in the download`);
        expect(lidarr.asked.some((a) => a.path.startsWith("/api/v1/history/failed/"))).toBe(false);
    });
});

describe("a failed release when Lidarr stops answering, a new grab, and Lidarr's own reason", () => {
    const markFailedSeq = (recorded: LidarrScenario) =>
        recorded.exchanges.find((e) => e.method === "POST" && e.path.startsWith("/api/v1/history/failed/"))!.seq;
    const grabRead = (recorded: LidarrScenario) =>
        recorded.exchanges.find((e) => e.path.startsWith("/api/v1/history?") && e.path.includes("eventType=1&downloadId="))!.seq;

    it("leaves the event to be tried again when Lidarr fails before the release is marked, and counts it once", async () => {
        const recorded = await scenario("junk-removed");
        lidarr.replay(requestPhase(recorded));
        const job = await request(ALBUMS.outOfIt);
        const [grab] = webhooks(recorded, "Grab");
        const asOwn = webhooks(recorded, "Download").find((w) => w.payload.album.title === "Out of It")!;
        await dispatch("Grab", grab.payload);

        // Lidarr has answered whether the album is whole but not yet for its grab record.
        lidarr.at(grabRead(recorded) - 1);
        await expect(dispatch("Download", asOwn.payload)).rejects.toThrow();
        expect(await job()).toMatchObject({ status: "processing", attempts: 2, lidarrRef: null });
        expect(lidarr.asked.some((a) => a.path.startsWith("/api/v1/history/failed/"))).toBe(false);

        lidarr.at(markFailedSeq(recorded));
        await dispatch("Download", asOwn.payload);
        expect((await job()).attempts).toBe(2);
        expect(lidarr.asked.some((a) => a.path.startsWith("/api/v1/history/failed/"))).toBe(true);
        expect(lidarr.asked.some((a) => a.method === "POST" && (a.body as any)?.name === "AlbumSearch")).toBe(true);
    });

    it("gives a waiting job to the next download Lidarr grabs for its album, clearing the waiting mark", async () => {
        const recorded = await scenario("junk-removed");
        const grabs = webhooks(recorded, "Grab");
        const next = grabs[grabs.length - 1].payload;
        const album = next.albums[0];
        const waiting = await prisma.downloadJob.create({
            data: {
                userId: USER, subject: `${ARTIST} - Out of It`, type: "album", status: "processing", attempts: 2,
                targetMbid: album.mbId, lidarrAlbumId: album.id,
                metadata: { artistName: ARTIST, albumTitle: "Out of It", parked: "Tracks missing", statusText: "Waiting in Lidarr: Tracks missing" },
            },
        });

        await dispatch("Grab", next);

        const row = await prisma.downloadJob.findUniqueOrThrow({ where: { id: waiting.id } });
        expect(row.lidarrRef).toBe(next.downloadId);
        expect(row.metadata).not.toHaveProperty("parked");
        expect(row.metadata).not.toHaveProperty("statusText");
    });

    it("fails the release with Lidarr's own reason when it gave one", async () => {
        const recorded = await scenario("junk-removed");
        lidarr.replay(requestPhase(recorded));
        const job = await request(ALBUMS.outOfIt);
        const [grab] = webhooks(recorded, "Grab");
        await dispatch("Grab", grab.payload);
        lidarr.at(markFailedSeq(recorded));

        await manager.onDownloadComplete(grab.payload.downloadId, undefined, grab.payload.albums[0].id, undefined, 0, "Not an upgrade for existing track file(s)");

        expect(((await job()).metadata as any).lastError).toBe("Not an upgrade for existing track file(s)");
    });
});

describe("an album Lidarr imported only part of", () => {
    it("keeps the job waiting as Tracks missing, off the finished download, through the queue and grab checks", async () => {
        const recorded = await scenario("partial-import");
        lidarr.replay(requestPhase(recorded));
        const job = await request(ALBUMS.gwam);
        const [grab] = webhooks(recorded, "Grab");
        const [imported] = webhooks(recorded, "Download");
        expect(imported.payload.trackFiles.length).toBeGreaterThan(0);
        await dispatch("Grab", grab.payload);

        const wholeRead = recorded.exchanges.filter((e) => e.path === `/api/v1/album/${imported.payload.album.id}`).at(-1)!;
        expect((wholeRead.response as any).statistics.percentOfTracks).toBeLessThan(100);
        lidarr.at(wholeRead.seq);
        await dispatch("Download", imported.payload);

        let row = await job();
        expect(row).toMatchObject({ status: "processing", lidarrRef: null });
        expect(row.metadata).toMatchObject({ parked: "Tracks missing", previousDownloadIds: [grab.payload.downloadId] });

        lidarr.at(Math.max(...recorded.exchanges.map((e) => e.seq)));
        for (let cycle = 0; cycle < 3; cycle++) {
            const snapshot = await lidarrService.getReconciliationSnapshot();
            await manager.syncWithLidarrQueue(snapshot);
            await manager.checkWaitingJobs(snapshot);
        }
        row = await job();
        expect(row.status).toBe("processing");
        expect((row.metadata as any).parked).toBe("Tracks missing");
    });
});

describe("junk when the request is at its retry limit", () => {
    it("removes it with a blocklist but no new search, stops Lidarr looking, and fails the request with the reason", async () => {
        const recorded = await scenario("junk-at-limit");
        await prisma.userDiscoverConfig.upsert({
            where: { userId: USER },
            create: { userId: USER, maxRetryAttempts: 1 },
            update: { maxRetryAttempts: 1 },
        });
        try {
            lidarr.replay(requestPhase(recorded));
            const job = await request(ALBUMS.outOfIt);
            await dispatch("Grab", webhooks(recorded, "Grab")[0].payload);

            lidarr.at(Math.max(...recorded.exchanges.map((e) => e.seq)));
            const before = lidarr.asked.length;
            await sweep(await lidarrService.getReconciliationSnapshot());
            const after = lidarr.asked.slice(before);

            const removal = after.find((a) => a.method === "DELETE");
            expect(removal?.path).toMatch(/blocklist=true&skipRedownload=true$/);
            expect(after.some((a) => a.method === "PUT" && a.path === "/api/v1/album/monitor")).toBe(true);
            expect(after.some((a) => a.method === "POST" && (a.body as any)?.name === "AlbumSearch")).toBe(false);
            const row = await job();
            expect(row.status).toBe("failed");
            expect(row.error).toBe("Every release failed: Caution: Found executable file");
        } finally {
            await prisma.userDiscoverConfig.deleteMany({ where: { userId: USER } });
        }
    });
});
