/**
 * A song shows its own genre tags (the genres of its identified recording) first, and its album's when it has none, as
 * OpenSubsonic and Navidrome do. Real routers and the suite database; one album that shows "jazz", with five songs:
 * - T: own tags zydeco (rank 0), ska (rank 1) and polka (no rank, stored before ranks were kept). Shown in that order:
 *   the ranked ones by rank, then the unranked.
 * - N: no tags of its own. Shown: the album's jazz.
 * - K: only a tag that is no genre (an internal marker). Shown: the album's jazz.
 * - U: zydeco and ska, neither ranked. Shown: ska, zydeco (name order).
 * - B: only a tag equal to its artist's name. Shown: the album's jazz.
 * The album itself keeps showing its own genre. A song is found under its own tags by the genre filters of getSongsByGenre
 * and getRandomSongs and counted under them by getGenres, and under its album's genre only when it has no tag of its own;
 * the album filters and album counts stay on the album's genres.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { libraryRouter } from "../library";
import { searchRouter } from "../search";
import { playbackRouter } from "../playback";
import { playlistRouter } from "../playlists";
import { starredRouter } from "../starred";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zzsgn";
const USER = `${P}-user`;
const ARTIST = `${P}-ar`;
const ALBUM = `${P}-al`;
const ARTIST_NAME = `${P} band`;
const JAZZ = `${P}jazz`;
const SKA = `${P}ska`;
const ZYDECO = `${P}zydeco`;
const POLKA = `${P}polka`;
const MARKER = `_${P}marker`;
const T = `${P}-t`;
const N = `${P}-n`;
const K = `${P}-k`;
const U = `${P}-u`;
const B = `${P}-b`;
const ALL = [T, N, K, U, B];
const SHOWN: Record<string, string[]> = {
    [T]: [ZYDECO, SKA, POLKA], [N]: [JAZZ], [K]: [JAZZ], [U]: [SKA, ZYDECO], [B]: [JAZZ],
};

const app = express()
    .use((req: any, _res, next) => { req.user = { id: USER, username: USER, role: "user" }; next(); })
    .use("/", libraryRouter, searchRouter, playbackRouter, playlistRouter, starredRouter);

const ask = (view: string, query: Record<string, string> = {}) =>
    request(app).get(`/${view}.view`).query({ f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);
const list = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : [x].flat() as T[]);
const names = (genres: unknown) => list<any>(genres).map((g) => g.name);

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.likedTrack.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.genre.deleteMany({ where: { name: { in: [SKA, ZYDECO, POLKA, MARKER, ARTIST_NAME] } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.artist.create({
        data: { id: ARTIST, name: ARTIST_NAME, normalizedName: ARTIST_NAME, identityKey: `${P}-ik`, libraryAlbumCount: 1 },
    });
    await prisma.album.create({
        data: {
            id: ALBUM, rgMbid: `${ALBUM}-rg`, identityKey: ALBUM, artistId: ARTIST, title: `${P} album`, primaryType: "Album",
            location: "LIBRARY", genres: [JAZZ],
        },
    });
    // [name, rank]: a rank of null is a tag stored before ranks were kept.
    const tags: Record<string, [string, number | null][]> = {
        [T]: [[POLKA, null], [SKA, 1], [ZYDECO, 0]],
        [N]: [],
        [K]: [[MARKER, 0]],
        [U]: [[ZYDECO, null], [SKA, null]],
        [B]: [[ARTIST_NAME, 0]],
    };
    let trackNo = 1;
    for (const id of ALL) {
        await prisma.track.create({
            data: {
                id, albumId: ALBUM, title: `${P} song ${id.slice(-1)}`, trackNo: trackNo++, duration: 100,
                filePath: `${id}.flac`, fileModified: new Date(), fileSize: 1, mime: "FLAC",
            },
        });
        await prisma.likedTrack.create({ data: { userId: USER, trackId: id } });
        for (const [name, rank] of tags[id]) {
            const genre = await prisma.genre.upsert({ where: { name }, create: { name }, update: {} });
            await prisma.trackGenre.create({ data: { trackId: id, genreId: genre.id, rank } });
        }
    }
    await prisma.playlist.create({ data: { id: `${P}-pl`, userId: USER, name: `${P} playlist` } });
    let rank = 0;
    for (const id of ALL) {
        await prisma.playlistItem.create({ data: { playlistId: `${P}-pl`, trackId: id, sort: rank, rank: `a${rank++}` } });
    }
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
    await prisma.$disconnect();
});

const expectShown = (rows: any[]) => {
    const ours = rows.filter((r) => r.id?.startsWith(P));
    expect(ours.map((r) => r.id).sort()).toEqual([...ALL].sort());
    for (const s of ours) {
        expect(names(s.genres)).toEqual(SHOWN[s.id]);
        expect(s.genre).toBe(SHOWN[s.id][0]);
    }
};

describe("the genres a song shows", () => {
    it.each(ALL)("getSong %s shows its own tags, else its album's", async (id) => {
        const song = (await ask("getSong", { id })).song;
        expect(names(song.genres)).toEqual(SHOWN[id]);
        expect(song.genre).toBe(SHOWN[id][0]);
    });

    it("getAlbum shows the album's own genre and each song's", async () => {
        const body = await ask("getAlbum", { id: ALBUM });
        expect(body.album.genre).toBe(JAZZ);
        expect(names(body.album.genres)).toEqual([JAZZ]);
        expectShown(list<any>(body.album.song));
    });

    it("getMusicDirectory, getPlaylist, getStarred2 and getRandomSongs show them too", async () => {
        expectShown(list<any>((await ask("getMusicDirectory", { id: ALBUM })).directory.child));
        expectShown(list<any>((await ask("getPlaylist", { id: `${P}-pl` })).playlist.entry));
        expectShown(list<any>((await ask("getStarred2")).starred2.song));
        expectShown(list<any>((await ask("getRandomSongs", { size: "500" })).randomSongs.song));
    });

    it("search3 shows them too", async () => {
        expectShown(list<any>((await ask("search3", { query: `${P} song`, songCount: "50" })).searchResult3.song));
    });

    it("the album's genre in a list of albums is unchanged", async () => {
        const body = await ask("getAlbumList2", { type: "alphabeticalByName", size: "500" });
        const album = list<any>(body.albumList2.album).find((a) => a.id === ALBUM);
        expect(album.genre).toBe(JAZZ);
    });

    it("a list of albums by genre stays on the album's genres: songs' own tags do not move the album", async () => {
        const albumsOf = async (genre: string) =>
            list<any>((await ask("getAlbumList2", { type: "byGenre", genre, size: "500" })).albumList2.album).map((a) => a.id);
        expect(await albumsOf(JAZZ)).toContain(ALBUM);
        expect(await albumsOf(SKA)).not.toContain(ALBUM);
    });
});

describe("the genre filters follow a song's own tags", () => {
    const idsOf = (rows: unknown) => list<any>(rows).map((r) => r.id).filter((id: string) => id.startsWith(P)).sort();
    const byGenre = async (genre: string) => idsOf((await ask("getSongsByGenre", { genre, count: "500" })).songsByGenre.song);
    const random = async (genre: string) => idsOf((await ask("getRandomSongs", { genre, size: "500" })).randomSongs.song);

    it.each([
        ["a tag several songs carry", SKA, [T, U]],
        ["another tag several songs carry", ZYDECO, [T, U]],
        ["a tag one song carries", POLKA, [T]],
        ["the album's genre, for the songs with no tag of their own", JAZZ, [B, K, N]],
        ["a tag equal to the artist's name", ARTIST_NAME, []],
        ["another spelling of a tag", SKA.toUpperCase(), [T, U]],
        ["a genre nobody has", `${P}nothing`, []],
    ])("getSongsByGenre and getRandomSongs with %s", async (_label, genre, expected) => {
        expect(await byGenre(genre)).toEqual([...expected].sort());
        expect(await random(genre)).toEqual([...expected].sort());
    });
});

describe("the genre list counts a song under the genres it shows", () => {
    const entry = async (name: string) => list<any>((await ask("getGenres")).genres.genre).find((g) => g.value === name);

    it("counts own tags by song, and the album's genre by the songs showing it", async () => {
        expect(await entry(SKA)).toMatchObject({ songCount: 2, albumCount: 0 });
        expect(await entry(ZYDECO)).toMatchObject({ songCount: 2, albumCount: 0 });
        expect(await entry(POLKA)).toMatchObject({ songCount: 1, albumCount: 0 });
        expect(await entry(JAZZ)).toMatchObject({ songCount: 3, albumCount: 1 });
    });

    it("lists no genre for a marker or a tag equal to the artist's name", async () => {
        expect(await entry(MARKER)).toBeUndefined();
        expect(await entry(ARTIST_NAME)).toBeUndefined();
    });
});
