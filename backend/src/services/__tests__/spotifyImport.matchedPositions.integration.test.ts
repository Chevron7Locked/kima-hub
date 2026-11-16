/**
 * A playlist an import builds waits for exactly the listings it did not match, one for one, whatever the matched song
 * is called in the library: a listing matched by title alone, by a preview's song id or by ISRC is in the playlist and
 * not waiting, and a listing whose title shares its first word with a matched one still waits. Real database and Redis.
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

const P = "zz-import-positions";
const USER = `${P}-user`;
const JOB = `${P}-job`;
const VARIOUS = `${P} various artists`;
const BAND = `${P} band`;
const COMPILATION_SONG = `${P} compilation anthem`;
const LOVE_STORY = `${P} love story`;
const ISRC = "ZZPOS0000001";
let ids: Record<string, string>;

async function cleanup() {
    await redisClient.del(`import:job:${JOB}`);
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: P } } });
}

async function song(artistName: string, title: string, n: number, isrc?: string) {
    const artist = await prisma.artist.upsert({
        where: { identityKey: artistIdentityKey(artistName) },
        update: {},
        create: { name: artistName, normalizedName: artistName, identityKey: artistIdentityKey(artistName) },
    });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-rg-${n}`, identityKey: `${P}-album-${n}`, primaryType: "Album", title: `${P} album ${n}`, artistId: artist.id, location: "LIBRARY" },
    });
    return (await prisma.track.create({
        data: { title, albumId: album.id, trackNo: 1, duration: 100, filePath: `${P}/${n}.flac`, fileModified: new Date(), fileSize: 1, ...(isrc ? { isrc } : {}) },
    })).id;
}

beforeAll(async () => {
    await waitForRedisReady();
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    ids = {
        compilation: await song(VARIOUS, COMPILATION_SONG, 1),
        loveStory: await song(BAND, LOVE_STORY, 2),
        renamed: await song(BAND, `${P} the library spelling`, 3),
        isrc: await song(BAND, `${P} the isrc spelling`, 4, ISRC),
    };
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

const listing = (artist: string, title: string, extra: { preMatchedTrackId?: string; isrc?: string } = {}) => ({
    artist, title, album: "x", albumMbid: null, artistMbid: null, preMatchedTrackId: null, isrc: null, ...extra,
});

async function build(entries: ReturnType<typeof listing>[]) {
    const job = {
        id: JOB, userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} list`, status: "scanning", progress: 80,
        albumsTotal: 0, albumsCompleted: 0, tracksMatched: 0, tracksTotal: entries.length, tracksDownloadable: 0,
        createdPlaylistId: null as string | null, error: null, sourceUrl: null, createdAt: new Date(), updatedAt: new Date(),
        pendingTracks: entries,
    };
    await (spotifyImportService as any).buildPlaylist(job);
    const playlistId = job.createdPlaylistId!;
    return {
        playlistId,
        held: (await prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" } })).map((i) => i.trackId),
        waiting: (await prisma.playlistPendingTrack.findMany({ where: { playlistId }, orderBy: { sort: "asc" } })).map((w) => w.spotifyTitle),
    };
}

describe("a built import playlist", () => {
    it("does not also wait for a listing it matched by title alone to a Various Artists song", async () => {
        const { held, waiting, playlistId } = await build([listing("zzsinger voice", COMPILATION_SONG)]);
        expect(held).toEqual([ids.compilation]);
        expect(waiting).toEqual([]);
        // A later scan has nothing to place a second time.
        await spotifyImportService.reconcilePendingTracks(playlistId);
        expect(await prisma.playlistItem.count({ where: { playlistId } })).toBe(1);
    });

    it("does not also wait for a listing a preview matched to a song spelled differently", async () => {
        const { held, waiting } = await build([listing("someone else", "another title", { preMatchedTrackId: ids.renamed })]);
        expect(held).toEqual([ids.renamed]);
        expect(waiting).toEqual([]);
    });

    it("does not also wait for a listing matched by ISRC to a song spelled differently", async () => {
        const { held, waiting } = await build([listing("someone else", "yet another title", { isrc: ISRC })]);
        expect(held).toEqual([ids.isrc]);
        expect(waiting).toEqual([]);
    });

    it("still waits for a listing that shares its first words with a matched one", async () => {
        const { held, waiting } = await build([listing(BAND, LOVE_STORY), listing(BAND, `${P} love me do`)]);
        expect(held).toEqual([ids.loveStory]);
        expect(waiting).toEqual([`${P} love me do`]);
    });
});
