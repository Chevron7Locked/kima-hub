/**
 * A person cancelling their import removes it and its downloads, and stops the unfinished downloads at Lidarr too:
 * the queue entry goes and the album is no longer watched, as a single download's cancel does. Real database and
 * Redis; Lidarr answers as it did in a recorded run.
 */
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { playlistImportService } from "../playlistImport";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { logger } from "../../utils/logger";
import { useLidarrCancelScenario } from "../../__tests__/helpers/lidarrCancelScenario";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const { unmonitored, removedFromQueue, replay } = useLidarrCancelScenario();

const USER = "zz-cancel-import-user";
// The download and album the recorded Lidarr run queued.
const LIDARR_DOWNLOAD = "70C868D890F259E14337C4B7F37FA5E6A41B9C9F";
const LIDARR_ALBUM = 308;
const QUEUE_DELETE = "/api/v1/queue/1154813163?removeFromClient=true&blocklist=false&skipRedownload=true";

const importRow = (status: string) =>
    prisma.spotifyImportJob.create({
        data: {
            userId: USER, spotifyPlaylistId: "37i9dQZF1DXcBWIGoYBM5M", playlistName: "Today's Top Hits",
            status, progress: 50, albumsTotal: 2, tracksTotal: 2, pendingTracks: [],
        },
    });

const downloadJob = (importJobId: string, status: string, extra: Record<string, unknown> = {}) =>
    prisma.downloadJob.create({
        data: {
            userId: USER, subject: `Album ${status}`, type: "album", status,
            metadata: { downloadType: "spotify_import", spotifyImportJobId: importJobId },
            ...extra,
        },
    });

const downloadRows = (importJobId: string) =>
    prisma.downloadJob.count({ where: { metadata: { path: ["spotifyImportJobId"], equals: importJobId } } });

beforeAll(async () => {
    await waitForRedisReady();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterEach(async () => {
    const ids = (await prisma.spotifyImportJob.findMany({ where: { userId: USER }, select: { id: true } })).map((j) => j.id);
    await Promise.all(ids.map((id) => redisClient.del(`import:job:${id}`)));
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
    // A removed download stays claimed, so Lidarr's report of it is not counted as a new failure: each test starts unclaimed.
    await prisma.handledDownload.deleteMany({ where: { downloadId: LIDARR_DOWNLOAD } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("removes the import's running download from Lidarr's queue and stops watching its albums, then removes the rows", async () => {
    const running = await importRow("downloading");
    await downloadJob(running.id, "processing", { lidarrRef: LIDARR_DOWNLOAD, lidarrAlbumId: LIDARR_ALBUM });
    await downloadJob(running.id, "pending", { lidarrAlbumId: 309 });

    await playlistImportService.cancelJob(running.id);

    expect(removedFromQueue()).toEqual([QUEUE_DELETE]);
    expect(unmonitored().flat().sort()).toEqual([LIDARR_ALBUM, 309]);
    expect(await downloadRows(running.id)).toBe(0);
    expect(await prisma.spotifyImportJob.count({ where: { id: running.id } })).toBe(0);
});

it("leaves Lidarr alone for settled downloads and for another import's", async () => {
    const running = await importRow("downloading");
    const other = await importRow("downloading");
    await downloadJob(running.id, "completed", { lidarrRef: LIDARR_DOWNLOAD, lidarrAlbumId: LIDARR_ALBUM });
    await downloadJob(running.id, "failed", { lidarrRef: "settled-ref", lidarrAlbumId: 400 });
    await downloadJob(other.id, "processing", { lidarrRef: "others-ref", lidarrAlbumId: 401 });

    await playlistImportService.cancelJob(running.id);

    expect(removedFromQueue()).toEqual([]);
    expect(unmonitored()).toEqual([]);
    expect(await downloadRows(running.id)).toBe(0);
    expect(await downloadRows(other.id)).toBe(1);
});

it("leaves the download and album to another live job that wants them", async () => {
    const running = await importRow("downloading");
    await downloadJob(running.id, "processing", { lidarrRef: LIDARR_DOWNLOAD, lidarrAlbumId: LIDARR_ALBUM });
    const own = await prisma.downloadJob.create({
        data: { userId: USER, subject: "My own", type: "album", status: "processing", lidarrRef: LIDARR_DOWNLOAD, lidarrAlbumId: LIDARR_ALBUM, metadata: {} },
    });

    await playlistImportService.cancelJob(running.id);

    expect(removedFromQueue()).toEqual([]);
    expect(unmonitored()).toEqual([]);
    expect((await prisma.downloadJob.findUniqueOrThrow({ where: { id: own.id } })).status).toBe("processing");
});

it("sends the person no notice for the import or its downloads", async () => {
    const running = await importRow("downloading");
    await downloadJob(running.id, "processing", { lidarrRef: LIDARR_DOWNLOAD, lidarrAlbumId: LIDARR_ALBUM });
    await downloadJob(running.id, "pending", { lidarrAlbumId: 309 });

    await playlistImportService.cancelJob(running.id);
    await new Promise((r) => setTimeout(r, 50));

    expect(await prisma.notification.count({ where: { userId: USER } })).toBe(0);
});

it("does not touch Lidarr for an import that already completed", async () => {
    const done = await importRow("completed");
    await downloadJob(done.id, "processing", { lidarrRef: LIDARR_DOWNLOAD, lidarrAlbumId: LIDARR_ALBUM });

    await playlistImportService.cancelJob(done.id);

    expect(removedFromQueue()).toEqual([]);
    expect(unmonitored()).toEqual([]);
    expect(await prisma.spotifyImportJob.count({ where: { id: done.id } })).toBe(1);
});

it.each(["failed", "cancelled"])("stops the unfinished downloads of an import already %s when it is cleaned away", async (status) => {
    const closed = await importRow(status);
    await downloadJob(closed.id, "processing", { lidarrRef: LIDARR_DOWNLOAD, lidarrAlbumId: LIDARR_ALBUM });

    await playlistImportService.cancelJob(closed.id);

    expect(removedFromQueue()).toEqual([QUEUE_DELETE]);
    expect(unmonitored()).toEqual([[LIDARR_ALBUM]]);
    expect(await downloadRows(closed.id)).toBe(0);
});

it("still cancels the import when Lidarr cannot be asked", async () => {
    const running = await importRow("downloading");
    await downloadJob(running.id, "processing", { lidarrRef: LIDARR_DOWNLOAD, lidarrAlbumId: LIDARR_ALBUM });
    const stop = jest.spyOn(simpleDownloadManager, "cancelJobs").mockRejectedValueOnce(new Error("lidarr down"));
    const logged = jest.spyOn(logger, "error").mockImplementation(() => undefined);

    await playlistImportService.cancelJob(running.id);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(running.id), expect.any(Error));
    expect(await downloadRows(running.id)).toBe(0);
    expect(await prisma.spotifyImportJob.count({ where: { id: running.id } })).toBe(0);
    stop.mockRestore();
    logged.mockRestore();
});

it("still cancels the import when Lidarr answers every request with an error", async () => {
    replay().at(0);
    const warned = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    const errored = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    const running = await importRow("downloading");
    await downloadJob(running.id, "processing", { lidarrRef: LIDARR_DOWNLOAD, lidarrAlbumId: LIDARR_ALBUM });

    await playlistImportService.cancelJob(running.id);

    warned.mockRestore();
    errored.mockRestore();
    // Lidarr was asked, and refused: nothing was removed from its queue.
    expect(replay().asked.length).toBeGreaterThan(0);
    expect(removedFromQueue()).toEqual([]);
    expect(await downloadRows(running.id)).toBe(0);
    expect(await prisma.spotifyImportJob.count({ where: { id: running.id } })).toBe(0);
});
