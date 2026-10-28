/**
 * The Subsonic genre filters (getRandomSongs, getSongsByGenre, getAlbumList2 byGenre) on a real database where some
 * artists' genre columns hold JSON that is not an array: a bare string, an object. Such a value counts as no genres
 * (utils/genreSql.ts) instead of failing the whole request; a person's non-empty genre list REPLACES the enriched
 * ones (getMergedGenres), so an artist person-tagged with another genre is no longer found under the enriched one.
 */
import express from "express";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../utils/db";
import { searchRouter } from "../search";
import { libraryRouter } from "../library";

const P = "sgj_";
const GENRE = "sgjrock";

/** Each artist's genre columns, and whether a filter on GENRE should find it. */
const ARTISTS: { name: string; genres: unknown; userGenres?: unknown; found: boolean }[] = [
    { name: "array", genres: ["Sgjrock"], found: true },
    { name: "bareString", genres: GENRE, found: false },
    { name: "object", genres: { [GENRE]: true }, found: false },
    // The person's list replaces the enriched one: GENRE, enriched-only here, no longer selects this artist.
    { name: "personSet", genres: ["sgjjazz"], userGenres: [GENRE], found: true },
    { name: "personSetOverEnriched", genres: [GENRE], userGenres: ["sgjjazz"], found: false },
    { name: "personSetNone", genres: [GENRE], userGenres: [], found: true },
    { name: "personBareString", genres: ["sgjjazz"], userGenres: GENRE, found: false },
    { name: "personBareStringEnriched", genres: [GENRE], userGenres: GENRE, found: true },
];
const found = ARTISTS.filter((a) => a.found).map((a) => a.name).sort();

function app() {
    const a = express();
    a.use((req: any, _res, next) => {
        req.user = { id: `${P}user`, username: "tester", role: "user" };
        next();
    });
    a.use("/", searchRouter);
    a.use("/", libraryRouter);
    return a;
}

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    for (const [i, artist] of ARTISTS.entries()) {
        await prisma.artist.create({
            data: {
                id: `${P}art_${artist.name}`, name: `Genre ${artist.name}`, identityKey: `${P}ak_${artist.name}`,
                genres: artist.genres as Prisma.InputJsonValue,
                ...(artist.userGenres === undefined ? {} : { userGenres: artist.userGenres as Prisma.InputJsonValue }),
            },
        });
        await prisma.album.create({
            data: {
                id: `${P}alb_${artist.name}`, artistId: `${P}art_${artist.name}`, rgMbid: `${P}rg_${artist.name}`,
                title: `Album ${artist.name}`, primaryType: "Album",
            },
        });
        await prisma.track.create({
            data: {
                id: `${P}trk_${artist.name}`, albumId: `${P}alb_${artist.name}`, title: `Song ${artist.name}`,
                trackNo: i + 1, duration: 200, filePath: `/tmp/${P}${artist.name}.flac`, fileModified: new Date(),
                fileSize: 1000,
            },
        });
    }
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

/** The artist names behind the ids a response lists, under prefix `kind` (trk_ or alb_). */
const namesOf = (ids: string[], kind: "trk_" | "alb_") =>
    ids.filter((id) => id.startsWith(`${P}${kind}`)).map((id) => id.slice(`${P}${kind}`.length)).sort();

async function subsonic(path: string, query: Record<string, string | number>) {
    const res = await request(app()).get(path).query({ ...query, f: "json" });
    expect(res.status).toBe(200);
    const body = res.body["subsonic-response"];
    // The error, if any, says why.
    expect(body.error).toBeUndefined();
    expect(body.status).toBe("ok");
    return body;
}

describe("Subsonic genre filters with genre columns that are not JSON arrays", () => {
    it("getRandomSongs?genre= answers, finding the artists whose genres hold the genre", async () => {
        const body = await subsonic("/getRandomSongs.view", { genre: GENRE, size: 500 });
        expect(namesOf((body.randomSongs.song ?? []).map((s: { id: string }) => s.id), "trk_")).toEqual(found);
    });

    it("getSongsByGenre answers, finding the same artists", async () => {
        const body = await subsonic("/getSongsByGenre.view", { genre: GENRE, count: 500 });
        expect(namesOf((body.songsByGenre.song ?? []).map((s: { id: string }) => s.id), "trk_")).toEqual(found);
    });

    it("getAlbumList2 byGenre answers, finding the same artists' albums", async () => {
        const body = await subsonic("/getAlbumList2.view", { type: "byGenre", genre: GENRE, size: 500 });
        expect(namesOf((body.albumList2.album ?? []).map((a: { id: string }) => a.id), "alb_")).toEqual(found);
    });
});
