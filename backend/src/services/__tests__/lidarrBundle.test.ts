/**
 * Bundle detection, grab and completion against a real Lidarr's recorded answers
 * (run "bundle"): a discography release is recognised, grabbed and linked to
 * both albums' jobs; the album it did not bring is searched for on its own.
 */

import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import type { ReplayServer } from "../../__tests__/helpers/replayServer";
import { loadScenario, startLidarrReplay, type LidarrReplay } from "../../__tests__/helpers/lidarrReplay";
import { clearDownloads, setUpPipeline, tearDownPipeline } from "./helpers/lidarrPipeline";

jest.setTimeout(60_000);

const USER = "bundle_user";
const IDK = { mbid: "10e85e9b-0f07-33d4-a927-18a273f86eca", title: "I Don't Know What I'm Doing" };
const run = loadScenario("bundle");
const discography = (run.exchanges.find((e) => e.path.startsWith("/api/v1/release?artistId"))!.response as any[])[0];
const [grab, idkImported, gwamImported] = run.webhooks;
const seqOf = (method: string, path: string, after = 0) => run.exchanges.find((e) => e.seq > after && e.method === method && e.path === path)!.seq;

let mb: ReplayServer;
let lidarr: LidarrReplay;
let lidarrModule: typeof import("../lidarr");
let manager: typeof import("../simpleDownloadManager").simpleDownloadManager;
let dispatch: typeof import("../webhookHandlers").dispatchWebhookEvent;
let useLidarr: typeof import("../../__tests__/helpers/lidarrSettings").useLidarr;

beforeAll(async () => {
    ({ mb, lidarr: lidarrModule, manager, dispatch, useLidarr } = await setUpPipeline(USER));
});

beforeEach(async () => {
    lidarr = await startLidarrReplay(run);
    await useLidarr(lidarr.url);
    await redisClient.del(`mb:rg:${IDK.mbid}`);
});

afterEach(async () => {
    await lidarr.close();
    await clearDownloads(USER);
});

afterAll(() => tearDownPipeline(USER, mb));

async function request() {
    const job = await prisma.downloadJob.create({
        data: {
            userId: USER, subject: `Brad Sucks - ${IDK.title}`, type: "album", targetMbid: IDK.mbid, status: "pending",
            metadata: { artistName: "Brad Sucks", albumTitle: IDK.title, downloadType: "library", rootFolderPath: "/music" },
        },
    });
    await manager.startDownload(job.id, "Brad Sucks", IDK.title, IDK.mbid);
    return () => prisma.downloadJob.findUniqueOrThrow({ where: { id: job.id } });
}

it("recognises Lidarr's discography release by its own fields and its year range", () => {
    expect(lidarrModule.looksLikeBundle(discography)).toBe(true);
    expect(lidarrModule.bundleCoversAlbum(discography.title, IDK.title, 2003)).toBe(true);
    expect(lidarrModule.bundleCoversAlbum(discography.title, "Naturally", 2024)).toBe(false);
});

it("grabs the bundle when the album search found nothing", async () => {
    lidarr.replay(seqOf("POST", "/api/v1/release"));
    const job = await request();

    const grabbed = lidarr.asked.find((a) => a.method === "POST" && a.path === "/api/v1/release");
    expect(grabbed?.body).toEqual({ guid: discography.guid, indexerId: discography.indexerId });
    expect((await job()).status).toBe("processing");
});


async function bothRequested() {
    lidarr.replay(seqOf("POST", "/api/v1/release"));
    const idk = await request();
    const gwamAlbum = grab.payload.albums.find((a: any) => a.title !== IDK.title);
    const created = await prisma.downloadJob.create({
        data: {
            userId: USER, subject: `Brad Sucks - ${gwamAlbum.title}`, type: "album", status: "processing", attempts: 1,
            targetMbid: gwamAlbum.mbId, lidarrAlbumId: gwamAlbum.id, metadata: { artistName: "Brad Sucks", albumTitle: gwamAlbum.title },
        },
    });
    const gwam = () => prisma.downloadJob.findUniqueOrThrow({ where: { id: created.id } });

    await dispatch("Grab", grab.payload);
    expect((await idk()).lidarrRef).toBe(grab.payload.downloadId);
    expect((await gwam()).lidarrRef).toBe(grab.payload.downloadId);
    // Lidarr as it stood after both imports and Kima's search for the album that got nothing.
    lidarr.at(Math.max(...run.exchanges.map((e) => e.seq)));
    return { idk, gwam };
}

function failedRelease(row: Awaited<ReturnType<typeof prisma.downloadJob.findUniqueOrThrow>>) {
    expect(row).toMatchObject({ status: "processing", attempts: 2, lidarrRef: null });
    expect((row.metadata as any).lastError).toBe(`Lidarr found no tracks of "${IDK.title}" in the download`);
    expect((row.metadata as any).searchCommandId).toBeDefined();
}

it("links both albums' jobs; the album with no files is a failed release, the other is untouched and then completes", async () => {
    const { idk, gwam } = await bothRequested();
    expect(idkImported.payload.trackFiles).toEqual([]);
    expect(gwamImported.payload.trackFiles.length).toBeGreaterThan(0);

    await dispatch("Download", idkImported.payload);
    failedRelease(await idk());
    expect(await gwam()).toMatchObject({ status: "processing", attempts: 1, lidarrRef: grab.payload.downloadId });
    expect(lidarr.asked.some((a) => a.path.startsWith("/api/v1/history/failed/"))).toBe(false);

    await dispatch("Download", gwamImported.payload);
    expect((await gwam()).status).toBe("completed");
});

it("still fails the album with no files when the other album's import came first", async () => {
    const { idk, gwam } = await bothRequested();

    await dispatch("Download", gwamImported.payload);
    expect((await gwam()).status).toBe("completed");
    await dispatch("Download", idkImported.payload);
    failedRelease(await idk());
});

it("searches again without a second bundle, and says which release failed when nothing else is found", async () => {
    const { idk } = await bothRequested();
    await dispatch("Download", idkImported.payload);
    const searchCommandId = ((await idk()).metadata as any).searchCommandId;
    expect(run.exchanges.some((e) => e.path === `/api/v1/command/${searchCommandId}`)).toBe(true);

    lidarr.at(Math.max(...run.exchanges.map((e) => e.seq)));
    const asked = lidarr.asked.length;
    await manager.checkWaitingJobs(await lidarrModule.lidarrService.getReconciliationSnapshot());

    const row = await idk();
    expect(row.status).toBe("failed");
    expect(row.error).toBe(`Lidarr found no tracks of "${IDK.title}" in the download - no other release found`);
    const after = lidarr.asked.slice(asked);
    expect(after.some((a) => a.path.startsWith("/api/v1/release?artistId"))).toBe(false);
    expect(after.some((a) => a.method === "POST" && a.path === "/api/v1/release")).toBe(false);
});
