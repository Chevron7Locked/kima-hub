/**
 * An import is closed by a guarded move before anything is cleaned away, and an import that has been stopped never
 * starts a download. Cancelling closes the import first and cleans up only if that move won, so a completion that lands
 * in between keeps its result; the cleanup removes the download rows before the import row, so a failure part-way leaves
 * the closed import for the next cancel to finish; and a worker starting an import (or about to start one of its
 * downloads) looks at the stored status, so a stop from another process holds it where the in-process abort cannot
 * reach. Real database and Redis; Lidarr answers as it did in a recorded run.
 */
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { playlistImportService, failImportJob } from "../playlistImport";
import { acquisitionService } from "../acquisitionService";
import { notificationService } from "../notificationService";
import * as downloadJobs from "../downloads/jobs";
import { useLidarrCancelScenario } from "../../__tests__/helpers/lidarrCancelScenario";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

useLidarrCancelScenario();

const USER = "zz-close-first-user";

const importRow = (status: string) =>
    prisma.spotifyImportJob.create({
        data: {
            userId: USER, spotifyPlaylistId: "37i9dQZF1DXcBWIGoYBM5M", playlistName: "Today's Top Hits",
            status, progress: 50, albumsTotal: 2, tracksTotal: 2, pendingTracks: [],
        },
    });

const downloadJob = (importJobId: string, status: string) =>
    prisma.downloadJob.create({
        data: {
            userId: USER, subject: `Album ${status}`, type: "album", status,
            metadata: { downloadType: "spotify_import", spotifyImportJobId: importJobId },
        },
    });

const rowOf = (id: string) => prisma.spotifyImportJob.findUnique({ where: { id } });
const downloadRows = async (importJobId: string) => {
    await downloadJobs.whenIdle();
    return prisma.downloadJob.count({ where: { metadata: { path: ["spotifyImportJobId"], equals: importJobId } } });
};

/** The next read of an import row sees it as it was, then another process completes the import. */
const completesAfterNextRead = (id: string) => {
    const real = prisma.spotifyImportJob.findUnique.bind(prisma.spotifyImportJob) as (args: unknown) => Promise<unknown>;
    jest.spyOn(prisma.spotifyImportJob, "findUnique").mockImplementationOnce(((args: unknown) =>
        real(args).then(async (seen) => {
            await prisma.spotifyImportJob.update({ where: { id }, data: { status: "completed" } });
            return seen;
        })) as never);
};

beforeAll(async () => {
    await waitForRedisReady();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

beforeEach(() => {
    jest.spyOn(notificationService, "notifyImportFailed").mockResolvedValue(undefined as never);
});

afterEach(async () => {
    jest.restoreAllMocks();
    await downloadJobs.whenIdle();
    const ids = (await prisma.spotifyImportJob.findMany({ where: { userId: USER }, select: { id: true } })).map((j) => j.id);
    await Promise.all(ids.map((id) => redisClient.del(`import:job:${id}`)));
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

describe("cancelling an import", () => {
    it("keeps the result and the downloads of an import that completed while it was being cancelled", async () => {
        const running = await importRow("downloading");
        await downloadJob(running.id, "completed");
        completesAfterNextRead(running.id);

        await playlistImportService.cancelJob(running.id);

        expect((await rowOf(running.id))?.status).toBe("completed");
        expect(await downloadRows(running.id)).toBe(1);
    });

    it("leaves the closed import for the next cancel when removing its downloads fails", async () => {
        const running = await importRow("downloading");
        await downloadJob(running.id, "pending");
        jest.spyOn(downloadJobs, "remove").mockRejectedValueOnce(new Error("database went away"));

        await expect(playlistImportService.cancelJob(running.id)).rejects.toThrow("database went away");

        expect((await rowOf(running.id))?.status).toBe("cancelled");
        expect(await downloadRows(running.id)).toBe(1);

        await playlistImportService.cancelJob(running.id);

        expect(await rowOf(running.id)).toBeNull();
        expect(await downloadRows(running.id)).toBe(0);
    });

    it("tells no one the import failed", async () => {
        const running = await importRow("downloading");
        await downloadJob(running.id, "pending");

        await playlistImportService.cancelJob(running.id);
        await downloadJobs.whenIdle();

        expect(notificationService.notifyImportFailed).not.toHaveBeenCalled();
    });
});

describe("an import that was stopped before its worker started", () => {
    const preview = {
        playlist: { id: "pl", name: "x", description: null, owner: "x", imageUrl: null, trackCount: 1 },
        matchedTracks: [],
        albumsToDownload: [{ albumMbid: "mbid-1", spotifyAlbumId: "sp-1", albumName: "A", artistName: "B", trackCount: 1, tracksNeeded: [{ title: "t", artist: "B" }] }],
        summary: { total: 1, inLibrary: 0, downloadable: 1, notFound: 0 },
    } as never;
    // What the worker read from the cache: the import as it was when queued.
    const snapshot = (id: string) => ({
        id, userId: USER, spotifyPlaylistId: "pl", playlistName: "x", status: "pending", progress: 0,
        albumsTotal: 1, albumsCompleted: 0, tracksMatched: 0, tracksTotal: 1, tracksDownloadable: 1,
        createdPlaylistId: null, error: null, sourceUrl: null, createdAt: new Date(), updatedAt: new Date(), pendingTracks: [],
    });
    const run = (id: string) => (playlistImportService as any).processImport(snapshot(id), ["mbid-1"], preview);

    let acquire: jest.SpyInstance;
    let build: jest.SpyInstance;
    beforeEach(() => {
        acquire = jest.spyOn(acquisitionService, "acquireAlbum").mockResolvedValue({ success: false, error: "stubbed" });
        build = jest.spyOn(playlistImportService, "buildPlaylist").mockResolvedValue(undefined as never);
    });

    it.each(["failed", "cancelled"])("starts no download when the stored import is %s", async (status) => {
        const stopped = await importRow(status);

        await run(stopped.id);

        expect(acquire).not.toHaveBeenCalled();
        expect(build).not.toHaveBeenCalled();
    });

    it("starts no download when the stored import is gone", async () => {
        const gone = await importRow("downloading");
        await prisma.spotifyImportJob.delete({ where: { id: gone.id } });

        await run(gone.id);

        expect(acquire).not.toHaveBeenCalled();
    });

    it("starts no download when the import is stopped while its worker reads the stored status", async () => {
        const running = await importRow("downloading");
        const real = prisma.spotifyImportJob.findUnique.bind(prisma.spotifyImportJob) as (args: unknown) => Promise<unknown>;
        // The read still sees an open import: the stop lands during it, after the worker registered its searches.
        jest.spyOn(prisma.spotifyImportJob, "findUnique").mockImplementationOnce(((args: unknown) =>
            real(args).then(async (seen) => {
                await failImportJob(running.id, "stopped elsewhere");
                return seen;
            })) as never);

        await run(running.id);

        expect(acquire).not.toHaveBeenCalled();
    });

    it("lets a download start only while the stored import is open, and stops this process's searches when it is not", async () => {
        const running = await importRow("downloading");
        const seen: { open: boolean[]; aborted: boolean[] } = { open: [], aborted: [] };
        acquire.mockImplementation((async (_request: unknown, context: any) => {
            seen.open.push(await context.stillOpen());
            await prisma.spotifyImportJob.update({ where: { id: running.id }, data: { status: "failed" } });
            seen.open.push(await context.stillOpen());
            seen.aborted.push(context.signal.aborted);
            return { success: false, error: "Import cancelled" };
        }) as never);

        await run(running.id);

        expect(seen.open).toEqual([true, false]);
        expect(seen.aborted).toEqual([true]);
    });
});
