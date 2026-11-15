/**
 * What Subsonic answers for a song's bitRate: the bitrate the scan stored, an estimate from the codec for a song with
 * none stored. Through getSong (the library router) and search3 (its own raw query, which must read the column too).
 * Real routers and database; only Subsonic auth is injected, as the parent router would.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { libraryRouter } from "../library";
import { searchRouter } from "../search";

const P = "zz-sbr";

function app() {
    const a = express();
    a.use((req: any, _res, next) => {
        req.user = { id: `${P}-user`, username: "tester", role: "user" };
        next();
    });
    a.use("/", libraryRouter);
    a.use("/", searchRouter);
    return a;
}

const reply = (path: string, query: Record<string, string>) =>
    request(app()).get(path).query({ u: "tester", f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);

const song = (n: number, title: string, mime: string, bitrate: number | null) => ({
    id: `${P}-t-${n}`, title, albumId: `${P}-al`, trackNo: n, duration: 100, mime, bitrate,
    filePath: `/${P}/${n}`, fileModified: new Date(), fileSize: 1000,
});

async function clean() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await clean();
    await prisma.artist.create({ data: { id: `${P}-ar`, name: `${P} Artist`, identityKey: `${P}-ar` } });
    await prisma.album.create({ data: { id: `${P}-al`, artistId: `${P}-ar`, rgMbid: `${P}-rg`, primaryType: "Album", title: `${P} Album`, location: "LIBRARY" } });
    await prisma.track.createMany({
        data: [
            song(1, "Brightwater stored", "MPEG 1 Layer 3", 320),
            song(2, "Brightwater lossless stored", "FLAC", 1011),
            song(3, "Brightwater unread", "FLAC", null),
        ],
    });
});

afterAll(async () => {
    await clean();
    await prisma.$disconnect();
});

describe("a song's bitRate in an answer", () => {
    it("getSong gives the stored bitrate, and the codec's estimate for a song with none", async () => {
        expect((await reply("/getSong.view", { id: `${P}-t-1` })).song.bitRate).toBe(320);
        expect((await reply("/getSong.view", { id: `${P}-t-2` })).song.bitRate).toBe(1011);
        expect((await reply("/getSong.view", { id: `${P}-t-3` })).song.bitRate).toBe(900);
    });

    it("search3 gives the same", async () => {
        const res = await reply("/search3.view", { query: "brightwater", songCount: "10" });
        const bitRates = Object.fromEntries(res.searchResult3.song.map((s: any) => [s.id, s.bitRate]));
        expect(bitRates).toEqual({ [`${P}-t-1`]: 320, [`${P}-t-2`]: 1011, [`${P}-t-3`]: 900 });
    });
});
