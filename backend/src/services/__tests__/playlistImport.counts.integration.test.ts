/**
 * The counts a person reads on an import (songs matched, listings in all) stay true while songs are found and entries
 * are dismissed, however those overlap: a scan or refresh that places songs raises the matched count in the same locked
 * step, two of them finishing together both count, and a refresh never writes back a copy of the job it loaded before
 * it started. Real database and Redis.
 */
jest.mock("../deezer", () => ({
    deezerService: { getTrackPreview: jest.fn().mockResolvedValue(null) },
}));
jest.mock("../notificationService", () => ({
    notificationService: { create: jest.fn(), notifyImportComplete: jest.fn(), notifyImportFailed: jest.fn() },
}));

// A plain copy of the matching part, so a test can pause one of its calls.
jest.mock("../playlistImport/matching", () => ({ ...jest.requireActual("../playlistImport/matching"), __esModule: true }));

import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { artistIdentityKey } from "../artistIdentity";
import { playlistImportService, getImportJob, announceImportCounts } from "../playlistImport";
import { eventBus } from "../eventBus";
import * as matching from "../playlistImport/matching";
import { dismissWaitingEntry, placeFoundSongs } from "../playlistService";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-import-counts";
const USER = `${P}-user`;
const JOB = `${P}-job`;
const GHOST = "zzcountghost";
const GHOST_TITLE = "zzcountunheard";
let kept: string; // a library song the import matched at once
let ghostAlbumId: string;

async function cleanup() {
    await redisClient.del(`import:job:${JOB}`);
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { OR: [{ title: { startsWith: P } }, { title: { startsWith: GHOST_TITLE } }] } });
    await prisma.album.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { OR: [{ name: { startsWith: P } }, { name: GHOST }] } });
}

async function artistAlbum(name: string, key: string) {
    const artist = await prisma.artist.create({ data: { name, normalizedName: name, identityKey: artistIdentityKey(name) } });
    return prisma.album.create({
        data: { rgMbid: `${P}-rg-${key}`, identityKey: `${P}-album-${key}`, primaryType: "Album", title: `${P} album ${key}`, artistId: artist.id, location: "LIBRARY" },
    });
}

beforeAll(async () => {
    await waitForRedisReady();
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    const album = await artistAlbum(`${P} band`, "main");
    kept = (await prisma.track.create({
        data: { title: `${P} kept`, albumId: album.id, trackNo: 1, duration: 100, filePath: `${P}/main/0.flac`, fileModified: new Date(), fileSize: 1 },
    })).id;
    ghostAlbumId = (await artistAlbum(GHOST, "ghost")).id;
});

afterEach(async () => {
    jest.restoreAllMocks();
    await redisClient.del(`import:job:${JOB}`);
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { albumId: ghostAlbumId } });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

const listing = (artist: string, title: string) => ({ artist, title, album: "x", albumMbid: null, artistMbid: null, preMatchedTrackId: null, isrc: null });
const matched = () => listing(`${P} band`, `${P} kept`);
const waiting = (n: number) => listing(GHOST, `${GHOST_TITLE}${n}`);

/** An import that matched `entries[0]` at once and left the rest waiting; returns its playlist. */
async function importOf(entries: ReturnType<typeof listing>[]) {
    const job = {
        id: JOB, userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} list`, status: "scanning", progress: 80,
        albumsTotal: 0, albumsCompleted: 0, tracksMatched: 0, tracksTotal: entries.length, tracksDownloadable: 0, createdPlaylistId: null as string | null,
        error: null, sourceUrl: null, createdAt: new Date(), updatedAt: new Date(), pendingTracks: entries,
    };
    await playlistImportService.buildPlaylist(job as never);
    return job.createdPlaylistId!;
}

/** The library finds the song a waiting listing named. */
async function libraryGains(n: number) {
    return prisma.track.create({
        data: { title: `${GHOST_TITLE}${n}`, albumId: ghostAlbumId, trackNo: n, duration: 100, filePath: `${P}/ghost/${n}.flac`, fileModified: new Date(), fileSize: 1 },
    });
}
const counts = async () => {
    const job = await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: JOB } });
    return { matched: job.tracksMatched, total: job.tracksTotal };
};
const waitingIds = async (playlistId: string) =>
    (await prisma.playlistPendingTrack.findMany({ where: { playlistId }, orderBy: { rank: "asc" } })).map((p) => p.id);

describe("songs a scan or a refresh places", () => {
    it("raise the import's matched count, so the page stops showing them as missing", async () => {
        const playlistId = await importOf([matched(), waiting(1), waiting(2)]);
        expect(await counts()).toEqual({ matched: 1, total: 3 });
        await libraryGains(1);
        await playlistImportService.reconcilePendingTracks(playlistId);
        expect(await counts()).toEqual({ matched: 2, total: 3 });
        await libraryGains(2);
        const result = await playlistImportService.refreshJobMatches(JOB);
        expect(result).toEqual({ added: 1, total: 3 });
        expect(await counts()).toEqual({ matched: 3, total: 3 });
        expect((await getImportJob(JOB))!.tracksMatched).toBe(3);
    });

    it("count once each when a scan and a refresh find the same songs at the same moment", async () => {
        const playlistId = await importOf([matched(), waiting(1), waiting(2)]);
        await libraryGains(1);
        await libraryGains(2);
        const [, refreshed, again] = await Promise.all([
            playlistImportService.reconcilePendingTracks(playlistId),
            playlistImportService.refreshJobMatches(JOB),
            playlistImportService.refreshJobMatches(JOB),
        ]);
        expect(await prisma.playlistPendingTrack.count({ where: { playlistId } })).toBe(0);
        expect(await prisma.playlistItem.count({ where: { playlistId } })).toBe(3);
        expect(await counts()).toEqual({ matched: 3, total: 3 });
        expect(refreshed.total).toBeLessThanOrEqual(3);
        expect(again.total).toBeLessThanOrEqual(3);
    });

    it("all count when placed by overlapping writers", async () => {
        const playlistId = await importOf([matched(), waiting(1), waiting(2)]);
        const one = await libraryGains(1);
        const two = await libraryGains(2);
        const [a, b] = await waitingIds(playlistId);
        await Promise.all([
            placeFoundSongs(playlistId, [{ trackId: one.id, pendingId: a }]),
            placeFoundSongs(playlistId, [{ trackId: two.id, pendingId: b }]),
        ]);
        expect(await counts()).toEqual({ matched: 3, total: 3 });
    });

    it("are not counted twice when another writer already answered the entry", async () => {
        const playlistId = await importOf([matched(), waiting(1)]);
        const one = await libraryGains(1);
        const [a] = await waitingIds(playlistId);
        await placeFoundSongs(playlistId, [{ trackId: one.id, pendingId: a }]);
        await placeFoundSongs(playlistId, [{ trackId: one.id, pendingId: a }]);
        expect(await counts()).toEqual({ matched: 2, total: 2 });
    });

    it("leave a playlist that no import made alone", async () => {
        const playlist = await prisma.playlist.create({ data: { userId: USER, name: `${P} mine` } });
        const entry = await prisma.playlistPendingTrack.create({
            data: { playlistId: playlist.id, spotifyArtist: "A", spotifyTitle: "T", spotifyAlbum: "x", sort: 0, rank: "a" },
        });
        await expect(placeFoundSongs(playlist.id, [{ trackId: kept, pendingId: entry.id }])).resolves.toHaveLength(1);
    });
});

describe("an import whose row was made before its listing was known", () => {
    it("keeps the listing it saves, so a dismissal can take its entry off it", async () => {
        await prisma.spotifyImportJob.create({
            data: { id: JOB, userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} list`, status: "scanning", albumsTotal: 0, tracksTotal: 3, pendingTracks: [] },
        });
        const entries = [matched(), waiting(1), waiting(2)];
        const playlistId = await importOf(entries);
        const saved = await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: JOB } });
        expect((saved.pendingTracks as Array<{ title: string }>).map((l) => l.title)).toEqual(entries.map((e) => e.title));

        const [first] = await waitingIds(playlistId);
        await dismissWaitingEntry(playlistId, first);
        const after = await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: JOB } });
        expect((after.pendingTracks as Array<{ title: string }>).map((l) => l.title)).toEqual([entries[0].title, entries[2].title]);
        expect(after.tracksTotal).toBe(2);
    });
});

describe("the person's open import page", () => {
    /** The import:progress events the person's connected clients get while `run` runs. */
    async function progressDuring(run: () => Promise<unknown>) {
        const seen: Array<Record<string, unknown>> = [];
        const unsubscribe = eventBus.subscribe(USER, {
            send: (event) => {
                if (event.type === "import:progress") seen.push(event.payload);
                return true;
            },
        });
        try {
            await run();
        } finally {
            unsubscribe();
        }
        return seen;
    }

    it("is told the new counts when a scan places songs", async () => {
        const playlistId = await importOf([matched(), waiting(1), waiting(2)]);
        await libraryGains(1);
        const seen = await progressDuring(() => playlistImportService.reconcilePendingTracks(playlistId));
        expect(seen.at(-1)).toMatchObject({ jobId: JOB, tracksMatched: 2, tracksTotal: 3 });
    });

    it("is told nothing when a scan places nothing", async () => {
        const playlistId = await importOf([matched(), waiting(1)]);
        expect(await progressDuring(() => playlistImportService.reconcilePendingTracks(playlistId))).toEqual([]);
    });

    it("is told the new counts when a waiting song is dismissed", async () => {
        const playlistId = await importOf([matched(), waiting(1), waiting(2)]);
        const [first] = await waitingIds(playlistId);
        const seen = await progressDuring(async () => {
            await dismissWaitingEntry(playlistId, first);
            await announceImportCounts(playlistId);
        });
        expect(seen.at(-1)).toMatchObject({ jobId: JOB, tracksMatched: 1, tracksTotal: 2 });
    });

    it("is told nothing for a playlist no import made", async () => {
        const playlist = await prisma.playlist.create({ data: { userId: USER, name: `${P} mine` } });
        expect(await progressDuring(() => announceImportCounts(playlist.id))).toEqual([]);
    });
});

describe("a refresh that overlaps another change to the import", () => {
    it("does not write back the counts it loaded before it started", async () => {
        const playlistId = await importOf([matched(), waiting(1), waiting(2)]);
        await libraryGains(1);
        const [, second] = await waitingIds(playlistId);
        // The refresh has loaded the job and matched, and is paused before it places anything.
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let paused!: () => void;
        const isPaused = new Promise<void>((r) => (paused = r));
        const realMatch = matching.matchEntries;
        jest.spyOn(matching, "matchEntries").mockImplementationOnce(async (...args) => {
            const found = await realMatch(...args);
            paused();
            await gate;
            return found;
        });
        const refreshed = playlistImportService.refreshJobMatches(JOB);
        await isPaused;
        await dismissWaitingEntry(playlistId, second); // the import now lists 2 songs in all
        release();
        expect(await refreshed).toEqual({ added: 1, total: 2 });
        expect(await counts()).toEqual({ matched: 2, total: 2 });
    });
});
