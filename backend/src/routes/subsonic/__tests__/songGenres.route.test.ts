/**
 * A song shows its own genre tags (the genres of its identified recording) first, and its album's when it has none, as
 * OpenSubsonic and Navidrome do. Real routers and the suite database; one album that shows "jazz", with three songs:
 * - T: own tags "zydeco" and "ska". Shown: ska first (own tags come in name order), then zydeco.
 * - N: no tags of its own. Shown: the album's jazz.
 * - K: only a tag that is no genre (an internal marker). Shown: the album's jazz.
 * The album itself keeps showing its own genre; the genre filters and the genre list still work by the album's.
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
const JAZZ = `${P}jazz`;
const SKA = `${P}ska`;
const ZYDECO = `${P}zydeco`;
const MARKER = `_${P}marker`;
const T = `${P}-t`;
const N = `${P}-n`;
const K = `${P}-k`;
const SHOWN: Record<string, string[]> = { [T]: [SKA, ZYDECO], [N]: [JAZZ], [K]: [JAZZ] };

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
    await prisma.genre.deleteMany({ where: { name: { in: [SKA, ZYDECO, MARKER] } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.artist.create({
        data: { id: ARTIST, name: `${P} band`, normalizedName: `${P} band`, identityKey: `${P}-ik`, libraryAlbumCount: 1 },
    });
    await prisma.album.create({
        data: {
            id: ALBUM, rgMbid: `${ALBUM}-rg`, identityKey: ALBUM, artistId: ARTIST, title: `${P} album`, primaryType: "Album",
            location: "LIBRARY", genres: [JAZZ],
        },
    });
    const tags: Record<string, string[]> = { [T]: [ZYDECO, SKA], [N]: [], [K]: [MARKER] };
    let trackNo = 1;
    for (const id of [T, N, K]) {
        await prisma.track.create({
            data: {
                id, albumId: ALBUM, title: `${P} song ${id.slice(-1)}`, trackNo: trackNo++, duration: 100,
                filePath: `${id}.flac`, fileModified: new Date(), fileSize: 1, mime: "FLAC",
            },
        });
        await prisma.likedTrack.create({ data: { userId: USER, trackId: id } });
        for (const name of tags[id]) {
            const genre = await prisma.genre.upsert({ where: { name }, create: { name }, update: {} });
            await prisma.trackGenre.create({ data: { trackId: id, genreId: genre.id } });
        }
    }
    await prisma.playlist.create({ data: { id: `${P}-pl`, userId: USER, name: `${P} playlist` } });
    let rank = 0;
    for (const id of [T, N, K]) {
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
    expect(ours.map((r) => r.id).sort()).toEqual([K, N, T]);
    for (const s of ours) {
        expect(names(s.genres)).toEqual(SHOWN[s.id]);
        expect(s.genre).toBe(SHOWN[s.id][0]);
    }
};

describe("the genres a song shows", () => {
    it.each([T, N, K])("getSong %s shows its own tags, else its album's", async (id) => {
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

    it("search3 and getSongsByGenre show them too", async () => {
        expectShown(list<any>((await ask("search3", { query: `${P} song`, songCount: "50" })).searchResult3.song));
        expectShown(list<any>((await ask("getSongsByGenre", { genre: JAZZ, count: "500" })).songsByGenre.song));
    });

    it("the album's genre in a list of albums is unchanged", async () => {
        const body = await ask("getAlbumList2", { type: "alphabeticalByName", size: "500" });
        const album = list<any>(body.albumList2.album).find((a) => a.id === ALBUM);
        expect(album.genre).toBe(JAZZ);
    });
});
