/**
 * Paging song search3 keeps one result set. A page past the last full-text match stays empty; it does not switch to
 * the substring search's results. A query full-text search cannot match at all pages through the substring results.
 * Real database, real router; only Subsonic auth is injected, as the parent router would.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { searchRouter } from "../search";

const P = "zz-songpages";

function makeApp() {
    const app = express();
    app.use((req: any, _res, next) => {
        req.user = { id: "test-user", username: "tester", role: "user" };
        next();
    });
    app.use("/", searchRouter);
    return app;
}

const song = (n: number, title: string) => ({
    id: `${P}-t-${n}`, title, albumId: `${P}-al`, trackNo: n, duration: 100,
    filePath: `/${P}/${n}.flac`, fileModified: new Date(), fileSize: 1000,
});

async function clean() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await clean();
    await prisma.artist.create({ data: { id: `${P}-ar`, name: `${P} Artist`, identityKey: `${P}-ar` } });
    await prisma.album.create({
        data: { id: `${P}-al`, artistId: `${P}-ar`, rgMbid: `${P}-rg`, primaryType: "Album", title: `${P} Album`, location: "LIBRARY" },
    });
    await prisma.track.createMany({
        data: [
            // "gloamwick" is a word: full-text search finds these three.
            song(1, "Gloamwick one"),
            song(2, "Gloamwick two"),
            song(3, "Gloamwick three"),
            // Only the substring search finds this one ("gloamwick" inside a longer word).
            song(4, "Xgloamwicky four"),
        ],
    });
});

afterAll(clean);

async function page(query: string, songOffset: number, songCount = 2): Promise<string[]> {
    const res = await request(makeApp()).get("/search3.view").query({ u: "tester", query, songCount, songOffset, f: "json" }).expect(200);
    return (res.body["subsonic-response"].searchResult3.song ?? []).map((s: any) => s.title);
}

it("leaves a page past the last full-text match empty, not filled from the substring search", async () => {
    expect(await page("gloamwick", 0, 3)).toHaveLength(3);
    expect(await page("gloamwick", 3, 3)).toEqual([]);
    expect(await page("gloamwick", 6, 3)).toEqual([]);
});

it("pages one result set when full-text finds nothing, so the substring search's pages tile", async () => {
    // "loamwi" is no word, so full text finds nothing and the substring search answers every page.
    const first = await page("loamwi", 0, 2);
    const second = await page("loamwi", 2, 2);
    const third = await page("loamwi", 4, 2);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(third).toEqual([]);
    expect(new Set([...first, ...second]).size).toBe(4);
});
