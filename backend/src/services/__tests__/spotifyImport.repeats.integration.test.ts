/**
 * A playlist an import makes keeps a song the source lists more than once, one item per listing, in the source's
 * order, and what the import counts as matched is listings, not distinct songs. A later refresh or scan adds only the
 * copies the playlist is short of, and a waiting entry that resolves to a song already in the playlist joins as
 * another copy. Real database and Redis.
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
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-import-repeats";
const USER = `${P}-user`;
const JOB = `${P}-job`;
const SONGS = ["alpha", "bravo", "charlie"].map((word) => `${P} ${word} song`);
let ids: string[];

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { OR: [{ title: { startsWith: P } }, { title: "zzunheard" }] } });
    await prisma.album.deleteMany({ where: { OR: [{ title: { startsWith: P } }, { title: "zzghost album" }] } });
    await prisma.artist.deleteMany({ where: { OR: [{ name: { startsWith: P } }, { name: "zzghost" }] } });
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
    ids = [];
    for (const [i, title] of SONGS.entries()) {
        const track = await prisma.track.create({
            data: { title, albumId: album.id, trackNo: i + 1, duration: 100, filePath: `${P}/album/${i}.flac`, fileModified: new Date(), fileSize: 1 },
        });
        ids.push(track.id);
    }
});

afterEach(async () => {
    await redisClient.del(`import:job:${JOB}`);
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    await prisma.playlist.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

const heldBy = async (playlistId: string) =>
    (await prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" } })).map((i) => i.trackId);
const entry = (i: number) => ({ artist: `${P} band`, title: SONGS[i], album: "x", albumMbid: null, artistMbid: null, preMatchedTrackId: null, isrc: null });

describe("an M3U file", () => {
    const line = (i: number) => ({ filePath: `${P}/album/${i}.flac`, artist: null, title: null, durationSeconds: 100 });

    it("keeps a song listed twice, in file order, and counts each listing as matched", async () => {
        const { playlistId, matched, unmatched, total } = await spotifyImportService.importFromM3U(USER, `${P} m3u`, [
            line(0), line(1), line(0), { filePath: "/nowhere/else.flac", artist: null, title: null, durationSeconds: 1 }, line(2), line(1),
        ]);
        expect(await heldBy(playlistId)).toEqual([ids[0], ids[1], ids[0], ids[2], ids[1]]);
        expect({ matched, unmatched, total }).toEqual({ matched: 5, unmatched: 1, total: 6 });
    });
});

describe("a Spotify import", () => {
    const jobOf = (entries: ReturnType<typeof entry>[]) => ({
        id: JOB, userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} list`, status: "scanning", progress: 80,
        albumsTotal: 0, albumsCompleted: 0, tracksMatched: 0, tracksTotal: entries.length, tracksDownloadable: 0, createdPlaylistId: null,
        error: null, sourceUrl: null, createdAt: new Date(), updatedAt: new Date(), pendingTracks: entries,
    });

    it("keeps a song the source lists twice, in the source's order, and counts each listing", async () => {
        const job = jobOf([entry(0), entry(1), entry(0), entry(2), entry(1)]);
        await (spotifyImportService as any).buildPlaylist(job);
        expect(await heldBy(job.createdPlaylistId!)).toEqual([ids[0], ids[1], ids[0], ids[2], ids[1]]);
        expect(job.tracksMatched).toBe(5);
        expect(await prisma.playlistPendingTrack.count({ where: { playlistId: job.createdPlaylistId! } })).toBe(0);
    });

    it("puts a waiting entry between the copies around it", async () => {
        const waiting = { ...entry(0), artist: "nobody", title: "unheard thing" };
        const job = jobOf([entry(0), waiting, entry(0)]);
        await (spotifyImportService as any).buildPlaylist(job);
        const playlistId = job.createdPlaylistId!;
        const items = await prisma.playlistItem.findMany({ where: { playlistId } });
        const pending = await prisma.playlistPendingTrack.findMany({ where: { playlistId } });
        const order = [...items.map((i) => ({ rank: i.rank, what: "song" })), ...pending.map((p) => ({ rank: p.rank, what: "waiting" }))]
            .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
            .map((e) => e.what);
        expect(order).toEqual(["song", "waiting", "song"]);
    });

    it("waits for each listing of a song the library lacks, and a scan later adds one copy per listing", async () => {
        const lacking = { ...entry(0), artist: "zzghost", title: "zzunheard" };
        const job = jobOf([lacking, entry(1), lacking]);
        await (spotifyImportService as any).buildPlaylist(job);
        const playlistId = job.createdPlaylistId!;
        expect(await prisma.playlistPendingTrack.count({ where: { playlistId } })).toBe(2);

        const ghost = await prisma.artist.create({
            data: { name: "zzghost", normalizedName: "zzghost", identityKey: artistIdentityKey("zzghost") },
        });
        const album = await prisma.album.create({
            data: { rgMbid: `${P}-rg2`, identityKey: `${P}-album2`, primaryType: "Album", title: `zzghost album`, artistId: ghost.id, location: "LIBRARY" },
        });
        const found = await prisma.track.create({
            data: { title: "zzunheard", albumId: album.id, trackNo: 1, duration: 100, filePath: `${P}/ghost/1.flac`, fileModified: new Date(), fileSize: 1 },
        });
        await spotifyImportService.reconcilePendingTracks(playlistId);
        expect(await heldBy(playlistId)).toEqual([ids[1], found.id, found.id]);
        expect(await prisma.playlistPendingTrack.count({ where: { playlistId } })).toBe(0);
    });

    describe("refreshing matches", () => {
        async function jobWith(entries: ReturnType<typeof entry>[], held: string[]) {
            const playlist = await prisma.playlist.create({
                data: { userId: USER, name: `${P} imported`, items: { create: held.map((trackId, i) => ({ trackId, sort: i, rank: String.fromCharCode(97 + i) })) } },
            });
            await prisma.spotifyImportJob.create({
                data: {
                    id: JOB, userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} imported`, status: "completed",
                    albumsTotal: 0, tracksTotal: entries.length, createdPlaylistId: playlist.id, pendingTracks: entries,
                },
            });
            return playlist.id;
        }

        it("adds only the copies the playlist is short of", async () => {
            const playlistId = await jobWith([entry(0), entry(1), entry(0), entry(2), entry(0)], [ids[0], ids[1]]);
            const result = await spotifyImportService.refreshJobMatches(JOB);
            expect(result.added).toBe(3);
            expect(await heldBy(playlistId)).toEqual([ids[0], ids[1], ids[0], ids[2], ids[0]]);
        });

        it("takes the waiting entries it answers, so a later scan does not add those copies again", async () => {
            const playlistId = await jobWith([entry(0), entry(1), entry(0)], [ids[0]]);
            await prisma.playlistPendingTrack.createMany({
                data: [
                    { playlistId, spotifyArtist: `${P} band`, spotifyTitle: SONGS[1], spotifyAlbum: "x", sort: 1, rank: "b" },
                    { playlistId, spotifyArtist: `${P} band`, spotifyTitle: SONGS[0], spotifyAlbum: "x", sort: 2, rank: "c" },
                ],
            });
            expect((await spotifyImportService.refreshJobMatches(JOB)).added).toBe(2);
            expect(await prisma.playlistPendingTrack.count({ where: { playlistId } })).toBe(0);
            await spotifyImportService.reconcilePendingTracks(playlistId);
            expect(await heldBy(playlistId)).toEqual([ids[0], ids[1], ids[0]]);
        });

        it("adds nothing when the playlist already holds every listing", async () => {
            const playlistId = await jobWith([entry(0), entry(1), entry(0)], [ids[0], ids[1], ids[0]]);
            expect((await spotifyImportService.refreshJobMatches(JOB)).added).toBe(0);
            expect(await heldBy(playlistId)).toEqual([ids[0], ids[1], ids[0]]);
        });
    });
});

describe("reconciling waiting entries", () => {
    it("adds an entry that resolves to a song the playlist already holds as another copy, and stops waiting for it", async () => {
        const playlist = await prisma.playlist.create({
            data: { userId: USER, name: `${P} waiting`, items: { create: [{ trackId: ids[0], sort: 0, rank: "a" }] } },
        });
        await prisma.playlistPendingTrack.create({
            data: { playlistId: playlist.id, spotifyArtist: `${P} band`, spotifyTitle: SONGS[0], spotifyAlbum: "x", sort: 1, rank: "b" },
        });
        await spotifyImportService.reconcilePendingTracks(playlist.id);
        expect(await heldBy(playlist.id)).toEqual([ids[0], ids[0]]);
        expect(await prisma.playlistPendingTrack.count({ where: { playlistId: playlist.id } })).toBe(0);
    });
});
