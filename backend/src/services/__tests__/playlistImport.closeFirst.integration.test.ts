/**
 * An import is closed by a guarded move before anything is cleaned away, and an import that has been stopped never
 * starts a download. Cancelling closes the import first and cleans up only if that move won, so a completion that lands
 * in between keeps its result; the cleanup removes the download rows before the import row, so a failure part-way leaves
 * the closed import for the next cancel to finish; and a worker starting an import (or about to start one of its
 * downloads) looks at the stored status, so a stop from another process holds it where the in-process abort cannot
 * reach. Real database and Redis; Lidarr answers as it did in a recorded run.
 */
jest.mock("../playlistImport/reading", () => ({
    ...jest.requireActual("../playlistImport/reading"),
    readMusicLink: jest.fn(),
}));
jest.mock("../playlistImport/matching", () => ({
    ...jest.requireActual("../playlistImport/matching"),
    previewOfTracklist: jest.fn(),
}));
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { playlistImportService, failImportJob } from "../playlistImport";
import { acquisitionService } from "../acquisitionService";
import { notificationService } from "../notificationService";
import { logger } from "../../utils/logger";
import * as downloadJobs from "../downloads/jobs";
import { useLidarrCancelScenario } from "../../__tests__/helpers/lidarrCancelScenario";
import { readMusicLink } from "../playlistImport/reading";
import { previewOfTracklist } from "../playlistImport/matching";
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

// A stop from another process (the worker and the API run apart in the split image) changes the stored row; this
// process's cached copy of the import still says it is open.
const cacheCopyOpen = async (id: string) => {
    const { toImportJob } = await import("../playlistImport/jobState");
    const row = await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id } });
    await redisClient.set(`import:job:${id}`, JSON.stringify({ ...toImportJob(row), status: "downloading" }));
};
const cancelElsewhere = async (id: string) => {
    await prisma.spotifyImportJob.update({ where: { id }, data: { status: "cancelled" } });
    await cacheCopyOpen(id);
};

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

    /** A cached copy of the import that says `status` while the row says otherwise. */
    const cacheSays = async (id: string, status: string) => {
        const { toImportJob } = await import("../playlistImport/jobState");
        await redisClient.set(`import:job:${id}`, JSON.stringify({ ...toImportJob((await rowOf(id))!), status }));
    };

    it("keeps an import the database holds as completed, whatever a cached copy says", async () => {
        const done = await importRow("completed");
        await downloadJob(done.id, "completed");
        await cacheSays(done.id, "failed");

        await playlistImportService.cancelJob(done.id);

        expect((await rowOf(done.id))?.status).toBe("completed");
        expect(await downloadRows(done.id)).toBe(1);
    });

    it("cancels an import the database holds as open, whatever a cached copy says", async () => {
        const running = await importRow("downloading");
        await downloadJob(running.id, "pending");
        await cacheSays(running.id, "completed");

        await playlistImportService.cancelJob(running.id);

        expect(await rowOf(running.id)).toBeNull();
        expect(await downloadRows(running.id)).toBe(0);
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

    it("does not list a cancelled import that is waiting for its clean-up to be finished", async () => {
        const left = await importRow("cancelled");
        const open = await importRow("downloading");

        const listed = await playlistImportService.getUserJobs(USER);

        expect(listed.map((j) => j.id)).toEqual([open.id]);
        expect(left.id).not.toBe(open.id);
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

    it("logs the real error of an import that was stopped, and still returns quietly", async () => {
        const running = await importRow("downloading");
        const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        acquire.mockImplementation((async () => {
            await failImportJob(running.id, "stopped elsewhere");
            throw new Error("socket hang up");
        }) as never);

        await expect(run(running.id)).resolves.toBeUndefined();

        expect(warn.mock.calls.some(([message, error]) =>
            String(message).includes(running.id) && (error as Error)?.message === "socket hang up")).toBe(true);
        expect(build).not.toHaveBeenCalled();
    });

    it("does not log an abort that is only the stop", async () => {
        const running = await importRow("downloading");
        const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        acquire.mockImplementation((async () => {
            await failImportJob(running.id, "stopped elsewhere");
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }) as never);

        await run(running.id);

        expect(warn.mock.calls.some(([message]) => String(message).includes(running.id))).toBe(false);
    });

    it("does not write an album's progress over a stop that came from another process", async () => {
        const running = await importRow("downloading");
        acquire.mockImplementation((async () => {
            await prisma.spotifyImportJob.update({ where: { id: running.id }, data: { status: "cancelled" } });
            return { success: false, error: "stubbed" };
        }) as never);

        await run(running.id);

        expect((await prisma.spotifyImportJob.findUnique({ where: { id: running.id } }))?.status).toBe("cancelled");
    }, 5000);

    it("stops waiting for its downloads when the stored import is stopped, whatever its cached copy says", async () => {
        const running = await importRow("downloading");
        const check = jest.spyOn(playlistImportService as any, "checkImportCompletion").mockImplementation((async () => {
            await prisma.spotifyImportJob.update({ where: { id: running.id }, data: { status: "cancelled" } });
            await cacheCopyOpen(running.id);
        }) as never);

        await run(running.id);

        expect(check).toHaveBeenCalledTimes(1);
        expect(build).not.toHaveBeenCalled();
    }, 5000);

    it("does not wait for downloads of an import already stopped when the wait begins", async () => {
        const running = await importRow("downloading");
        acquire.mockImplementation((async () => {
            await prisma.spotifyImportJob.update({ where: { id: running.id }, data: { status: "cancelled" } });
            await cacheCopyOpen(running.id);
            return { success: false, error: "stubbed" };
        }) as never);
        const check = jest.spyOn(playlistImportService as any, "checkImportCompletion").mockResolvedValue(undefined as never);

        await run(running.id);

        expect(check).not.toHaveBeenCalled();
    }, 5000);

    it("never lowers the counts a later write left, whatever order an album's progress lands in", async () => {
        const running = await importRow("downloading");
        acquire.mockImplementation((async () => {
            // A webhook has moved the import on while this album was downloading.
            await prisma.spotifyImportJob.update({ where: { id: running.id }, data: { status: "scanning", progress: 75, albumsCompleted: 5 } });
            return { success: true, source: "soulseek" };
        }) as never);

        await run(running.id);

        const stored = await prisma.spotifyImportJob.findUnique({ where: { id: running.id } });
        expect([stored?.status, stored?.progress, stored?.albumsCompleted]).toEqual(["scanning", 75, 5]);
    }, 5000);

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

describe("a quick import stopped in another process", () => {
    const URL = "https://www.deezer.com/playlist/90210";
    const quickPreview = {
        playlist: { id: "pl", name: "x", description: null, owner: "x", imageUrl: null, trackCount: 1 },
        matchedTracks: [],
        albumsToDownload: [{ albumMbid: "mbid-1", spotifyAlbumId: "sp-1", albumName: "A", artistName: "B", trackCount: 1, tracksNeeded: [{ title: "t", artist: "B" }] }],
        summary: { total: 1, inLibrary: 0, downloadable: 1, notFound: 0 },
    } as never;
    let processImport: jest.SpyInstance;
    beforeEach(() => {
        (readMusicLink as jest.Mock).mockResolvedValue({});
        (previewOfTracklist as jest.Mock).mockResolvedValue(quickPreview);
        processImport = jest.spyOn(playlistImportService as any, "processImport").mockResolvedValue(undefined as never);
    });

    it("stops after the fetch when the stored import is cancelled, whatever its cached copy says", async () => {
        const quick = await importRow("pending");
        (previewOfTracklist as jest.Mock).mockImplementation(async () => {
            await cancelElsewhere(quick.id);
            return quickPreview;
        });

        await playlistImportService.processQuickImportFromQueue(quick.id, URL);

        expect(processImport).not.toHaveBeenCalled();
        expect((await rowOf(quick.id))?.status).toBe("cancelled");
    });

    it("does not write over a stop that lands after the fetch check", async () => {
        const quick = await importRow("pending");
        jest.spyOn(playlistImportService as any, "importerMayAcquire").mockImplementation((async () => {
            await cancelElsewhere(quick.id);
            return true;
        }) as never);

        await playlistImportService.processQuickImportFromQueue(quick.id, URL);

        expect(processImport).not.toHaveBeenCalled();
        expect((await rowOf(quick.id))?.status).toBe("cancelled");
    });
});

describe("checking an import's downloads", () => {
    it("reads the stored import, so a cancel with a cached copy still open leaves its downloads alone", async () => {
        const stopped = await importRow("cancelled");
        const waiting = await downloadJob(stopped.id, "pending");
        await prisma.downloadJob.update({ where: { id: waiting.id }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
        await cacheCopyOpen(stopped.id);

        await playlistImportService.checkImportCompletion(stopped.id);
        await downloadJobs.whenIdle();

        expect((await prisma.downloadJob.findUnique({ where: { id: waiting.id } }))?.status).toBe("pending");
        expect((await rowOf(stopped.id))?.status).toBe("cancelled");
    });
});
