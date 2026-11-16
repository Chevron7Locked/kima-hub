/**
 * Subsonic shows the year and genre a person sees on the web. An album's year is `displayYear ?? originalYear ?? year`, and
 * its genre is the first of its own merged genres (the person's list when set, else the enriched one), else its artist's.
 * Every endpoint that lists an album or a song reads them, and the year lists, filters and sorts judge by the same year.
 * Real routers and the suite database; one seed with three albums that tell the three year columns apart:
 * - A: year 2005, originalYear 1990 (shown 1990); enriched genre "albumpunk".
 * - B: year 2005, originalYear 1990, displayYear 1975 (shown 1975); enriched "rawgenre" under the person's "usergenre".
 * - C: year 2001 only (shown 2001); no album genre, so the artist's "artistgenre".
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

const P = "zzshyr";
const USER = `${P}-user`;
const ARTIST = `${P}-ar`;

const app = express()
    .use((req: any, _res, next) => { req.user = { id: USER, username: USER, role: "user" }; next(); })
    .use("/", libraryRouter, searchRouter, playbackRouter, playlistRouter, starredRouter);

const ask = (view: string, query: Record<string, string> = {}) =>
    request(app).get(`/${view}.view`).query({ f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);
const list = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : [x].flat() as T[]);

const A = `${P}-al-a`;
const B = `${P}-al-b`;
const C = `${P}-al-c`;
const song = (album: string) => `${album}-t`;
/** What each album shows. */
const SHOWN = {
    [A]: { year: 1990, genre: "albumpunk" },
    [B]: { year: 1975, genre: "usergenre" },
    [C]: { year: 2001, genre: "artistgenre" },
} as const;

const ofOurs = <T extends { id: string }>(rows: T[]) => rows.filter((r) => r.id.startsWith(P));
const idsOf = (rows: Array<{ id: string }>) => ofOurs(rows).map((r) => r.id);

const expectAlbumShown = (row: any) => {
    expect({ year: row.year, genre: row.genre }).toEqual(SHOWN[row.id as keyof typeof SHOWN]);
};
const expectSongShown = (row: any) => {
    expect(row.year).toBe(SHOWN[row.albumId as keyof typeof SHOWN].year);
};

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.likedTrack.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.artist.create({
        data: { id: ARTIST, name: `${P} band`, normalizedName: `${P} band`, identityKey: `${P}-ik`, libraryAlbumCount: 3, genres: ["artistgenre"] },
    });
    const albums = [
        { id: A, year: 2005, originalYear: 1990, genres: ["albumpunk"] },
        { id: B, year: 2005, originalYear: 1990, displayYear: 1975, genres: ["rawgenre"], userGenres: ["usergenre"] },
        { id: C, year: 2001 },
    ];
    for (const a of albums) {
        await prisma.album.create({
            data: { ...a, rgMbid: `${a.id}-rg`, identityKey: a.id, artistId: ARTIST, title: `${P} album ${a.id.slice(-1)}`, primaryType: "Album", location: "LIBRARY" },
        });
        await prisma.track.create({
            data: {
                id: song(a.id), albumId: a.id, title: `${P} song ${a.id.slice(-1)}`, trackNo: 1, duration: 100,
                filePath: `${a.id}.flac`, fileModified: new Date(), fileSize: 1, mime: "FLAC",
            },
        });
        await prisma.play.create({ data: { userId: USER, trackId: song(a.id), playedAt: new Date() } });
        await prisma.likedTrack.create({ data: { userId: USER, trackId: song(a.id) } });
    }
    await prisma.playlist.create({ data: { id: `${P}-pl`, userId: USER, name: `${P} playlist` } });
    let rank = 0;
    for (const a of albums) {
        await prisma.playlistItem.create({ data: { playlistId: `${P}-pl`, trackId: song(a.id), sort: rank, rank: `a${rank++}` } });
    }
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
    await prisma.$disconnect();
});

describe("an album as Subsonic shows it", () => {
    it.each([A, B, C])("getAlbum %s gives the shown year and genre, and its song the shown year", async (id) => {
        const body = await ask("getAlbum", { id });
        expectAlbumShown(body.album);
        for (const s of list<any>(body.album.song)) expectSongShown(s);
    });

    it("getArtist lists the albums by the year shown, newest first, with the shown year and genre", async () => {
        const body = await ask("getArtist", { id: ARTIST });
        const albums = list<any>(body.artist.album);
        expect(albums.map((a) => a.id)).toEqual([C, A, B]);
        albums.forEach(expectAlbumShown);
    });

    it("getMusicDirectory lists an artist's albums by the year shown, with the shown year and genre", async () => {
        const body = await ask("getMusicDirectory", { id: ARTIST });
        const children = list<any>(body.directory.child);
        expect(children.map((a) => a.id)).toEqual([C, A, B]);
        children.forEach(expectAlbumShown);
    });

    it("getMusicDirectory gives an album's songs the shown year", async () => {
        const body = await ask("getMusicDirectory", { id: B });
        for (const s of list<any>(body.directory.child)) expectSongShown(s);
        expect(list<any>(body.directory.child)).toHaveLength(1);
    });

    it("getSong gives the shown year", async () => {
        for (const album of [A, B, C]) expectSongShown((await ask("getSong", { id: song(album) })).song);
    });
});

describe("the album lists", () => {
    it.each(["newest", "alphabeticalByName", "alphabeticalByArtist", "random", "recent", "frequent", "starred"])(
        "%s gives each album the shown year and genre",
        async (type) => {
            const body = await ask("getAlbumList2", { type, size: "500" });
            const ours = ofOurs(list<any>(body.albumList2.album));
            expect(ours.map((a) => a.id).sort()).toEqual([A, B, C]);
            ours.forEach(expectAlbumShown);
        },
    );

    it("byGenre gives each album the shown year and genre", async () => {
        const body = await ask("getAlbumList2", { type: "byGenre", genre: "artistgenre", size: "500" });
        const ours = ofOurs(list<any>(body.albumList2.album));
        expect(ours.map((a) => a.id).sort()).toEqual([A, B, C]);
        ours.forEach(expectAlbumShown);
    });

    const byYear = async (fromYear: number, toYear: number) =>
        idsOf(list<any>((await ask("getAlbumList2", { type: "byYear", fromYear: String(fromYear), toYear: String(toYear), size: "500" })).albumList2.album));

    it("byYear filters and orders by the year shown", async () => {
        expect(await byYear(1990, 1990)).toEqual([A]);
        expect(await byYear(1975, 1975)).toEqual([B]);
        expect(await byYear(1970, 2002)).toEqual([B, A, C]);
        expect(await byYear(2002, 1970)).toEqual([C, A, B]);
    });

    it("byYear does not find an album by a year it no longer shows", async () => {
        expect(await byYear(2005, 2005)).toEqual([]);
    });

    it("the legacy getAlbumList agrees", async () => {
        const body = await ask("getAlbumList", { type: "byYear", fromYear: "1970", toYear: "2002", size: "500" });
        expect(idsOf(list<any>(body.albumList.album))).toEqual([B, A, C]);
    });
});

describe("search", () => {
    it("search3 gives its albums the shown year and genre and its songs the shown year", async () => {
        const body = await ask("search3", { query: P, albumCount: "50", songCount: "50" });
        const albums = ofOurs(list<any>(body.searchResult3.album));
        expect(albums.map((a) => a.id).sort()).toEqual([A, B, C]);
        albums.forEach(expectAlbumShown);
        const songs = list<any>(body.searchResult3.song).filter((s) => s.id.startsWith(P));
        expect(songs).toHaveLength(3);
        songs.forEach(expectSongShown);
    });

    it("an empty search3 (the whole library) agrees", async () => {
        const body = await ask("search3", { query: "", albumCount: "500", songCount: "500" });
        ofOurs(list<any>(body.searchResult3.album)).forEach(expectAlbumShown);
        list<any>(body.searchResult3.song).filter((s) => s.id.startsWith(P)).forEach(expectSongShown);
    });

    it("search2 gives its album entries the shown year and genre", async () => {
        const body = await ask("search2", { query: P, albumCount: "50", songCount: "0" });
        const albums = ofOurs(list<any>(body.searchResult2.album));
        expect(albums).toHaveLength(3);
        albums.forEach(expectAlbumShown);
    });

    it("the old search gives the shown year", async () => {
        const body = await ask("search", { any: P, count: "50" });
        const matches = list<any>(body.searchResult.match).filter((s) => s.id.startsWith(P));
        expect(matches).toHaveLength(3);
        matches.forEach(expectSongShown);
    });
});

describe("the song lists", () => {
    it("getRandomSongs gives the shown year", async () => {
        const songs = list<any>((await ask("getRandomSongs", { size: "500" })).randomSongs.song).filter((s) => s.id.startsWith(P));
        expect(songs).toHaveLength(3);
        songs.forEach(expectSongShown);
    });

    const randomIds = async (query: Record<string, string>) =>
        list<any>((await ask("getRandomSongs", { size: "500", ...query })).randomSongs.song).filter((s) => s.id.startsWith(P)).map((s) => s.albumId).sort();

    it("getRandomSongs filters by the year shown", async () => {
        expect(await randomIds({ fromYear: "1990", toYear: "1990" })).toEqual([A]);
        expect(await randomIds({ fromYear: "1976" })).toEqual([A, C].sort());
        expect(await randomIds({ toYear: "1975" })).toEqual([B]);
        expect(await randomIds({ fromYear: "2005", toYear: "2005" })).toEqual([]);
    });

    it("getSongsByGenre gives the shown year", async () => {
        const songs = list<any>((await ask("getSongsByGenre", { genre: "artistgenre", count: "500" })).songsByGenre.song).filter((s) => s.id.startsWith(P));
        expect(songs).toHaveLength(3);
        songs.forEach(expectSongShown);
    });

    it("getStarred2 gives the shown year", async () => {
        const songs = list<any>((await ask("getStarred2")).starred2.song).filter((s) => s.id.startsWith(P));
        expect(songs).toHaveLength(3);
        songs.forEach(expectSongShown);
    });

    it("getPlaylist gives the shown year", async () => {
        const songs = list<any>((await ask("getPlaylist", { id: `${P}-pl` })).playlist.entry);
        expect(songs).toHaveLength(3);
        songs.forEach(expectSongShown);
    });
});
