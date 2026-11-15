/**
 * A song a playlist import was waiting for takes the place it had in the source when a scan or a refresh finds it:
 * between its neighbours, as the page showed it while it waited, not at the end. Songs a person added or moved by hand
 * keep their order; only the found song slots in. Real database and Redis.
 */
jest.mock("../deezer", () => ({
    deezerService: { getTrackPreview: jest.fn().mockResolvedValue(null) },
}));
jest.mock("../notificationService", () => ({
    notificationService: { create: jest.fn(), notifyImportComplete: jest.fn(), notifyImportFailed: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { artistIdentityKey } from "../artistIdentity";
import { spotifyImportService } from "../spotifyImport";
import * as playlistService from "../playlistService";
import { moveItem } from "../playlistService";
import { eventBus, type SSEEvent } from "../eventBus";
import { notificationService } from "../notificationService";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-import-place";
const USER = `${P}-user`;
const JOB = `${P}-job`;
const GHOST = "zzplaceghost";
const GHOST_TITLE = "zzplaceunheard";
const WORDS = ["alpha", "bravo", "charlie"];
let ids: string[]; // library songs: alpha, bravo, charlie
let ghostAlbumId: string;

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { OR: [{ title: { startsWith: P } }, { title: GHOST_TITLE }] } });
    await prisma.album.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { OR: [{ name: { startsWith: P } }, { name: GHOST }] } });
}

async function artistAlbum(name: string, key: string) {
    const artist = await prisma.artist.create({ data: { name, normalizedName: name, identityKey: artistIdentityKey(name) } });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-rg-${key}`, identityKey: `${P}-album-${key}`, primaryType: "Album", title: `${P} album ${key}`, artistId: artist.id, location: "LIBRARY" },
    });
    return { artist, album };
}

beforeAll(async () => {
    await waitForRedisReady();
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    const { album } = await artistAlbum(`${P} band`, "main");
    ids = [];
    for (const [i, word] of WORDS.entries()) {
        const track = await prisma.track.create({
            data: { title: `${P} ${word}`, albumId: album.id, trackNo: i + 1, duration: 100, filePath: `${P}/main/${i}.flac`, fileModified: new Date(), fileSize: 1 },
        });
        ids.push(track.id);
    }
    ghostAlbumId = (await artistAlbum(GHOST, "ghost")).album.id;
});

afterEach(async () => {
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
const entry = (i: number) => listing(`${P} band`, `${P} ${WORDS[i]}`);
const waiting = () => listing(GHOST, GHOST_TITLE);

async function importOf(entries: ReturnType<typeof listing>[], id = JOB) {
    const job = {
        id, userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} list`, status: "scanning", progress: 80,
        albumsTotal: 0, albumsCompleted: 0, tracksMatched: 0, tracksTotal: entries.length, tracksDownloadable: 0, createdPlaylistId: null as string | null,
        error: null, sourceUrl: null, createdAt: new Date(), updatedAt: new Date(), pendingTracks: entries,
    };
    await (spotifyImportService as any).buildPlaylist(job);
    return job.createdPlaylistId!;
}

/** The library finds the song the import was waiting for. */
async function libraryGains() {
    return prisma.track.create({
        data: { title: GHOST_TITLE, albumId: ghostAlbumId, trackNo: 1, duration: 100, filePath: `${P}/ghost/1.flac`, fileModified: new Date(), fileSize: 1 },
    });
}

/** The playlist as the page lists it: items and waiting entries in one rank order, waiting ones as "waiting". */
async function pageOrder(playlistId: string) {
    const [items, pending] = await Promise.all([
        prisma.playlistItem.findMany({ where: { playlistId } }),
        prisma.playlistPendingTrack.findMany({ where: { playlistId } }),
    ]);
    return [...items.map((i) => ({ rank: i.rank, what: i.trackId })), ...pending.map((p) => ({ rank: p.rank, what: "waiting" }))]
        .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
        .map((e) => e.what);
}
const held = async (playlistId: string) =>
    (await prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" } })).map((i) => i.trackId);

describe("a scan that finds a waiting song", () => {
    it("puts it where the source had it, between its neighbours", async () => {
        const playlistId = await importOf([entry(0), waiting(), entry(1)]);
        expect(await held(playlistId)).toEqual([ids[0], ids[1]]);
        const x = await libraryGains();
        await spotifyImportService.reconcilePendingTracks(playlistId);
        expect(await held(playlistId)).toEqual([ids[0], x.id, ids[1]]);
        expect(await prisma.playlistPendingTrack.count({ where: { playlistId } })).toBe(0);
    });

    it("puts each copy of a song listed twice in its own place", async () => {
        const playlistId = await importOf([waiting(), entry(0), waiting()]);
        const x = await libraryGains();
        await spotifyImportService.reconcilePendingTracks(playlistId);
        expect(await held(playlistId)).toEqual([x.id, ids[0], x.id]);
    });

    it("puts a song that was first or last in the source first or last", async () => {
        const playlistId = await importOf([waiting(), entry(0), entry(1), waiting()]);
        const x = await libraryGains();
        await spotifyImportService.reconcilePendingTracks(playlistId);
        expect(await held(playlistId)).toEqual([x.id, ids[0], ids[1], x.id]);
    });

    it("keeps the order a person gave the other songs, and slots the found one in where the page showed it", async () => {
        const playlistId = await importOf([entry(0), waiting(), entry(1), entry(2)]);
        const [a, , c] = await prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" } });
        await moveItem(playlistId, a.id, c.id); // alpha now after charlie
        const shown = await pageOrder(playlistId);
        expect(shown).toEqual(["waiting", ids[1], ids[2], ids[0]]);
        const x = await libraryGains();
        await spotifyImportService.reconcilePendingTracks(playlistId);
        expect(await held(playlistId)).toEqual(shown.map((what) => (what === "waiting" ? x.id : what)));
    });

    it("leaves a song a person added by hand where they put it", async () => {
        const playlistId = await importOf([entry(0), waiting(), entry(1)]);
        const mine = await prisma.playlistItem.create({ data: { playlistId, trackId: ids[2], sort: 9, rank: "zzz" } });
        const x = await libraryGains();
        await spotifyImportService.reconcilePendingTracks(playlistId);
        const order = await prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" } });
        expect(order.map((i) => i.trackId)).toEqual([ids[0], x.id, ids[1], ids[2]]);
        expect(order[3].id).toBe(mine.id);
    });

    it("adds the song once when two scans find it at the same moment", async () => {
        const playlistId = await importOf([entry(0), waiting(), entry(1)]);
        const x = await libraryGains();
        await Promise.all([spotifyImportService.reconcilePendingTracks(playlistId), spotifyImportService.reconcilePendingTracks(playlistId)]);
        expect(await held(playlistId)).toEqual([ids[0], x.id, ids[1]]);
    });
});

describe("a refresh that finds a waiting song", () => {
    async function jobFor(playlistId: string, entries: ReturnType<typeof listing>[]) {
        await redisClient.del(`import:job:${JOB}`);
        const data = {
            userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} list`, status: "completed",
            albumsTotal: 0, tracksTotal: entries.length, createdPlaylistId: playlistId, pendingTracks: entries,
        };
        await prisma.spotifyImportJob.upsert({ where: { id: JOB }, update: data, create: { id: JOB, ...data } });
    }

    it("puts it where the source had it", async () => {
        const playlistId = await importOf([entry(0), waiting(), entry(1)]);
        await jobFor(playlistId, [waiting()]);
        const x = await libraryGains();
        const result = await spotifyImportService.refreshJobMatches(JOB);
        expect(result.added).toBe(1);
        expect(await held(playlistId)).toEqual([ids[0], x.id, ids[1]]);
        expect(await prisma.playlistPendingTrack.count({ where: { playlistId } })).toBe(0);
    });

    it("fills a waiting listing even when the playlist already holds that song from elsewhere", async () => {
        const playlistId = await importOf([entry(0), waiting(), entry(1)]);
        const x = await libraryGains();
        await prisma.playlistItem.create({ data: { playlistId, trackId: x.id, sort: 9, rank: "zzz" } }); // added by hand
        await jobFor(playlistId, [waiting()]);
        const result = await spotifyImportService.refreshJobMatches(JOB);
        expect(result.added).toBe(1);
        expect(await held(playlistId)).toEqual([ids[0], x.id, ids[1], x.id]);
        expect(await prisma.playlistPendingTrack.count({ where: { playlistId } })).toBe(0);
    });

    it("matches a waiting entry the way a scan does: a listing with a version suffix finds the plain song, and a compilation's song is found by title", async () => {
        const suffixed = listing(GHOST, `${GHOST_TITLE} - Remastered 2011`);
        const onCompilation = listing("zzplaceother", `${P} compilation song`);
        const playlistId = await importOf([suffixed, entry(0), onCompilation]);
        await jobFor(playlistId, [suffixed, onCompilation]);
        const x = await libraryGains();
        const y = await prisma.track.create({
            data: { title: `${P} compilation song`, albumId: ghostAlbumId, trackNo: 2, duration: 100, filePath: `${P}/ghost/2.flac`, fileModified: new Date(), fileSize: 1 },
        });
        const result = await spotifyImportService.refreshJobMatches(JOB);
        expect(result.added).toBe(2);
        expect(await held(playlistId)).toEqual([x.id, ids[0], y.id]);
        expect(await prisma.playlistPendingTrack.count({ where: { playlistId } })).toBe(0);
    });

    it("does not bring back a waiting entry the person removed", async () => {
        const playlistId = await importOf([entry(0), waiting(), entry(1)]);
        await jobFor(playlistId, [waiting()]);
        const entryRow = await prisma.playlistPendingTrack.findFirstOrThrow({ where: { playlistId } });
        await prisma.playlistPendingTrack.delete({ where: { id: entryRow.id } }); // DELETE /playlists/:id/pending/:trackId
        await libraryGains();
        const result = await spotifyImportService.refreshJobMatches(JOB);
        expect(result.added).toBe(0);
        expect(await held(playlistId)).toEqual([ids[0], ids[1]]);
    });

    it("adds a song only for the waiting entries that are still there", async () => {
        const playlistId = await importOf([waiting(), entry(0), waiting()]);
        await jobFor(playlistId, [waiting(), waiting()]);
        const [first] = await prisma.playlistPendingTrack.findMany({ where: { playlistId }, orderBy: { rank: "asc" } });
        await prisma.playlistPendingTrack.delete({ where: { id: first.id } });
        const x = await libraryGains();
        const result = await spotifyImportService.refreshJobMatches(JOB);
        expect(result.added).toBe(1);
        expect(await held(playlistId)).toEqual([ids[0], x.id]);
    });

    it("puts each copy of a song listed twice in its own place", async () => {
        const playlistId = await importOf([waiting(), entry(0), waiting()]);
        await jobFor(playlistId, [waiting(), waiting()]);
        const x = await libraryGains();
        const result = await spotifyImportService.refreshJobMatches(JOB);
        expect(result.added).toBe(2);
        expect(await held(playlistId)).toEqual([x.id, ids[0], x.id]);
    });
});

describe("a scan over every playlist", () => {
    it("finishes the playlists after one that fails, and tells their owners", async () => {
        const first = await importOf([entry(0), waiting()]);
        // Two imports, so two jobs: one build makes one playlist per job.
        const second = await importOf([entry(1), waiting()], `${JOB}-2`);
        const [broken, sound] = [first, second].sort();
        const x = await libraryGains();
        const place = playlistService.placeFoundSongs;
        const spy = jest.spyOn(playlistService, "placeFoundSongs").mockImplementation((playlistId, found) =>
            playlistId === broken ? Promise.reject(new Error("playlist locked")) : place(playlistId, found)
        );
        const heard: SSEEvent[] = [];
        const stop = eventBus.subscribe(USER, { send: (event) => (heard.push(event), true) });
        (notificationService.create as jest.Mock).mockClear();
        try {
            const result = await spotifyImportService.reconcilePendingTracks();
            expect(result).toEqual({ playlistsUpdated: 1, tracksAdded: 1 });
        } finally {
            stop();
            spy.mockRestore();
        }
        expect((await held(sound)).includes(x.id)).toBe(true);
        expect((await held(broken)).includes(x.id)).toBe(false);
        expect(heard.filter((e) => e.type === "playlist:updated").map((e) => e.payload)).toEqual([{ playlistId: sound, deleted: false }]);
        expect(notificationService.create).toHaveBeenCalledTimes(1);
        expect((notificationService.create as jest.Mock).mock.calls[0][0].metadata).toEqual({ playlistId: sound, tracksAdded: 1 });
    });
});
