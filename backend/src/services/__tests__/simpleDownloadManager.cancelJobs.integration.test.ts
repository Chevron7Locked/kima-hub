/**
 * Stopping downloads at Lidarr when jobs are cancelled: a queue entry stays while any live job outside the cancelled set
 * wants its album (even one with no download of its own yet), and one ref or album that cannot be handled does not stop
 * the rest. Real database; Lidarr answers as it did in a recorded run.
 */
import { prisma } from "../../utils/db";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { lidarrService } from "../lidarr";
import { logger } from "../../utils/logger";
import { useLidarrCancelScenario } from "../../__tests__/helpers/lidarrCancelScenario";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const { unmonitored, removedFromQueue } = useLidarrCancelScenario();

const USER = "zz-cancel-jobs-user";
// The download and album the recorded Lidarr run queued.
const LIDARR_DOWNLOAD = "70C868D890F259E14337C4B7F37FA5E6A41B9C9F";
const LIDARR_ALBUM = 308;
const QUEUE_DELETE = "/api/v1/queue/1154813163?removeFromClient=true&blocklist=false&skipRedownload=true";

const job = (status: string, extra: Record<string, unknown> = {}) =>
    prisma.downloadJob.create({
        data: { userId: USER, subject: `Album ${status}`, type: "album", status, metadata: {}, ...extra },
    });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.handledDownload.deleteMany({ where: { downloadId: { in: [LIDARR_DOWNLOAD, "dead-ref"] } } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("keeps the queue entry while another live job without a download yet wants the same album", async () => {
    const mine = await job("processing", { lidarrRef: LIDARR_DOWNLOAD, lidarrAlbumId: LIDARR_ALBUM });
    await job("pending", { lidarrAlbumId: LIDARR_ALBUM });

    await simpleDownloadManager.cancelJobs([mine]);

    expect(removedFromQueue()).toEqual([]);
    expect(unmonitored()).toEqual([]);
});

it("still removes the queue entry when the only other job on the album is settled", async () => {
    const mine = await job("processing", { lidarrRef: LIDARR_DOWNLOAD, lidarrAlbumId: LIDARR_ALBUM });
    await job("failed", { lidarrAlbumId: LIDARR_ALBUM });

    await simpleDownloadManager.cancelJobs([mine]);

    expect(removedFromQueue()).toEqual([QUEUE_DELETE]);
    expect(unmonitored()).toEqual([[LIDARR_ALBUM]]);
});

it("handles the next download when one cannot be removed", async () => {
    const logged = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    const first = await job("processing", { lidarrRef: "dead-ref", lidarrAlbumId: 400 });
    const second = await job("processing", { lidarrRef: LIDARR_DOWNLOAD, lidarrAlbumId: LIDARR_ALBUM });
    const create = jest.spyOn(prisma.handledDownload, "createMany").mockRejectedValueOnce(new Error("db down"));

    await simpleDownloadManager.cancelJobs([first, second]);

    expect(create).toHaveBeenCalledTimes(2);
    expect(removedFromQueue()).toEqual([QUEUE_DELETE]);
    expect(unmonitored().flat().sort()).toEqual([LIDARR_ALBUM, 400]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("dead-ref"), expect.any(Error));
});

it("stops watching the next album when one cannot be unmonitored", async () => {
    const logged = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    const first = await job("pending", { lidarrAlbumId: 400 });
    const second = await job("pending", { lidarrAlbumId: LIDARR_ALBUM });
    const real = lidarrService.unmonitorAlbum.bind(lidarrService);
    const unmonitor = jest
        .spyOn(lidarrService, "unmonitorAlbum")
        .mockRejectedValueOnce(new Error("lidarr down"))
        .mockImplementation(real);

    await simpleDownloadManager.cancelJobs([first, second]);

    expect(unmonitor).toHaveBeenCalledTimes(2);
    expect(unmonitored()).toEqual([[LIDARR_ALBUM]]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("400"), expect.any(Error));
});
