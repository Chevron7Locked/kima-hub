/**
 * What each reader that counts plays answers on one seeded history: the shelf's heard counts, the familiar-song seeds, the
 * stats page's never-listened slice, the Subsonic recent and frequent album lists, and the web artist page's own-listens
 * fallback. All of them count listens, so two rows of one song a few seconds apart are one, and a row the listen rule
 * did not record as heard counts the same as one it did. Real database.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { redisClient } from "../../../utils/redis";
import { libraryRouter } from "../../../routes/subsonic/library";
import libraryArtistsRouter from "../../../routes/library/artists";
import { deezerService } from "../../deezer";
import { dataCacheService } from "../../dataCache";
import * as artistSimilarity from "../../artistSimilarity";
import { seedsOf } from "../../mixes/familiarity";
import { playableSlice } from "../playable";
import { shelfStats } from "../shelf";

jest.setTimeout(60_000);

const P = "zz-readers-meaning";
const U = `${P}-u`;
const V = `${P}-v`;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const song = (s: string) => `${P}-${s}`;

// artist A: album 1 (1911) with s1, s2, s3, s5; artist B: album 2 (1921) with s4; artist C: album 3 (1931) with s6.
const ALBUMS: Array<{ key: string; artist: string; year: number; songs: string[] }> = [
    { key: "1", artist: "a", year: 1911, songs: ["s1", "s2", "s3", "s5"] },
    { key: "2", artist: "b", year: 1921, songs: ["s4"] },
    { key: "3", artist: "c", year: 1931, songs: ["s6"] },
];
let n = 0;
const row = (user: string, s: string, days: number, heard: boolean) =>
    ({ id: `${P}-play-${String(n++).padStart(3, "0")}`, userId: user, trackId: song(s), playedAt: ago(days), heard });
/** Two rows ten seconds apart: one listen. */
const repeat = (user: string, s: string, days: number) => [row(user, s, days, true), { ...row(user, s, days - 10 / 86_400, true) }];

const app = express()
    .use((req: any, _res, next) => { req.user = { id: U, username: U, role: "user" }; next(); })
    .use("/rest", libraryRouter)
    .use("/api/library", libraryArtistsRouter);

beforeAll(async () => {
    for (const u of [U, V]) await prisma.user.create({ data: { id: u, username: u, passwordHash: "x" } });
    for (const a of ALBUMS) {
        await prisma.artist.create({ data: { id: `${P}-ar-${a.artist}`, name: `${P} Artist ${a.artist}`, normalizedName: `${P} artist ${a.artist}`, identityKey: `${P}-ik-${a.artist}` } });
        await prisma.album.create({
            data: {
                id: `${P}-al-${a.key}`, rgMbid: `${P}-rg-${a.key}`, artistId: `${P}-ar-${a.artist}`, identityKey: `${P}-aik-${a.key}`,
                title: `${P} Album ${a.key}`, year: a.year, primaryType: "Album", location: "LIBRARY",
            },
        });
        for (const s of a.songs) {
            await prisma.track.create({
                data: { id: song(s), albumId: `${P}-al-${a.key}`, title: s, trackNo: 1, duration: 200, filePath: `${P}-${s}.flac`, fileModified: new Date(), fileSize: 1 },
            });
        }
    }
    await prisma.play.createMany({
        data: [
            // s1: three listens, the newest written as two rows ten seconds apart; s3: two listens whose rows the listen
            // rule did not record as heard; s5: one recent listen; s2: one older listen; s6: one play an hour ago, album 3.
            ...repeat(U, "s1", 1), row(U, "s1", 2, true), row(U, "s1", 3, true),
            row(U, "s3", 4, false), row(U, "s3", 8, false),
            row(U, "s5", 1.5, true),
            row(U, "s2", 5, true),
            row(U, "s6", 1 / 24, true),
            // Someone else played s4: it is still never played by U.
            row(V, "s4", 1, true), row(V, "s1", 1, true),
        ],
    });
});

afterAll(async () => {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
    await redisClient.del(`similar-artists-list:${P}-ar-a`);
});

it("the shelf counts a song, album and artist heard once any listen of it exists, whether or not the rows were recorded as heard", async () => {
    const shelf = await shelfStats(U);
    expect(shelf.tracks.heard).toBe(5);
    expect(shelf.albums.heard).toBe(2);
    expect(shelf.artists.heard).toBe(2);
    const heardIn = (decade: number) => shelf.decades.find((d) => d.decade === decade)?.heard;
    expect([heardIn(1910), heardIn(1920), heardIn(1930)]).toEqual([1, 0, 1]);
    // Someone else's listens are no one's but theirs.
    expect((await shelfStats(`${P}-nobody`)).tracks.heard).toBe(0);
});

it("the familiar seeds are the songs listened to, most listens first and then the most recent, s1's two rows one listen", async () => {
    const seeds = (await seedsOf(U, new Date())).filter((s) => s.id.startsWith(P));
    expect(seeds.map((s) => [s.id, s.plays])).toEqual([
        [song("s1"), 3], [song("s3"), 2], [song("s6"), 1], [song("s5"), 1], [song("s2"), 1],
    ]);
});

it("the never-listened slice holds no song this listener has a listen of, whoever else listened to it", async () => {
    const ids = (await playableSlice({ userId: U, slice: "never", limit: 100 })).map((t) => t.id);
    for (const played of ["s1", "s2", "s3", "s5", "s6"]) expect(ids).not.toContain(song(played));
    if (ids.length < 100) expect(ids).toContain(song("s4"));
});

describe("Subsonic album lists", () => {
    const list = async (type: string) => {
        const res = await request(app).get("/rest/getAlbumList2.view").query({ u: U, f: "json", type, size: "500" }).expect(200);
        return (res.body["subsonic-response"].albumList2.album ?? []).map((a: { id: string }) => a.id);
    };

    it("recent: the albums this listener played, newest play first", async () => {
        expect(await list("recent")).toEqual([`${P}-al-3`, `${P}-al-1`]);
    });

    it("frequent: the albums by listens, most listened to first", async () => {
        // album 1: s1 x3, s3 x2, s5, s2 = 7 listens (s1's ten-second pair is one); album 3: 1. Someone else's plays of s1 and s4 do not count.
        expect(await list("frequent")).toEqual([`${P}-al-1`, `${P}-al-3`]);
    });
});

it("the artist page, with no global list, falls back to this listener's own listens, most first and then the most recent", async () => {
    const top = jest.spyOn(deezerService, "getArtistTopTracks").mockResolvedValue([] as never);
    const image = jest.spyOn(dataCacheService, "getArtistImage").mockResolvedValue(null);
    const similar = jest.spyOn(artistSimilarity, "getSimilarArtists").mockResolvedValue([]);
    try {
        const res = await request(app).get(`/api/library/artists/${P}-ar-a`).expect(200);
        expect(res.body.topTracks.map((t: { id: string; userPlayCount: number }) => [t.id, t.userPlayCount])).toEqual([
            [song("s1"), 3], [song("s3"), 2], [song("s5"), 1], [song("s2"), 1],
        ]);
    } finally {
        top.mockRestore();
        image.mockRestore();
        similar.mockRestore();
    }
});
