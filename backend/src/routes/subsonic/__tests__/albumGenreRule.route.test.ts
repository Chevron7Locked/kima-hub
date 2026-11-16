/**
 * One genre rule for albums, songs and the genre filters. What an album shows is its own merged genres (the person's list
 * when set, else the enriched one; a "_" marker is no genre), else its artist's. A song with no tags of its own (the
 * songs here; songGenres.route.test.ts has the ones with) shows its album's, the genre
 * lists count by it and the genre filters (byGenre, getSongsByGenre, getRandomSongs) keep by it, so a shown genre and
 * its filter always agree. Real routers and the suite database; one artist tagged "rock" with four albums:
 * - J: its own enriched "jazz". Shown: jazz.
 * - R: no genres of its own. Shown: the artist's rock.
 * - M: only a "_" marker of its own. Shown: the artist's rock.
 * - U: enriched "rawx" under the person's "blues". Shown: blues.
 * - X: two genres of its own, "Alt {folk}" and "Quiet {band}". Shown: both, the first as its genre.
 * Subsonic's genre filters match a genre exactly (by genre key, as getGenres lists it); the radio and station filters
 * answer to broader genres that contain it.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { libraryRouter } from "../library";
import { searchRouter } from "../search";
import { playbackRouter } from "../playback";
import { playlistRouter } from "../playlists";
import { starredRouter } from "../starred";
import { mapSong } from "../mappers";
import { libraryGenreTotals, songGenreFilterSql } from "../../../utils/genreSql";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zzagr";
const USER = `${P}-user`;
const ARTIST = `${P}-ar`;
const ROCK = `${P}rock`;
const JAZZ = `${P}jazz`;
const BLUES = `${P}blues`;
const FOLK = `${P}folk`;
const ALT_FOLK = `Alt ${FOLK}`;
const QUIET = `Quiet ${P}`;

const app = express()
    .use((req: any, _res, next) => { req.user = { id: USER, username: USER, role: "user" }; next(); })
    .use("/", libraryRouter, searchRouter, playbackRouter, playlistRouter, starredRouter);

const ask = (view: string, query: Record<string, string> = {}) =>
    request(app).get(`/${view}.view`).query({ f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);
const list = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : [x].flat() as T[]);

const J = `${P}-al-j`;
const R = `${P}-al-r`;
const M = `${P}-al-m`;
const U = `${P}-al-u`;
const X = `${P}-al-x`;
const song = (album: string) => `${album}-t`;
const SHOWN: Record<string, string> = { [J]: JAZZ, [R]: ROCK, [M]: ROCK, [U]: BLUES, [X]: ALT_FOLK };

const idsOf = (rows: Array<{ id: string }>) => rows.filter((r) => r.id.startsWith(P)).map((r) => r.id).sort();

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
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
        data: { id: ARTIST, name: `${P} band`, normalizedName: `${P} band`, identityKey: `${P}-ik`, libraryAlbumCount: 5, genres: [ROCK] },
    });
    const albums = [
        { id: J, genres: [JAZZ] },
        { id: R },
        { id: M, genres: ["_no_mood_tags"] },
        { id: U, genres: ["rawx"], userGenres: [BLUES] },
        { id: X, genres: [ALT_FOLK, QUIET] },
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

describe("the genre an album and its songs show", () => {
    it.each([J, R, M, U, X])("getAlbum %s shows its genre, and its song shows the same", async (id) => {
        const body = await ask("getAlbum", { id });
        expect(body.album.genre).toBe(SHOWN[id]);
        for (const s of list<any>(body.album.song)) expect(s.genre).toBe(SHOWN[id]);
    });

    it.each([J, R, M, U, X])("getSong %s shows its album's genre", async (id) => {
        expect((await ask("getSong", { id: song(id) })).song.genre).toBe(SHOWN[id]);
    });

    it("getRandomSongs, getStarred2 and getPlaylist show each song's album's genre", async () => {
        const random = list<any>((await ask("getRandomSongs", { size: "500" })).randomSongs?.song);
        const starred = list<any>((await ask("getStarred2")).starred2?.song);
        const playlist = list<any>((await ask("getPlaylist", { id: `${P}-pl` })).playlist?.entry);
        for (const rows of [random, starred, playlist]) {
            const ours = rows.filter((r) => r.albumId?.startsWith(P));
            expect(ours.length).toBeGreaterThan(0);
            for (const s of ours) expect(s.genre).toBe(SHOWN[s.albumId]);
        }
    });

    it("getAlbumList2 shows the album's genre on every album", async () => {
        const body = await ask("getAlbumList2", { type: "alphabeticalByName", size: "500" });
        const ours = list<any>(body.albumList2.album).filter((a) => a.id.startsWith(P));
        expect(ours.map((a) => a.id).sort()).toEqual([J, M, R, U, X]);
        for (const a of ours) expect(a.genre).toBe(SHOWN[a.id]);
    });
});

describe("the genre filters agree with the genre shown", () => {
    it.each([
        [JAZZ, [J]],
        [ROCK, [M, R]],
        [BLUES, [U]],
    ])("byGenre %s lists the albums showing it", async (genre, albums) => {
        const body = await ask("getAlbumList2", { type: "byGenre", genre, size: "500" });
        expect(idsOf(list<any>(body.albumList2.album))).toEqual(albums);
    });

    it("a genre an album's own list replaced lists nothing of that album", async () => {
        const body = await ask("getAlbumList2", { type: "byGenre", genre: "rawx", size: "500" });
        expect(idsOf(list<any>(body.albumList2.album))).toEqual([]);
    });

    it.each([
        [JAZZ, [song(J)]],
        [ROCK, [song(M), song(R)]],
        [BLUES, [song(U)]],
    ])("getSongsByGenre %s lists the songs showing it", async (genre, songs) => {
        const body = await ask("getSongsByGenre", { genre, count: "500" });
        expect(idsOf(list<any>(body.songsByGenre.song))).toEqual(songs);
    });

    it("getRandomSongs by genre keeps the songs showing it", async () => {
        const body = await ask("getRandomSongs", { size: "500", genre: JAZZ });
        expect(idsOf(list<any>(body.randomSongs.song))).toEqual([song(J)]);
    });

    it("getGenres counts by the genre shown: each album once, with its songs", async () => {
        const body = await ask("getGenres");
        const ours = Object.fromEntries(
            list<any>(body.genres.genre)
                .filter((g) => [JAZZ, ROCK, BLUES, "rawx"].includes(g.value))
                .map((g) => [g.value, { songs: g.songCount, albums: g.albumCount }]),
        );
        expect(ours).toEqual({
            [JAZZ]: { songs: 1, albums: 1 },
            [ROCK]: { songs: 2, albums: 2 },
            [BLUES]: { songs: 1, albums: 1 },
        });
    });

    it("the shared genre list counts the same", async () => {
        const totals = (await libraryGenreTotals()).filter((g) => [JAZZ, ROCK, BLUES, "rawx"].includes(g.name));
        expect(totals.map((g) => [g.name, g.songs, g.albums]).sort()).toEqual([
            [BLUES, 1, 1],
            [JAZZ, 1, 1],
            [ROCK, 2, 2],
        ]);
    });
});

describe("the genre filters of Subsonic match a genre exactly", () => {
    it("byGenre does not list an album for a genre that only contains the one asked for", async () => {
        const body = await ask("getAlbumList2", { type: "byGenre", genre: FOLK, size: "500" });
        expect(idsOf(list<any>(body.albumList2.album))).toEqual([]);
    });

    it.each([ALT_FOLK, `alt-${FOLK.toUpperCase()}`, QUIET])("byGenre %s lists the album under any spelling of one of its genres", async (genre) => {
        const body = await ask("getAlbumList2", { type: "byGenre", genre, size: "500" });
        expect(idsOf(list<any>(body.albumList2.album))).toEqual([X]);
    });

    it("getSongsByGenre and getRandomSongs by genre match exactly too", async () => {
        expect(idsOf(list<any>((await ask("getSongsByGenre", { genre: FOLK, count: "500" })).songsByGenre.song))).toEqual([]);
        expect(idsOf(list<any>((await ask("getSongsByGenre", { genre: ALT_FOLK, count: "500" })).songsByGenre.song))).toEqual([song(X)]);
        expect(idsOf(list<any>((await ask("getRandomSongs", { size: "500", genre: FOLK })).randomSongs?.song))).toEqual([]);
        expect(idsOf(list<any>((await ask("getRandomSongs", { size: "500", genre: QUIET })).randomSongs.song))).toEqual([song(X)]);
    });

    it("the broad song filter, for radio and stations, still answers to genres that contain the one asked for", async () => {
        const songsOf = async (match: "exact" | "contains") => {
            const filter = await songGenreFilterSql(FOLK, "t", "al", match);
            const rows = await prisma.$queryRaw<{ id: string }[]>`
                SELECT t.id FROM "Track" t JOIN "Album" al ON al.id = t."albumId" WHERE ${filter}`;
            return rows.map((r) => r.id).filter((id) => id.startsWith(P));
        };
        expect(await songsOf("exact")).toEqual([]);
        expect(await songsOf("contains")).toEqual([song(X)]);
    });
});

describe("OpenSubsonic genres", () => {
    const names = (genres: unknown) => list<any>(genres).map((g) => g.name);

    it.each([J, R, M, U, X])("album %s and its song list every genre they show, the first as genre", async (id) => {
        const body = await ask("getAlbum", { id });
        const want = id === X ? [ALT_FOLK, QUIET] : [SHOWN[id]];
        expect(names(body.album.genres)).toEqual(want);
        expect(body.album.genre).toBe(want[0]);
        const songs = list<any>(body.album.song);
        expect(songs).toHaveLength(1);
        expect(names(songs[0].genres)).toEqual(want);
        expect(songs[0].genre).toBe(want[0]);
    });

    it("a song on an album that shows no genre carries neither genre nor genres", () => {
        const track = { id: "t", title: "T", displayTitle: null, trackNo: 1, discNumber: null, duration: 1, filePath: null, mime: null, bitrate: null, fileSize: null };
        const album = { id: "a", title: "A", displayTitle: null, year: null, originalYear: null, displayYear: null };
        for (const none of [undefined, []]) {
            const mapped = mapSong(track, album, "Artist", "ar", none);
            expect(mapped["@_genre"]).toBeUndefined();
            expect(mapped.genres).toBeUndefined();
        }
    });

    it("one genre is still a list in JSON, and repeated elements in XML", async () => {
        const json = await ask("getAlbum", { id: J });
        expect(Array.isArray(json.album.genres)).toBe(true);
        expect(json.album.genres).toEqual([{ name: JAZZ }]);
        expect(list<any>(json.album.song)[0].genres).toEqual([{ name: JAZZ }]);
        const xml = (await request(app).get("/getAlbum.view").query({ id: X }).expect(200)).text;
        expect(xml).toContain(`<genres name="${ALT_FOLK}"`);
        expect(xml).toContain(`<genres name="${QUIET}"`);
    });

    it("every view that shows a song or an album carries the list", async () => {
        const only = (rows: any[]) => rows.filter((r) => (r.albumId ?? r.id) === X);
        const random = only(list<any>((await ask("getRandomSongs", { size: "500" })).randomSongs?.song));
        const starred = only(list<any>((await ask("getStarred2")).starred2?.song));
        const playlist = only(list<any>((await ask("getPlaylist", { id: `${P}-pl` })).playlist?.entry));
        const listed = only(list<any>((await ask("getAlbumList2", { type: "alphabeticalByName", size: "500" })).albumList2.album));
        const song = only([(await ask("getSong", { id: `${X}-t` })).song]);
        const folder = only(list<any>((await ask("getMusicDirectory", { id: X })).directory.child));
        for (const rows of [random, starred, playlist, listed, song, folder]) {
            expect(rows).toHaveLength(1);
            expect(names(rows[0].genres)).toEqual([ALT_FOLK, QUIET]);
        }
    });
});
