/**
 * A genre carried by more artists than one SQL statement may have bind parameters (65,535) still
 * answers with all of them: the artist ids travel as one array parameter, on the Subsonic genre
 * filters and on the web's genre radio. Real test database, 66,000 tagged artists.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { searchRouter } from "../search";
import { libraryRouter } from "../library";
import tracksRouter from "../../library/tracks";

const P = "gma_";
const N = 66000;

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

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    const ids = Array.from({ length: N }, (_, i) => i);
    for (let from = 0; from < N; from += 5000) {
        const chunk = ids.slice(from, from + 5000);
        await prisma.artist.createMany({
            data: chunk.map((i) => ({
                id: `${P}art_${i}`, name: `Many ${i}`, identityKey: `${P}ak_${i}`,
                genres: ["Zydeco Fusion"], libraryAlbumCount: 1, totalTrackCount: 1,
            })),
        });
        await prisma.album.createMany({
            data: chunk.map((i) => ({
                id: `${P}alb_${i}`, artistId: `${P}art_${i}`, rgMbid: `${P}rg_${i}`,
                title: `Album ${i}`, primaryType: "Album", location: "LIBRARY" as const,
            })),
        });
        await prisma.track.createMany({
            data: chunk.map((i) => ({
                id: `${P}trk_${i}`, albumId: `${P}alb_${i}`, title: `Song ${i}`, trackNo: 1,
                duration: 200, filePath: `/tmp/${P}${i}.flac`, fileModified: new Date(), fileSize: 1000,
            })),
        });
    }
    // The run's wipe empties every table and Postgres forgets their sizes until autovacuum next analyzes them, so a
    // query planned right after a 66,000-row load guesses one row and picks a plan that scans every song per album
    // (measured: 10+ minutes). A real library has statistics; give these tables theirs.
    await prisma.$executeRawUnsafe(`ANALYZE "Artist", "Album", "Track"`);
}, 300_000);

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
}, 300_000);

describe("a genre carried by more artists than the bind-parameter cap", () => {
    it("getSongsByGenre pages songs from artists past the 65,535th", async () => {
        const res = await request(app()).get("/getSongsByGenre.view")
            .query({ genre: "zydeco fusion", count: 500, offset: N - 500, f: "json" });
        const body = res.body["subsonic-response"];
        expect(res.status).toBe(200);
        expect(body.error).toBeUndefined();
        expect(body.songsByGenre.song).toHaveLength(500);
    });

    it("getAlbumList2 byGenre pages albums from artists past the 65,535th", async () => {
        const res = await request(app()).get("/getAlbumList2.view")
            .query({ type: "byGenre", genre: "zydeco fusion", size: 500, offset: N - 500, f: "json" });
        const body = res.body["subsonic-response"];
        expect(res.status).toBe(200);
        expect(body.error).toBeUndefined();
        expect(body.albumList2.album).toHaveLength(500);
    });

    it("getRandomSongs with a genre answers", async () => {
        const res = await request(app()).get("/getRandomSongs.view")
            .query({ genre: "zydeco fusion", size: 50, f: "json" });
        const body = res.body["subsonic-response"];
        expect(res.status).toBe(200);
        expect(body.error).toBeUndefined();
        expect(body.randomSongs.song).toHaveLength(50);
    });

    it("the web genre radio answers", async () => {
        const res = await request(app()).get("/radio").query({ type: "genre", value: "zydeco fusion", limit: 20 });
        expect(res.status).toBe(200);
        expect(res.body.tracks.length).toBeGreaterThan(0);
    });
});
