/**
 * Web search with a genre filter filters before it pages: the page asked for is full while matches remain, whichever
 * tracks outrank them. A genre can come from the artist's tags or from the song's own. Real router, database and Redis.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u_searchgenre", username: "t" }; next(); },
}));

import express from "express";
import request from "supertest";
import searchRoutes from "../search";
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { normalizeArtistName } from "../../services/artistIdentity";

const P = "zz-srchgenre";
const GENRE = "Zzgenrestyle";
const app = express();
app.use(express.json());
app.use("/search", searchRoutes);

const song = (n: string, albumId: string, title: string) => ({
    id: `${P}-t-${n}`, title, albumId, trackNo: 1, duration: 100,
    filePath: `/${P}/${n}.flac`, fileModified: new Date(), fileSize: 1000,
});

async function clearCache() {
    const keys = await redisClient.keys("search:*");
    if (keys.length) await redisClient.del(...keys);
}

async function clean() {
    await prisma.genre.deleteMany({ where: { id: `${P}-genre` } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await waitForRedisReady();
    await clean();
    // The tagged artist's songs sort after the other artist's, so a page cut before the filter holds none of them.
    for (const [key, name, genres] of [["tag", "Tagged", [GENRE]], ["plain", "Plain", ["other"]]] as const) {
        await prisma.artist.create({
            data: { id: `${P}-ar-${key}`, name: `${P} ${name}`, normalizedName: normalizeArtistName(`${P} ${name}`), identityKey: `${P}-${key}`, genres: [...genres] },
        });
        await prisma.album.create({
            data: { id: `${P}-al-${key}`, artistId: `${P}-ar-${key}`, rgMbid: `${P}-rg-${key}`, primaryType: "Album", title: `${P} ${name} album`, location: "LIBRARY" },
        });
    }
    await prisma.track.createMany({
        data: [
            song("p1", `${P}-al-plain`, "Pfenwick aaa one"),
            song("p2", `${P}-al-plain`, "Pfenwick aab two"),
            song("p3", `${P}-al-plain`, "Pfenwick aac three"),
            song("t1", `${P}-al-tag`, "Pfenwick zza one"),
            song("t2", `${P}-al-tag`, "Pfenwick zzb two"),
            song("t3", `${P}-al-tag`, "Pfenwick zzc three"),
            // Untagged artist, but the song itself carries the genre.
            song("own", `${P}-al-plain`, "Pfenwick zzd own"),
        ],
    });
    await prisma.genre.create({ data: { id: `${P}-genre`, name: GENRE, trackGenres: { create: { trackId: `${P}-t-own` } } } });
    await clearCache();
});

beforeEach(clearCache);
// Here, not in afterAll: the test setup closes Redis before a file's own afterAll runs.
afterEach(clearCache);

afterAll(clean);

const titles = (body: any) => body.tracks.map((t: any) => t.title);

it("fills a single-type page from the genre's songs, not from whatever outranks them", async () => {
    const res = await request(app).get("/search?q=pfenwick&type=tracks&genre=zzgenrestyle&limit=2");
    expect(res.status).toBe(200);
    expect(titles(res.body)).toEqual(["Pfenwick zza one", "Pfenwick zzb two"]);
});

it("fills the all-types track list from the genre's songs too", async () => {
    const res = await request(app).get("/search?q=pfenwick&type=all&genre=zzgenrestyle&limit=3");
    expect(res.status).toBe(200);
    expect(titles(res.body)).toEqual(["Pfenwick zza one", "Pfenwick zzb two", "Pfenwick zzc three"]);
});

it("keeps a song whose own genre matches though its artist is not tagged", async () => {
    const res = await request(app).get("/search?q=pfenwick&type=tracks&genre=zzgenrestyle&limit=10");
    expect(titles(res.body)).toEqual(["Pfenwick zza one", "Pfenwick zzb two", "Pfenwick zzc three", "Pfenwick zzd own"]);
});

it("finds nothing for a genre no one carries, and everything without a genre", async () => {
    const none = await request(app).get("/search?q=pfenwick&type=tracks&genre=zzunknowngenre&limit=10");
    expect(titles(none.body)).toEqual([]);
    const all = await request(app).get("/search?q=pfenwick&type=tracks&limit=10");
    expect(all.body.tracks).toHaveLength(7);
});

it("filters the plain substring search the same way (a query full text search cannot use)", async () => {
    const res = await request(app).get("/search?q=enwick&type=tracks&genre=zzgenrestyle&limit=2");
    expect(titles(res.body)).toEqual(["Pfenwick zza one", "Pfenwick zzb two"]);
});
