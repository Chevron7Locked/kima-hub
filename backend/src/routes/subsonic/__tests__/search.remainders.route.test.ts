/**
 * Subsonic search and the web search behind it, on the real router and the suite database:
 * - `search` (v1) answers the way the spec describes: `any`/`artist`/`album`/`title`, `count`, `offset`, and a
 *   `searchResult` of `offset`, `totalHits` and `match` songs.
 * - A name or title edited in Kima is searchable, by whole word (the search vectors) and by part of a word.
 * - Songs sort by the title shown, on every path.
 * - Paging past the end of the full-text hits answers nothing, not the substring search at the same offset.
 * - A query with a non-ASCII letter is matched as typed, never cut down to its ASCII letters.
 * - getArtists counts the albums that have a playable song, as search3 does.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { searchRouter } from "../search";
import { libraryRouter } from "../library";
import { searchService } from "../../../services/search";

const P = "zzrem";
const USER = `${P}-user`;

const app = express()
    .use((req: any, _res, next) => { req.user = { id: USER, username: USER, role: "user" }; next(); })
    .use("/", searchRouter, libraryRouter);

const ask = (view: string, query: Record<string, string>) =>
    request(app).get(`/${view}.view`).query({ f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);

const list = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : [x].flat() as T[]);

let seq = 0;
/** An artist with one library album holding one playable song (or a missing one), each named as given. */
async function seed(o: {
    artist: string; artistShown?: string | null; album: string; albumShown?: string | null; song: string; songShown?: string | null;
    genre?: string; missing?: boolean; location?: "LIBRARY" | "DISCOVER"; artistId?: string; cached?: number;
}) {
    const n = ++seq;
    const artistId = o.artistId ?? `${P}-ar-${n}`;
    if (!o.artistId) {
        await prisma.artist.create({
            data: {
                id: artistId, name: o.artist, displayName: o.artistShown ?? null, normalizedName: artistId, identityKey: `${artistId}-ik`,
                libraryAlbumCount: o.cached ?? 1, ...(o.genre ? { genres: [o.genre] } : {}),
            },
        });
    }
    await prisma.album.create({
        data: {
            id: `${P}-al-${n}`, rgMbid: `${P}-rg-${n}`, identityKey: `${P}-al-${n}`, artistId, title: o.album,
            displayTitle: o.albumShown ?? null, primaryType: "Album", location: o.location ?? "LIBRARY", year: 2005,
        },
    });
    await prisma.track.create({
        data: {
            id: `${P}-t-${n}`, albumId: `${P}-al-${n}`, title: o.song, displayTitle: o.songShown ?? null, trackNo: 1, duration: 100,
            filePath: `${P}-${n}.flac`, fileModified: new Date(), fileSize: 1, mime: "FLAC",
            ...(o.missing ? { missingSince: new Date() } : {}),
        },
    });
    return { artistId, albumId: `${P}-al-${n}`, trackId: `${P}-t-${n}` };
}

const ids: Record<string, { artistId: string; albumId: string; trackId: string }> = {};

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });

    // Edited names: the file's names are one set of words, the names shown another.
    ids.edited = await seed({
        artist: "zzremrawband", artistShown: "zzremshownband", album: "zzremrawalbum", albumShown: "zzremshownalbum",
        song: "zzremrawsong", songShown: "zzremshownsong",
    });
    // Edited after it was saved: the search vectors follow the update.
    ids.later = await seed({ artist: "zzremlaterband", album: "zzremlateralbum", song: "zzremlatersong" });

    // Songs: raw order and shown order are opposite. S1 is shown as "zzz", S2 as itself; both hold the word "zzremtie".
    ids.s1 = await seed({ artist: "zzremsortart", artistShown: null, album: "zzremsortalb", song: "zzremtie aaa", songShown: "zzz", genre: "zzremgenre" });
    ids.s2 = await seed({ artist: "zzremsortart2", album: "zzremsortalb2", song: "zzremtie bbb", genre: "zzremgenre" });

    // search v1: songs found by artist, album and title, and ones that must not be found.
    ids.v1a = await seed({ artist: "zzremv1artist", album: "zzremv1album", song: "zzremv1 alpha" });
    ids.v1b = await seed({ artist: "zzremv1artist", album: "zzremv1album", song: "zzremv1 beta", artistId: ids.v1a.artistId });
    ids.v1c = await seed({ artist: "zzremv1other", album: "zzremv1album", song: "zzremv1 gamma" });
    ids.v1gone = await seed({ artist: "zzremv1artist", album: "zzremv1album", song: "zzremv1 gone", artistId: ids.v1a.artistId, missing: true });
    ids.v1disc = await seed({ artist: "zzremv1artist", album: "zzremv1album", song: "zzremv1 disc", artistId: ids.v1a.artistId, location: "DISCOVER" });

    // Paging: two names that hold the word, two that hold it inside another word (only the substring search finds those,
    // and they sort before the others by name).
    for (const [i, name] of ["zzrempg alpha", "zzrempg beta", "azzrempgx", "bzzrempgy"].entries()) {
        ids[`pg${i}`] = await seed({ artist: name, album: name, song: name });
    }

    // Non-ASCII: the plain word is a prefix of the accented one in full-text search once the accent is stripped.
    ids.uniPlain = await seed({ artist: "zzremuni plain", album: "zzremuni plain", song: "zzremuni plain" });
    ids.uniAccent = await seed({ artist: "zzremunié accent", album: "zzremunié accent", song: "zzremunié accent" });

    // Album counts: a stale cached count of five, with one album that plays and one whose only file is gone.
    const counted = await seed({ artist: "zzremcounted", album: "zzremcounted a", song: "zzremcounted a", cached: 5 });
    await seed({ artist: "zzremcounted", album: "zzremcounted b", song: "zzremcounted b", artistId: counted.artistId, missing: true });
    ids.counted = counted;
    ids.silent = await seed({ artist: "zzremsilent", album: "zzremsilent", song: "zzremsilent", missing: true, cached: 1 });

    // Twenty-five songs on one album, for the default page size.
    const many = await seed({ artist: "zzremmanyart", album: "zzremmanyalb", song: "zzremmany 0" });
    await prisma.track.createMany({
        data: Array.from({ length: 24 }, (_, i) => ({
            id: `${P}-many-${i + 1}`, albumId: many.albumId, title: `zzremmany ${i + 1}`, trackNo: i + 2, duration: 100,
            filePath: `${P}-many-${i + 1}.flac`, fileModified: new Date(), fileSize: 1, mime: "FLAC",
        })),
    });

    await prisma.track.update({ where: { id: ids.later.trackId }, data: { displayTitle: "zzremlatershown" } });
    await prisma.album.update({ where: { id: ids.later.albumId }, data: { displayTitle: "zzremlatershownalb" } });
    await prisma.artist.update({ where: { id: ids.later.artistId }, data: { displayName: "zzremlatershownband" } });
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

const only = (rows: { id: string }[], wanted: string[]) => rows.map((r) => r.id).filter((id) => wanted.includes(id));

describe("search (v1) follows the spec", () => {
    const songIds = () => [ids.v1a, ids.v1b, ids.v1c, ids.v1gone, ids.v1disc].map((x) => x.trackId);

    it("answers a searchResult of offset, totalHits and match songs for `any`", async () => {
        const body = await ask("search", { any: "zzremv1" });
        expect(body.status).toBe("ok");
        expect(body.searchResult.offset).toBe(0);
        expect(body.searchResult.totalHits).toBe(3);
        const match = list<any>(body.searchResult.match);
        expect(only(match, songIds()).sort()).toEqual([ids.v1a.trackId, ids.v1b.trackId, ids.v1c.trackId].sort());
        expect(match[0]).toMatchObject({ isDir: false, type: "music" });
        // The old list shape is gone.
        expect(body.searchResult.song).toBeUndefined();
        expect(body.searchResult.artist).toBeUndefined();
        expect(body.searchResult.album).toBeUndefined();
    });

    it("`any` finds a song by its artist, its album or its title", async () => {
        expect(list<any>((await ask("search", { any: "zzremv1other" })).searchResult.match).map((m) => m.id)).toEqual([ids.v1c.trackId]);
        expect(list<any>((await ask("search", { any: "zzremv1 gamma" })).searchResult.match).map((m) => m.id)).toEqual([ids.v1c.trackId]);
        expect((await ask("search", { any: "zzremv1album" })).searchResult.totalHits).toBe(3);
    });

    it("`artist`, `album` and `title` each narrow the match, and together all must hold", async () => {
        const byArtist = await ask("search", { artist: "zzremv1artist" });
        expect(byArtist.searchResult.totalHits).toBe(2);
        const byTitle = await ask("search", { title: "beta" });
        expect(list<any>(byTitle.searchResult.match).map((m) => m.id)).toContain(ids.v1b.trackId);
        const both = await ask("search", { artist: "zzremv1artist", title: "zzremv1 beta" });
        expect(list<any>(both.searchResult.match).map((m) => m.id)).toEqual([ids.v1b.trackId]);
        const none = await ask("search", { artist: "zzremv1other", title: "zzremv1 beta" });
        expect(none.searchResult.totalHits).toBe(0);
        expect(none.searchResult.match).toBeUndefined();
        const byAlbum = await ask("search", { album: "zzremv1album", artist: "zzremv1other" });
        expect(list<any>(byAlbum.searchResult.match).map((m) => m.id)).toEqual([ids.v1c.trackId]);
    });

    it("pages by `count` and `offset`, totalHits staying the whole count", async () => {
        const first = await ask("search", { any: "zzremv1", count: "2" });
        const second = await ask("search", { any: "zzremv1", count: "2", offset: "2" });
        expect(first.searchResult).toMatchObject({ offset: 0, totalHits: 3 });
        expect(second.searchResult).toMatchObject({ offset: 2, totalHits: 3 });
        expect(list(first.searchResult.match)).toHaveLength(2);
        const all = [...list<any>(first.searchResult.match), ...list<any>(second.searchResult.match)].map((m) => m.id);
        expect(all.sort()).toEqual([ids.v1a.trackId, ids.v1b.trackId, ids.v1c.trackId].sort());
    });

    it("answers 20 matches when `count` is not given", async () => {
        const body = await ask("search", { any: "zzremmany" });
        expect(list(body.searchResult.match).length).toBe(20);
        expect(body.searchResult.totalHits).toBe(25);
    });

    it("finds an edited title, and the other search views keep their own shape", async () => {
        const body = await ask("search", { title: "zzremshownsong" });
        expect(list<any>(body.searchResult.match).map((m) => m.id)).toEqual([ids.edited.trackId]);
        const v3 = await ask("search3", { query: "zzremv1 alpha" });
        expect(v3.searchResult3.song).toBeDefined();
        expect(v3.searchResult3.totalHits).toBeUndefined();
    });
});

describe("edited names are searchable", () => {
    it("search3 finds a title, album title and artist name by the word shown", async () => {
        const body = await ask("search3", { query: "zzremshownsong", songCount: "5" });
        expect(only(list<any>(body.searchResult3.song), [ids.edited.trackId])).toEqual([ids.edited.trackId]);
        const alb = await ask("search3", { query: "zzremshownalbum", albumCount: "5" });
        expect(only(list<any>(alb.searchResult3.album), [ids.edited.albumId])).toEqual([ids.edited.albumId]);
        const art = await ask("search3", { query: "zzremshownband", artistCount: "5" });
        expect(only(list<any>(art.searchResult3.artist), [ids.edited.artistId])).toEqual([ids.edited.artistId]);
        // The album is also found by the artist's shown name, as the ranked search finds it by the artist's other one.
        const byArtist = await ask("search3", { query: "zzremshownband", albumCount: "5" });
        expect(only(list<any>(byArtist.searchResult3.album), [ids.edited.albumId])).toEqual([ids.edited.albumId]);
    });

    it("finds them by part of a word too (the substring search)", async () => {
        const body = await ask("search3", { query: "emshownsong", songCount: "5", albumCount: "5", artistCount: "5" });
        expect(only(list<any>(body.searchResult3.song), [ids.edited.trackId])).toEqual([ids.edited.trackId]);
        const alb = await ask("search3", { query: "emshownalbum", albumCount: "5" });
        expect(only(list<any>(alb.searchResult3.album), [ids.edited.albumId])).toEqual([ids.edited.albumId]);
        const art = await ask("search3", { query: "emshownband", artistCount: "5", albumCount: "5" });
        expect(only(list<any>(art.searchResult3.artist), [ids.edited.artistId])).toEqual([ids.edited.artistId]);
        expect(only(list<any>(art.searchResult3.album), [ids.edited.albumId])).toEqual([ids.edited.albumId]);
    });

    it("the file's own names still find them", async () => {
        const body = await ask("search3", { query: "zzremrawsong", songCount: "5" });
        expect(only(list<any>(body.searchResult3.song), [ids.edited.trackId])).toEqual([ids.edited.trackId]);
    });

    it("a name edited after the song was saved is found as well (web search, the same module)", async () => {
        const songs = await searchService.searchTracks({ query: "zzremlatershown" });
        expect(only(songs, [ids.later.trackId])).toEqual([ids.later.trackId]);
        const albums = await searchService.searchAlbums({ query: "zzremlatershownalb" });
        expect(only(albums, [ids.later.albumId])).toEqual([ids.later.albumId]);
        const artists = await searchService.searchArtists({ query: "zzremlatershownband" });
        expect(only(artists, [ids.later.artistId])).toEqual([ids.later.artistId]);
        // And by part of a word, through the substring search.
        expect(only(await searchService.searchTracks({ query: "tershown" }), [ids.later.trackId])).toEqual([ids.later.trackId]);
        expect(only(await searchService.searchAlbums({ query: "tershownalb" }), [ids.later.albumId])).toEqual([ids.later.albumId]);
        expect(only(await searchService.searchArtists({ query: "tershownband" }), [ids.later.artistId])).toEqual([ids.later.artistId]);
    });
});

describe("songs sort by the title shown", () => {
    // "zzremtie bbb" before "zzz", though aaa < bbb by the file's title
    const shown = () => [ids.s2.trackId, ids.s1.trackId];
    const mine = (songs: any) => list<any>(songs).map((s) => s.id).filter((id) => shown().includes(id));

    it("the empty-query enumeration", async () => {
        const body = await ask("search3", { query: "", songCount: "500" });
        expect(mine(body.searchResult3.song)).toEqual(shown());
    });

    it("getSongsByGenre", async () => {
        const body = await ask("getSongsByGenre", { genre: "zzremgenre" });
        expect(mine(body.songsByGenre.song)).toEqual(shown());
    });

    it("the substring search a full-text miss falls back to", async () => {
        const body = await ask("search3", { query: "remtie", songCount: "50" });
        expect(mine(body.searchResult3.song)).toEqual(shown());
    });

    it("a ranked search's ties", async () => {
        const body = await ask("search3", { query: "zzremtie", songCount: "50" });
        expect(mine(body.searchResult3.song)).toEqual(shown());
    });
});

describe("paging past the end of the full-text hits", () => {
    // Two matches by word, two by the substring search only. Page two of two is empty, not the substring search's rows.
    it("answers nothing, for artists, albums and songs", async () => {
        const first = await ask("search3", { query: "zzrempg", artistCount: "2", albumCount: "2", songCount: "2" });
        expect(list<any>(first.searchResult3.artist).map((a) => a.name).sort()).toEqual(["zzrempg alpha", "zzrempg beta"]);
        expect(list<any>(first.searchResult3.album).map((a) => a.name).sort()).toEqual(["zzrempg alpha", "zzrempg beta"]);
        expect(list<any>(first.searchResult3.song).map((a) => a.title).sort()).toEqual(["zzrempg alpha", "zzrempg beta"]);

        const second = await ask("search3", {
            query: "zzrempg", artistCount: "2", albumCount: "2", songCount: "2", artistOffset: "2", albumOffset: "2", songOffset: "2",
        });
        expect(second.searchResult3.artist).toBeUndefined();
        expect(second.searchResult3.album).toBeUndefined();
        expect(second.searchResult3.song).toBeUndefined();
    });

    it("still pages a search that only the substring search answers", async () => {
        const a = await ask("search3", { query: "rempg", artistCount: "2" });
        const b = await ask("search3", { query: "rempg", artistCount: "2", artistOffset: "2" });
        const names = [...list<any>(a.searchResult3.artist), ...list<any>(b.searchResult3.artist)].map((x) => x.name);
        expect(names).toEqual(["azzrempgx", "bzzrempgy", "zzrempg alpha", "zzrempg beta"]);
    });
});

describe("a query with a non-ASCII letter", () => {
    it("is matched as typed, not cut down to its ASCII letters", async () => {
        const body = await ask("search3", { query: "zzremunié", artistCount: "10", albumCount: "10", songCount: "10" });
        const own = (rows: any) => list<any>(rows).map((r) => r.id).filter((id) => id.startsWith(P));
        expect(own(body.searchResult3.artist)).toEqual([ids.uniAccent.artistId]);
        expect(own(body.searchResult3.album)).toEqual([ids.uniAccent.albumId]);
        expect(own(body.searchResult3.song)).toEqual([ids.uniAccent.trackId]);
    });

    it("on the web search too", async () => {
        const songs = await searchService.searchTracks({ query: "zzremunié" });
        expect(only(songs, [ids.uniPlain.trackId, ids.uniAccent.trackId])).toEqual([ids.uniAccent.trackId]);
    });
});

describe("getArtists counts albums as search3 does", () => {
    const entry = (body: any, id: string) =>
        list<any>(body.artists.index).flatMap((i) => list<any>(i.artist)).find((a) => a.id === id);

    it("counts the albums with a playable song, not the cached count", async () => {
        const body = await ask("getArtists", {});
        const search = await ask("search3", { query: "zzremcounted", artistCount: "5" });
        expect(entry(body, ids.counted.artistId)).toMatchObject({ albumCount: 1 });
        expect(list<any>(search.searchResult3.artist).find((a) => a.id === ids.counted.artistId)).toMatchObject({ albumCount: 1 });
    });

    it("leaves out an artist with nothing playable, as search3 does", async () => {
        const body = await ask("getArtists", {});
        expect(entry(body, ids.silent.artistId)).toBeUndefined();
    });

    it("getArtist agrees", async () => {
        const body = await ask("getArtist", { id: ids.counted.artistId });
        expect(body.artist.albumCount).toBe(1);
        expect(list(body.artist.album)).toHaveLength(1);
    });
});
