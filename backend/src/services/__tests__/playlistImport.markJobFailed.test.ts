/**
 * An import the worker gives up on reaches the user's tray, whether it matched
 * nothing (and is removed) or matched some tracks (and is kept), as one row per import.
 * The real notification service on the real database.
 */

const loggerLines: string[] = [];
jest.mock("../../utils/playlistLogger", () => {
    const actual = jest.requireActual("../../utils/playlistLogger");
    const logger = new Proxy({}, { get: () => (message: unknown) => { if (typeof message === "string") loggerLines.push(message); } });
    return { ...actual, createPlaylistLogger: () => logger };
});

import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { playlistImportService } from "../playlistImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "sif_user";
const JOB = "sif_job";

const importJob = (pendingTracks: unknown[], status = "downloading") =>
    prisma.spotifyImportJob.create({
        data: {
            id: JOB,
            userId: USER,
            spotifyPlaylistId: "pl",
            playlistName: "Road Trip",
            status,
            albumsTotal: 1,
            tracksTotal: 1,
            pendingTracks: pendingTracks as any,
        },
    });

const trayRows = () => prisma.notification.findMany({ where: { userId: USER, title: "Import failed" } });

const wipeJob = async () => {
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    await redisClient.del(`import:job:${JOB}`);
};

beforeEach(wipeJob);

// The service reports without waiting (fire and forget), so the row lands a moment later.
const waitFor = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await done()); i++) await new Promise((r) => setTimeout(r, 20));
};
const waitForRows = (n: number) => waitFor(async () => (await trayRows()).length >= n);

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterEach(wipeJob);

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("tells the user when an import that matched nothing fails", async () => {
    await importJob([{ artist: "Interpol", title: "Evil" }]);

    await playlistImportService.markJobFailed(JOB, "Worker crashed");

    await waitForRows(1);
    expect((await trayRows()).map((n) => n.message)).toEqual(['"Road Trip": Worker crashed']);
    expect(await prisma.spotifyImportJob.count({ where: { id: JOB } })).toBe(0);
});

it("tells the user once and keeps a partly matched import", async () => {
    await importJob([{ artist: "Interpol", title: "Evil", preMatchedTrackId: "t1" }]);

    // The import's own catch reports first, then the worker's failure handler: still one row.
    await playlistImportService.markJobFailed(JOB, "Lidarr unreachable");
    await waitForRows(1);
    await playlistImportService.markJobFailed(JOB, "Worker crashed");
    await waitFor(async () => (await trayRows())[0]?.message === '"Road Trip": Worker crashed');

    expect((await trayRows()).map((n) => n.message)).toEqual(['"Road Trip": Worker crashed']);
    expect((await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: JOB } })).status).toBe("failed");
});

describe("a late worker failure", () => {
    // Give the tray the time it would need to show a row, so "no row" is a real answer.
    const settle = () => new Promise((r) => setTimeout(r, 300));

    it("does not announce a failure for an import that completed meanwhile, and leaves it completed", async () => {
        await importJob([{ artist: "Interpol", title: "Evil", preMatchedTrackId: "t1" }], "completed");

        await playlistImportService.markJobFailed(JOB, "Worker crashed");
        await settle();

        expect(await trayRows()).toEqual([]);
        expect((await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: JOB } })).status).toBe("completed");
    });

    it("does not announce, or remove, a completed import that kept no matched listing", async () => {
        await importJob([{ artist: "Interpol", title: "Evil" }], "completed");

        await playlistImportService.markJobFailed(JOB, "Worker crashed");
        await settle();

        expect(await trayRows()).toEqual([]);
        expect((await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: JOB } })).status).toBe("completed");
    });

    it("lets go of the import's log, so a later cancel does not find it", async () => {
        loggerLines.length = 0;
        const preview = {
            summary: { total: 1, inLibrary: 1 },
            albumsToDownload: [],
            matchedTracks: [{ spotifyTrack: { spotifyId: "s1", title: "Evil", artist: "Interpol", album: "A", albumId: "" }, localTrack: { id: "t1" } }],
        } as never;
        const started = await playlistImportService.startImport(USER, "pl", "Road Trip", [], preview);
        await playlistImportService.markJobFailed(started.id, "Worker crashed");
        loggerLines.length = 0;

        await playlistImportService.cancelJob(started.id);

        expect(loggerLines).not.toContain("Job cancelled by user");
        await prisma.spotifyImportJob.deleteMany({ where: { id: started.id } });
        await redisClient.del(`import:job:${started.id}`);
    });
});
