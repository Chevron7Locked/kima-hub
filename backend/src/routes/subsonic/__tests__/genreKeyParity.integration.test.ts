/**
 * One genre rule everywhere: genres are matched and grouped by genreKey (utils/genreSql.ts), never by
 * SQL name matching. Against the real test database: getGenres lists the spellings of one genre as
 * one entry with the counts summed (each artist counted once), a band named like a genre does not
 * add its songs to that genre, an artist's genres are getMergedGenres (its person-set genres REPLACE
 * the enriched ones when it set any), and the Subsonic genre filters and the web's genre radio select
 * the same artists for the same genre string.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { searchRouter } from "../search";
import { libraryRouter } from "../library";
import tracksRouter from "../../library/tracks";

const P = "gkp_";

function app() {
    const a = express();
    a.use(express.json());
    a.use((req: any, _res, next) => {
        req.user = { id: `${P}user`, username: "tester", role: "user" };
        next();
    });
    a.use("/", searchRouter);
    a.use("/", libraryRouter);
    a.use("/", tracksRouter);
    return a;
}

/** An artist with one album of `trackCount` songs, tagged `genres` (enriched) and `userGenres` (person-set). */
async function seedArtist(key: string, name: string, genres: string[], trackCount: number, userGenres: string[] = []) {
    await prisma.artist.create({
        data: {
            id: `${P}art_${key}`, name, identityKey: `${P}ak_${key}`,
            genres, userGenres, libraryAlbumCount: 1, totalTrackCount: trackCount,
        },
    });
    await prisma.album.create({
        data: {
            id: `${P}alb_${key}`, artistId: `${P}art_${key}`, rgMbid: `${P}rg_${key}`,
            title: `Album ${key}`, primaryType: "Album", location: "LIBRARY",
        },
    });
    await prisma.track.createMany({
        data: Array.from({ length: trackCount }, (_, i) => ({
            id: `${P}trk_${key}_${i}`,
            albumId: `${P}alb_${key}`,
            title: `Song ${key} ${i}`,
            trackNo: i + 1,
            duration: 200,
            filePath: `/tmp/${P}${key}_${i}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
        })),
    });
}

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    // Two spellings of one genre on artists of different sizes, one artist tagged with BOTH spellings
    // (it must be counted once), a band named "Jazz" tagged with its own name (its songs must not
    // count as the jazz genre), a plain jazz artist beside it, and an artist whose enriched genres
    // are ["jazz"] while a person tagged it ["rock"] (the person's list REPLACES the enriched one:
    // the artist is rock, no longer jazz). 15 songs so the web's /genres (15-song minimum) lists it.
    await seedArtist("hiphop2", "Quorvex Twin", ["Hip-Hop"], 2);
    await seedArtist("hiphop3", "Quorvex Sound", ["hip hop"], 3);
    await seedArtist("both", "Quorvex Dialect", ["Hip-Hop", "hip hop"], 4);
    await seedArtist("named", "Jazz", ["jazz"], 3);
    await seedArtist("jazz", "Quorvex Blue", ["jazz"], 2);
    await seedArtist("split", "Quorvex Split", ["jazz"], 15, ["rock"]);
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

async function subsonic(path: string, query: Record<string, string | number>) {
    const res = await request(app()).get(path).query({ ...query, f: "json" });
    expect(res.status).toBe(200);
    const body = res.body["subsonic-response"];
    expect(body.error).toBeUndefined();
    expect(body.status).toBe("ok");
    return body;
}

/** The artists behind a list of ids carrying prefix `kind` (trk_ or alb_), deduplicated. */
const artistKeysOf = (ids: string[], kind: "trk_" | "alb_") =>
    [...new Set(ids.filter((id) => id.startsWith(`${P}${kind}`)).map((id) => id.slice(`${P}${kind}`.length).replace(/_\d+$/, "")))].sort();

/** A Subsonic collection field as a list: one entry arrives as the bare object, many as an array. */
const list = (value: unknown): any[] => (Array.isArray(value) ? value : value ? [value] : []);

/** getGenres entries, as the JSON envelope spells the XML entry's fields value/songCount/albumCount. */
async function genreEntries() {
    const body = await subsonic("/getGenres.view", {});
    return list(body.genres.genre) as { value: string; songCount: number; albumCount: number }[];
}

describe("getGenres lists one genre per genreKey with summed counts", () => {
    it("merges the spellings of one genre into one entry named by its commonest spelling", async () => {
        const genres = await genreEntries();
        // "Hip-Hop" (2 songs) + "hip hop" (3) + the artist tagged with both (4, counted once):
        // one entry, 2+3+4 = 9 songs — an artist tagged with both spellings adds its songs ONCE,
        // not twice. "hip hop" (3+4 = 7 songs) is the spelling carrying the most songs.
        const hipHop = genres.filter((g) => g.value.toLowerCase().replace(/[^a-z]/g, "").includes("hiphop"));
        expect(hipHop).toEqual([
            { value: "hip hop", songCount: 9, albumCount: 3 },
        ]);
    });

    it("an artist named like the genre is not counted in it", async () => {
        // The band "Jazz" (tagged ["jazz"], 3 songs) is not the genre jazz: its self-name tag adds
        // nothing. The jazz entry counts Quorvex Blue (2 songs) only — the split artist's person-set
        // ["rock"] replaced its enriched ["jazz"], so it adds its songs to rock, not jazz.
        const genres = await genreEntries();
        expect(genres.find((g) => g.value === "jazz")).toEqual({ value: "jazz", songCount: 2, albumCount: 1 });
    });
});

describe("the web's genre matching and the Subsonic filters answer alike", () => {
    it("getSongsByGenre and the web's genre radio find the same artists for 'hip hop'", async () => {
        const subsonicSongs = await subsonic("/getSongsByGenre.view", { genre: "hip hop", count: 500 });
        const subsonicKeys = artistKeysOf(list(subsonicSongs.songsByGenre.song).map((s: { id: string }) => s.id), "trk_");
        const web = await request(app()).get("/radio").query({ type: "genre", value: "hip hop", limit: 100 });
        expect(web.status).toBe(200);
        const webKeys = artistKeysOf((web.body.tracks as { id: string }[]).map((t) => t.id), "trk_");
        // The band "Jazz" (artist "named") is not a hip-hop artist: an artist is matched by its
        // tags, never by its name.
        expect(webKeys).toEqual(["both", "hiphop2", "hiphop3"]);
        expect(subsonicKeys).toEqual(webKeys);
    });

    it("getAlbumList2 byGenre and getSongsByGenre find the same artists, spelling-proof", async () => {
        const songs = await subsonic("/getSongsByGenre.view", { genre: "Hip-Hop", count: 500 });
        const songsKeys = artistKeysOf(list(songs.songsByGenre.song).map((s: { id: string }) => s.id), "trk_");
        const albums = await subsonic("/getAlbumList2.view", { type: "byGenre", genre: "hiphop", size: 500 });
        const albumKeys = artistKeysOf(list(albums.albumList2.album).map((a: { id: string }) => a.id), "alb_");
        expect(albumKeys).toEqual(["both", "hiphop2", "hiphop3"]);
        expect(songsKeys).toEqual(albumKeys);
    });

    it("the band named 'Jazz' is reached through the genre it is tagged with, like anyone else", async () => {
        const songs = await subsonic("/getSongsByGenre.view", { genre: "jazz", count: 500 });
        const keys = artistKeysOf(list(songs.songsByGenre.song).map((s: { id: string }) => s.id), "trk_");
        // "split" is not here: its person-set ["rock"] replaced its enriched ["jazz"].
        expect(keys).toEqual(["jazz", "named"]);
    });

    it("an artist's person-set genres replace its enriched genres, in every surface", async () => {
        // "Quorvex Split": enriched genres ["jazz"], person-set genres ["rock"] (getMergedGenres:
        // the person's non-empty list REPLACES the enriched one). Every surface that filters by
        // genre must find it for rock ONLY — not for jazz, the genre the person removed — and
        // getGenres and the web's /genres must count it under rock alone.
        const jazzSongs = await subsonic("/getSongsByGenre.view", { genre: "jazz", count: 500 });
        expect(artistKeysOf(list(jazzSongs.songsByGenre.song).map((s: { id: string }) => s.id), "trk_")).not.toContain("split");

        const rockSongs = await subsonic("/getSongsByGenre.view", { genre: "rock", count: 500 });
        expect(artistKeysOf(list(rockSongs.songsByGenre.song).map((s: { id: string }) => s.id), "trk_")).toEqual(["split"]);

        const rockAlbums = await subsonic("/getAlbumList2.view", { type: "byGenre", genre: "rock", size: 500 });
        expect(artistKeysOf(list(rockAlbums.albumList2.album).map((a: { id: string }) => a.id), "alb_")).toEqual(["split"]);

        const rockRandom = await subsonic("/getRandomSongs.view", { genre: "rock", size: 500 });
        expect(artistKeysOf(list(rockRandom.randomSongs.song).map((s: { id: string }) => s.id), "trk_")).toEqual(["split"]);

        const web = await request(app()).get("/radio").query({ type: "genre", value: "rock", limit: 100 });
        expect(web.status).toBe(200);
        expect(artistKeysOf((web.body.tracks as { id: string }[]).map((t) => t.id), "trk_")).toEqual(["split"]);

        const genres = await genreEntries();
        expect(genres.find((g) => g.value === "rock")).toEqual({ value: "rock", songCount: 15, albumCount: 1 });

        // The web's own list: the split artist's 15 library songs carry the rock genre; its 15 songs
        // are counted under rock (the web counts songs through the same computeGenreTotals) and
        // none of its songs under jazz. The web list is capped at 20 genres, so look it up by name.
        const webGenres = await request(app()).get("/genres");
        expect(webGenres.status).toBe(200);
        const webRock = (webGenres.body.genres as { genre: string; count: number }[]).find((g) => g.genre === "rock");
        expect(webRock).toEqual({ genre: "rock", count: 15 });
    });
});
