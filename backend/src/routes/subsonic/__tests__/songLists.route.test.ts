/**
 * Every Subsonic song list (search, random, by genre, an artist's top songs, similar songs) describes a song the same
 * way: the content type and suffix a client streams by, the song, artist and album names as edited, and never a song whose
 * file is gone or unreadable. Search drops those before it pages, so a page is never short of what it could hold.
 * Real database, real router; only Subsonic auth is injected, as the parent router would.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { searchRouter } from "../search";
import { queueRouter } from "../queue";
import { lyricsRouter } from "../lyrics";

const MARK = "zz-songlists";
const GENRE = `${MARK}-genre`;

const USER = `${MARK}-user`;

function makeApp() {
    const app = express();
    app.use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    });
    app.use("/", searchRouter, queueRouter, lyricsRouter);
    return app;
}

let goodId: string;

async function cleanup() {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    const artist = await prisma.artist.create({
        data: { name: `${MARK} Artist`, displayName: "Shown Artist", identityKey: `${MARK}-artist`, libraryAlbumCount: 1, genres: [GENRE] },
    });
    const album = await prisma.album.create({
        data: {
            rgMbid: `${MARK}-rg`, identityKey: `${MARK}-album`, primaryType: "Album", title: `${MARK} Album`,
            displayTitle: "Shown Album", artistId: artist.id, location: "LIBRARY", year: 2020,
        },
    });
    const song = (n: number, extra: object = {}) => ({
        albumId: album.id, trackNo: n, duration: 200, mime: "FLAC", filePath: `/${MARK}/${n}.flac`,
        fileModified: new Date(), fileSize: 1000, ...extra,
    });
    const good = await prisma.track.create({ data: { title: `${MARK} good`, displayTitle: "Shown Song", ...song(1) } });
    goodId = good.id;
    await prisma.trackLyrics.create({ data: { track_id: good.id, plain_lyrics: "a line", source: "test" } });
    await prisma.track.create({ data: { title: `${MARK} missing`, ...song(2, { missingSince: new Date() }) } });
    await prisma.track.create({ data: { title: `${MARK} corrupt`, ...song(3, { corrupt: true }) } });
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

const lists: Array<[string, Record<string, string | number>, string]> = [
    ["/search3.view", { query: MARK, songCount: 50 }, "searchResult3"],
    ["/getRandomSongs.view", { genre: GENRE, size: 50 }, "randomSongs"],
    ["/getSongsByGenre.view", { genre: GENRE, count: 50 }, "songsByGenre"],
    ["/getTopSongs.view", { artist: `${MARK} Artist`, count: 50 }, "topSongs"],
    ["/getSimilarSongs2.view", { id: "GOOD", count: 50 }, "similarSongs2"],
];

describe.each(lists)("%s", (path, query, key) => {
    async function songs() {
        const q = { ...query, ...(query.id === "GOOD" ? { id: goodId } : {}) };
        const res = await request(makeApp()).get(path).query({ u: "tester", f: "json", ...q }).expect(200);
        return (res.body["subsonic-response"][key].song ?? []) as Array<Record<string, unknown>>;
    }

    it("describes the song with its stream type and its edited names", async () => {
        const good = (await songs()).find((s) => s.id === goodId);
        expect(good).toMatchObject({
            title: "Shown Song",
            artist: "Shown Artist",
            album: "Shown Album",
            contentType: "audio/flac",
            suffix: "flac",
            isDir: false,
            parent: expect.any(String),
        });
    });

    it("leaves out songs whose file is missing or unreadable", async () => {
        const titles = (await songs()).map((s) => s.title);
        expect(titles).toContain("Shown Song");
        expect(titles).not.toContain(`${MARK} missing`);
        expect(titles).not.toContain(`${MARK} corrupt`);
    });
});

describe("song search paging", () => {
    it("fills a page with playable songs when unreadable ones rank among the hits", async () => {
        const res = await request(makeApp())
            .get("/search3.view")
            .query({ u: "tester", f: "json", query: MARK, songCount: 1, artistCount: 0, albumCount: 0 })
            .expect(200);
        expect(res.body["subsonic-response"].searchResult3.song.map((s: { title: string }) => s.title)).toEqual(["Shown Song"]);
    });
});

describe("other replies that name a song", () => {
    it("a saved play queue reads back with the edited title", async () => {
        await request(makeApp()).get("/savePlayQueue.view").query({ u: USER, f: "json", id: goodId, current: goodId }).expect(200);
        const res = await request(makeApp()).get("/getPlayQueue.view").query({ u: USER, f: "json" }).expect(200);
        expect(res.body["subsonic-response"].playQueue.entry[0].title).toBe("Shown Song");
    });

    it("lyrics by song id carry the edited title", async () => {
        const res = await request(makeApp()).get("/getLyricsBySongId.view").query({ u: USER, f: "json", id: goodId }).expect(200);
        expect(res.body["subsonic-response"].lyricsList.structuredLyrics[0].displayTitle).toBe("Shown Song");
    });
});
