/**
 * Artist radio: how the similar-artist share of a station is drawn, on a few
 * hand-written rows in a real Postgres.
 *
 *   - An artist with no analysed track gives no sound to compare with, so no
 *     similar track has a closeness score and all of them are drawn uniformly.
 *   - A similar track whose score is exactly 0 has no weight, yet when there
 *     are too few weighted tracks to fill the slots it is taken to fill them.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import router from "../tracks";

jest.setTimeout(120_000);

const P = "rar_";
const app = express();
app.use(express.json());
app.use("/", router);

async function artist(id: string) {
    await prisma.artist.create({
        data: { id: `${P}${id}`, name: `Rule ${id}`, normalizedName: `rule ${id}`, identityKey: `${P}k_${id}` },
    });
    await prisma.album.create({
        data: { id: `${P}alb_${id}`, rgMbid: `${P}rg_${id}`, artistId: `${P}${id}`, identityKey: `${P}ik_${id}`, title: `Album ${id}`, primaryType: "Album" },
    });
}

async function track(artistKey: string, n: number, sound: { bpm?: number; energy?: number; valence?: number; danceability?: number } = {}) {
    const id = `${P}trk_${artistKey}_${n}`;
    await prisma.track.create({
        data: {
            id, albumId: `${P}alb_${artistKey}`, title: `Track ${artistKey} ${n}`, trackNo: n, duration: 200,
            filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000, ...sound,
        },
    });
    return id;
}

async function cleanup() {
    await prisma.similarArtist.deleteMany({ where: { fromArtistId: { startsWith: P } } });
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

async function link(from: string, to: string) {
    await prisma.ownedAlbum.create({ data: { artistId: `${P}${to}`, rgMbid: `${P}own_${to}`, source: "test" } });
    await prisma.similarArtist.create({ data: { fromArtistId: `${P}${from}`, toArtistId: `${P}${to}`, weight: 1 } });
}

async function station(artistKey: string, limit: number, n: number) {
    const seen: string[][] = [];
    for (let k = 0; k < n; k++) {
        const res = await request(app).get("/radio").query({ type: "artist", value: `${P}${artistKey}`, limit });
        expect(res.status).toBe(200);
        seen.push(res.body.tracks.map((t: { id: string }) => t.id));
    }
    return seen;
}

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("artist radio: similar tracks without a closeness score", () => {
    const similar: string[] = [];
    beforeAll(async () => {
        await cleanup();
        await artist("a");
        await artist("s");
        await track("a", 1);
        await track("a", 2);
        for (let i = 1; i <= 12; i++) similar.push(await track("s", i));
        await link("a", "s");
    });

    it("draws them uniformly: every one comes back", async () => {
        const seen = new Set((await station("a", 8, 60)).flat());
        for (const id of similar) expect(seen.has(id)).toBe(true);
    });
});

describe("artist radio: a similar track scoring exactly 0", () => {
    let zero: string;
    beforeAll(async () => {
        await cleanup();
        await artist("b");
        await artist("z");
        await track("b", 1, { bpm: 120, energy: 1, valence: 1, danceability: 1 });
        await track("b", 2, { bpm: 120, energy: 1, valence: 1, danceability: 1 });
        // 80 bpm away and the opposite of the artist on every other reading: score 0.
        zero = await track("z", 1, { bpm: 200, energy: 0, valence: 0, danceability: 0 });
        await track("z", 2, { bpm: 120, energy: 1, valence: 1, danceability: 1 });
        await track("z", 3, { bpm: 118, energy: 0.9, valence: 0.9, danceability: 0.9 });
        await link("b", "z");
    });

    it("is still taken when the slots outnumber the weighted tracks", async () => {
        // limit 5: 2 own tracks, 3 slots for similar tracks, only 2 of them weighted.
        for (const ids of await station("b", 5, 15)) {
            expect(ids).toHaveLength(5);
            expect(ids).toContain(zero);
        }
    });
});
