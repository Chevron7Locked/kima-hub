/**
 * An import's row and its playlist are never seen apart, and a late write to the row changes only what it owns. The
 * playlist, its songs, its waiting entries and the job's link to it commit together, so a scan or a dismissal that finds
 * the playlist finds its job; the writes that close an import (completing it, failing it) leave the counts and the
 * listing that a dismissal or a scan changed alone. Real database and Redis.
 */
jest.mock("../deezer", () => ({
    deezerService: { getTrackPreview: jest.fn().mockResolvedValue(null) },
}));
jest.mock("../notificationService", () => ({
    notificationService: { create: jest.fn(), notifyImportComplete: jest.fn(), notifyImportFailed: jest.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { artistIdentityKey } from "../artistIdentity";
import { playlistImportService, getImportJob } from "../playlistImport";
import { deezerService } from "../deezer";
import { distributedLock } from "../../utils/distributedLock";
import { LockLostError } from "../../utils/lockErrors";
import { logger } from "../../utils/logger";
import { dismissWaitingEntry } from "../playlistService";
import { eventBus, type SSEEvent } from "../eventBus";
import { notificationService } from "../notificationService";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-import-writes";
const USER = `${P}-user`;
const JOB = `${P}-job`;
const GHOST = "zzwritesghost";
const GHOST_TITLE = "zzwritesunheard";
let kept: string;

async function cleanup() {
    await redisClient.del(`import:job:${JOB}`);
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { OR: [{ title: { startsWith: P } }] } });
    await prisma.album.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { OR: [{ name: { startsWith: P } }, { name: GHOST }] } });
}

beforeAll(async () => {
    await waitForRedisReady();
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    const name = `${P} band`;
    const artist = await prisma.artist.create({ data: { name, normalizedName: name, identityKey: artistIdentityKey(name) } });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-rg`, identityKey: `${P}-album`, primaryType: "Album", title: `${P} album`, artistId: artist.id, location: "LIBRARY" },
    });
    kept = (await prisma.track.create({
        data: { title: `${P} kept`, albumId: album.id, trackNo: 1, duration: 100, filePath: `${P}/0.flac`, fileModified: new Date(), fileSize: 1 },
    })).id;
});

afterEach(async () => {
    jest.restoreAllMocks();
    (deezerService.getTrackPreview as jest.Mock).mockResolvedValue(null);
    await redisClient.del(`import:job:${JOB}`);
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    await prisma.playlist.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

const listing = (artist: string, title: string, preMatchedTrackId: string | null = null) => ({
    artist, title, album: "x", albumMbid: null, artistMbid: null, preMatchedTrackId, isrc: null,
});
const matched = () => listing(`${P} band`, `${P} kept`, kept);
const waiting = (n: number) => listing(GHOST, `${GHOST_TITLE}${n}`);

const importJob = (entries: ReturnType<typeof listing>[]) => ({
    id: JOB, userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} list`, status: "scanning", progress: 80,
    albumsTotal: 0, albumsCompleted: 0, tracksMatched: 0, tracksTotal: entries.length, tracksDownloadable: 0,
    createdPlaylistId: null as string | null, error: null, sourceUrl: null, createdAt: new Date(), updatedAt: new Date(),
    pendingTracks: entries,
});

const row = () => prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: JOB } });
const titles = (r: { pendingTracks: unknown }) => (r.pendingTracks as Array<{ title: string }>).map((l) => l.title);

describe("building the playlist", () => {
    it("never shows the playlist before its job is linked to it", async () => {
        const seen: Array<{ playlists: number; linked: boolean }> = [];
        (deezerService.getTrackPreview as jest.Mock).mockImplementation(async () => {
            const [playlists, job] = await Promise.all([prisma.playlist.count({ where: { userId: USER } }), row()]);
            seen.push({ playlists, linked: job.createdPlaylistId !== null });
            return null;
        });
        const job = importJob([matched(), waiting(1)]);

        await playlistImportService.buildPlaylist(job as never);

        expect(seen.length).toBeGreaterThan(0);
        // At every moment a person's scan could look, a playlist that exists has its job.
        for (const s of seen) expect(s.playlists === 0 || s.linked).toBe(true);
        const playlist = await prisma.playlist.findFirstOrThrow({ where: { userId: USER } });
        expect((await row()).createdPlaylistId).toBe(playlist.id);
    });

    it("completes the job with the counts it matched and keeps the listing it saved", async () => {
        const entries = [matched(), waiting(1), waiting(2)];
        const job = importJob(entries);

        await playlistImportService.buildPlaylist(job as never);

        const saved = await row();
        expect(saved).toMatchObject({ status: "completed", progress: 100, tracksMatched: 1, tracksTotal: 3 });
        expect(saved.createdPlaylistId).toBe(job.createdPlaylistId);
        expect(titles(saved)).toEqual(entries.map((e) => e.title));
        expect(await prisma.playlistPendingTrack.count({ where: { playlistId: saved.createdPlaylistId! } })).toBe(2);
    });

    it("keeps a dismissal that lands as soon as the playlist exists", async () => {
        const entries = [matched(), waiting(1), waiting(2)];
        const job = importJob(entries);
        // The background retry starts once the playlist is made; a person dismissing an entry meanwhile is the same race.
        let retry: Promise<boolean> = Promise.resolve(false);
        jest.spyOn(playlistImportService as any, "autoRetryPendingTracks").mockImplementation(() => {
            retry = (async () => {
                const playlist = await prisma.playlist.findFirstOrThrow({ where: { userId: USER } });
                const entry = await prisma.playlistPendingTrack.findFirstOrThrow({
                    where: { playlistId: playlist.id, spotifyTitle: `${GHOST_TITLE}1` },
                });
                return dismissWaitingEntry(playlist.id, entry.id);
            })();
            return retry;
        });

        await playlistImportService.buildPlaylist(job as never);
        expect(await retry).toBe(true);

        const saved = await row();
        expect(saved.tracksTotal).toBe(2);
        expect(titles(saved)).toEqual([entries[0].title, entries[2].title]);
        expect((await getImportJob(JOB))!.tracksTotal).toBe(2);
    });
});

describe("a build for a job that was cancelled", () => {
    it("makes no playlist for a job that was cancelled while it matched", async () => {
        const job = importJob([matched(), waiting(1)]);
        jest.spyOn(deezerService, "getTrackPreview").mockImplementation(async () => {
            await prisma.spotifyImportJob.update({ where: { id: JOB }, data: { status: "cancelled" } });
            return null;
        });

        await playlistImportService.buildPlaylist(job as never);

        expect(await prisma.playlist.count({ where: { userId: USER } })).toBe(0);
        expect(await prisma.playlistPendingTrack.count({ where: { playlist: { userId: USER } } })).toBe(0);
        expect((await row()).status).toBe("cancelled");
    });
});

describe("failing an import", () => {
    it("leaves an import that completed meanwhile completed", async () => {
        const job = importJob([matched(), waiting(1)]);
        await playlistImportService.buildPlaylist(job as never);

        await playlistImportService.markJobFailed(JOB, "Worker crashed");

        expect((await row()).status).toBe("completed");
    });

    it("writes only the status and the error, not the counts or listing a dismissal changed since it read the job", async () => {
        const entries = [matched(), waiting(1), waiting(2)];
        const job = importJob(entries);
        await playlistImportService.buildPlaylist(job as never);
        const playlistId = job.createdPlaylistId!;
        // A failure that reaches an import still running (a late scan step), not one that completed.
        await prisma.spotifyImportJob.update({ where: { id: JOB }, data: { status: "scanning" } });
        const entry = await prisma.playlistPendingTrack.findFirstOrThrow({ where: { playlistId, spotifyTitle: `${GHOST_TITLE}1` } });

        // The failure handler has read the job; a person dismisses an entry before it writes.
        const realFind = prisma.spotifyImportJob.findUnique.bind(prisma.spotifyImportJob);
        jest.spyOn(prisma.spotifyImportJob, "findUnique").mockImplementationOnce((async (args: any) => {
            const read = await realFind(args);
            await dismissWaitingEntry(playlistId, entry.id);
            return read;
        }) as any);
        await redisClient.del(`import:job:${JOB}`);

        await playlistImportService.markJobFailed(JOB, "Worker crashed");

        const saved = await row();
        expect(saved).toMatchObject({ status: "failed", error: "Worker crashed", tracksTotal: 2, tracksMatched: 1 });
        expect(titles(saved)).toEqual([entries[0].title, entries[2].title]);
    });
});

describe("an import that ends in an error", () => {
    const preview = { summary: { total: 1, inLibrary: 1 }, albumsToDownload: [], matchedTracks: [] } as never;
    /** The build fails; `meanwhile` is what happened to the import's row while the worker was at it. */
    const crash = (job: ReturnType<typeof importJob>, meanwhile?: () => Promise<unknown>) => {
        jest.spyOn(playlistImportService, "buildPlaylist").mockImplementation(async () => {
            await meanwhile?.();
            throw new Error("Disk full");
        });
        return (playlistImportService as any).processImport(job, [], preview);
    };
    const setRow = (data: Record<string, unknown>) => () => prisma.spotifyImportJob.update({ where: { id: JOB }, data });
    const withRow = (status: string) =>
        prisma.spotifyImportJob.create({
            data: { id: JOB, userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} list`, status, albumsTotal: 0, tracksTotal: 1, pendingTracks: [matched()] as any },
        });

    beforeEach(() => (notificationService.notifyImportFailed as jest.Mock).mockClear());

    it("is marked failed in its row and its owner told", async () => {
        await withRow("scanning");

        await expect(crash(importJob([matched()]))).rejects.toThrow("Disk full");

        expect(await row()).toMatchObject({ status: "failed", error: "Disk full" });
        expect(notificationService.notifyImportFailed).toHaveBeenCalledTimes(1);
    });

    it("leaves an import a person cancelled meanwhile cancelled, and tells no one it failed", async () => {
        await withRow("scanning");

        await expect(crash(importJob([matched()]), setRow({ status: "cancelled" }))).rejects.toThrow("Disk full");

        expect((await row()).status).toBe("cancelled");
        expect(notificationService.notifyImportFailed).not.toHaveBeenCalled();
    });

    it("keeps the reason an import already failed with, and tells its owner only once", async () => {
        await withRow("scanning");

        await expect(
            crash(importJob([matched()]), setRow({ status: "failed", error: "No download jobs were created" })),
        ).rejects.toThrow("Disk full");

        expect(await row()).toMatchObject({ status: "failed", error: "No download jobs were created" });
        expect(notificationService.notifyImportFailed).not.toHaveBeenCalled();
    });

    it("throws the error that ended the import when recording it fails too", async () => {
        await withRow("scanning");
        jest.spyOn(prisma.spotifyImportJob, "updateMany").mockRejectedValueOnce(new Error("connection lost"));

        await expect(crash(importJob([matched()]))).rejects.toThrow("Disk full");
    });
});

describe("telling the import page", () => {
    it("announces a change that was written, and nothing for one that was refused", async () => {
        const heard: SSEEvent[] = [];
        const stop = eventBus.subscribe(USER, { send: (event) => (heard.push(event), true) });
        try {
            await prisma.spotifyImportJob.create({
                data: { id: JOB, userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} list`, status: "scanning", albumsTotal: 0, tracksTotal: 1, pendingTracks: [matched()] as any },
            });
            await playlistImportService.markJobFailed(JOB, "Worker crashed");
            expect(heard.filter((e) => e.type === "import:progress").map((e) => e.payload.status)).toEqual(["failed"]);

            heard.length = 0;
            await prisma.spotifyImportJob.update({ where: { id: JOB }, data: { status: "completed" } });
            await playlistImportService.markJobFailed(JOB, "Worker crashed again");

            expect((await row()).status).toBe("completed");
            expect(heard.filter((e) => e.type === "import:progress")).toEqual([]);
        } finally {
            stop();
        }
    });
});

describe("one build per import", () => {
    const build = (job: ReturnType<typeof importJob>) => playlistImportService.buildPlaylist(job as never);

    it("makes one playlist when two builds of the same import run together", async () => {
        const entries = [matched(), waiting(1)];
        // Both builds are held at the same point, after they have read the job and before either has committed.
        let arrived = 0;
        let release!: () => void;
        const together = new Promise<void>((resolve) => { release = resolve; });
        (deezerService.getTrackPreview as jest.Mock).mockImplementation(async () => {
            arrived++;
            if (arrived >= 2) release();
            await Promise.race([together, new Promise((resolve) => setTimeout(resolve, 400))]);
            return null;
        });

        await Promise.all([build(importJob(entries)), build(importJob(entries))]);

        expect(await prisma.playlist.count({ where: { userId: USER } })).toBe(1);
        const saved = await row();
        const playlist = await prisma.playlist.findFirstOrThrow({ where: { userId: USER } });
        expect(saved).toMatchObject({ status: "completed", createdPlaylistId: playlist.id });
    });

    it("leaves the link of an import another build already finished, though this build still holds the old copy", async () => {
        const entries = [matched(), waiting(1)];
        const first = importJob(entries);
        await build(first);
        const linked = first.createdPlaylistId!;
        // The row is back at "scanning" for a late step, still linked; a build holding a copy from before the link runs now.
        await prisma.spotifyImportJob.update({ where: { id: JOB }, data: { status: "scanning" } });

        await build(importJob(entries));

        expect(await prisma.playlist.count({ where: { userId: USER } })).toBe(1);
        expect((await row()).createdPlaylistId).toBe(linked);
    });

    it("keeps the listing the row holds when the build's copy of the job is older", async () => {
        const entries = [matched(), waiting(1), waiting(2)];
        // A dismissal already took an entry out of the row; this build's copy still lists all three.
        await prisma.spotifyImportJob.create({
            data: {
                id: JOB, userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} list`, status: "scanning", progress: 80,
                albumsTotal: 0, albumsCompleted: 0, tracksMatched: 0, tracksDownloadable: 0, tracksTotal: 2, pendingTracks: [entries[0], entries[2]] as any,
            },
        });

        await build(importJob(entries));

        expect(titles(await row())).toEqual([entries[0].title, entries[2].title]);
    });

    it("builds from the listing the row holds, so a song dismissed while the build waited is not built", async () => {
        const entries = [matched(), waiting(1), waiting(2)];
        await prisma.spotifyImportJob.create({
            data: {
                id: JOB, userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} list`, status: "scanning", progress: 80,
                albumsTotal: 0, albumsCompleted: 0, tracksMatched: 0, tracksDownloadable: 0, tracksTotal: 2, pendingTracks: [entries[0], entries[2]] as any,
            },
        });

        await build(importJob(entries));

        const playlist = await prisma.playlist.findFirstOrThrow({ where: { userId: USER } });
        const waitingTitles = (await prisma.playlistPendingTrack.findMany({ where: { playlistId: playlist.id } })).map((e) => e.spotifyTitle);
        expect(waitingTitles).toEqual([entries[2].title]);
    });

    it("still builds when Redis is down, for there is then no lock to take", async () => {
        const acquire = jest.spyOn(distributedLock, "acquire").mockResolvedValue({ outcome: "unavailable", error: new Error("down") });
        try {
            await build(importJob([matched()]));
            expect(acquire).toHaveBeenCalled();
        } finally {
            acquire.mockRestore();
        }

        expect(await prisma.playlist.count({ where: { userId: USER } })).toBe(1);
    });

    it("leaves the build to the process that holds the import's lock", async () => {
        await redisClient.set(`lock:import-build:${JOB}`, "another-process", "PX", 5000);
        try {
            await build(importJob([matched()]));
        } finally {
            await redisClient.del(`lock:import-build:${JOB}`);
        }

        expect(await prisma.playlist.count({ where: { userId: USER } })).toBe(0);
    });

    it("stops at its next step when the import's lock is lost mid-build, leaving the job to be built again", async () => {
        const lost = new AbortController();
        const acquire = jest.spyOn(distributedLock, "acquire").mockResolvedValue({
            outcome: "acquired",
            lease: { signal: lost.signal, release: async () => "lost" as const, keepAlive: () => () => undefined },
        });
        // The lock goes while the previews of the waiting songs are fetched.
        (deezerService.getTrackPreview as jest.Mock).mockImplementation(async () => {
            lost.abort(new LockLostError(`import-build:${JOB}`));
            return null;
        });
        const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
        try {
            await build(importJob([matched(), waiting(1)]));
        } finally {
            acquire.mockRestore();
        }

        expect(await prisma.playlist.count({ where: { userId: USER } })).toBe(0);
        // Still waiting for its playlist, so the build that holds the lock now (or the next scan's) makes it.
        expect(await row()).toMatchObject({ status: "creating_playlist", createdPlaylistId: null });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("was lost: this build stopped"));
    });

    it("takes the lock for an import only while it builds", async () => {
        await build(importJob([matched()]));

        expect(await redisClient.get(`lock:import-build:${JOB}`)).toBeNull();
    });
});
