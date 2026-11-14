/**
 * GET /recommendations/for-you seeds from the artists of the listener's 50 most recent plays of playable songs: a
 * Discover or missing song's plays seed nothing, another listener's plays seed nothing, and the three most played
 * artists give their similar artists. Real test database.
 */
jest.mock("../../utils/redis", () => ({ redisClient: { mget: jest.fn(async () => []), get: jest.fn(async () => null) } }));
jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import recommendationRoutes from "../recommendations";
import { mountAsServer } from "./helpers/serverMount";

jest.setTimeout(60_000);

const P = "rfy_";
const ME = `${P}me`;
const OTHER = `${P}other`;
const MANY = `${P}many`;
const id = (s: string) => `${P}${s}`;
const mins = (n: number) => new Date(Date.now() - n * 60_000);

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.similarArtist.deleteMany({ where: { fromArtistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

// Seed artist, album location, whether its one song's file is missing: x and y play, w's song is missing, d is on a
// Discover album, o is played only by the other listener.
const ARTISTS: Array<[string, "LIBRARY" | "DISCOVER", boolean]> = [
    ["x", "LIBRARY", false], ["y", "LIBRARY", false], ["w", "LIBRARY", true], ["d", "DISCOVER", false], ["o", "LIBRARY", false],
];

let n = 0;
const plays = (user: string, artist: string, count: number) =>
    Array.from({ length: count }, (_, k) => ({ id: id(`play_${n++}`), userId: user, trackId: id(`t_${artist}`), playedAt: mins(k + 1) }));

beforeAll(async () => {
    await cleanup();
    for (const u of [ME, OTHER, MANY]) await prisma.user.create({ data: { id: u, username: u, passwordHash: "x" } });
    for (const [a, location, missing] of ARTISTS) {
        await prisma.artist.create({ data: { id: id(`art_${a}`), name: `Seed ${a}`, normalizedName: `seed ${a}`, identityKey: id(`ak_${a}`) } });
        await prisma.album.create({
            data: { id: id(`alb_${a}`), rgMbid: id(`rg_${a}`), artistId: id(`art_${a}`), identityKey: id(`ik_${a}`), title: `Seed ${a}`, primaryType: "Album", location },
        });
        await prisma.track.create({
            data: {
                id: id(`t_${a}`), albumId: id(`alb_${a}`), title: a, trackNo: 1, duration: 200, filePath: `/tmp/${P}${a}.flac`,
                fileModified: new Date(), fileSize: 1000, missingSince: missing ? new Date() : null,
            },
        });
        // Each seed artist has one similar artist, a stranger to the library.
        await prisma.artist.create({ data: { id: id(`sim_${a}`), name: `Similar to ${a}`, normalizedName: `similar to ${a}`, identityKey: id(`sk_${a}`) } });
        await prisma.similarArtist.create({ data: { fromArtistId: id(`art_${a}`), toArtistId: id(`sim_${a}`), weight: 1 } });
    }
    // One listener whose seed artist has ten similar artists, so the page size shows: three seeds, ten each, at most 30.
    await prisma.artist.create({ data: { id: id("art_z"), name: "Seed z", normalizedName: "seed z", identityKey: id("ak_z") } });
    await prisma.album.create({
        data: { id: id("alb_z"), rgMbid: id("rg_z"), artistId: id("art_z"), identityKey: id("ik_z"), title: "Seed z", primaryType: "Album", location: "LIBRARY" },
    });
    await prisma.track.create({
        data: { id: id("t_z"), albumId: id("alb_z"), title: "z", trackNo: 1, duration: 200, filePath: `/tmp/${P}z.flac`, fileModified: new Date(), fileSize: 1000 },
    });
    for (let k = 0; k < 10; k++) {
        await prisma.artist.create({ data: { id: id(`zs_${k}`), name: `Z similar ${k}`, normalizedName: `z similar ${k}`, identityKey: id(`zk_${k}`) } });
        await prisma.similarArtist.create({ data: { fromArtistId: id("art_z"), toArtistId: id(`zs_${k}`), weight: 1 } });
    }
    await prisma.play.createMany({
        data: [
            ...plays(MANY, "z", 3),
            ...plays(ME, "x", 5), ...plays(ME, "y", 2),
            // Heard most, but not of a playable song.
            ...plays(ME, "d", 9), ...plays(ME, "w", 9),
            ...plays(OTHER, "o", 9),
        ],
    });
});

afterAll(cleanup);

function appFor(user: string) {
    const a = express();
    a.use((req: any, _res, next) => { req.user = { id: user, username: user, role: "user" }; next(); });
    mountAsServer(a, "/recommendations", recommendationRoutes, "/api/recommendations");
    return a;
}

const seeded = (body: { artists: Array<{ id: string }> }) => body.artists.map((a) => a.id).filter((i) => i.startsWith(P)).sort();

it("recommends the similar artists of the artists this listener plays, leaving out Discover and missing songs", async () => {
    const res = await request(appFor(ME)).get("/recommendations/for-you?limit=10");
    expect(res.status).toBe(200);
    expect(seeded(res.body)).toEqual([id("sim_x"), id("sim_y")]);
});

it("is the listener's own: another listener's plays seed their recommendations, not mine", async () => {
    const res = await request(appFor(OTHER)).get("/recommendations/for-you?limit=10");
    expect(res.status).toBe(200);
    expect(seeded(res.body)).toEqual([id("sim_o")]);
});

describe("the limit query value", () => {
    const count = async (query: string) => {
        const res = await request(appFor(MANY)).get(`/recommendations/for-you${query}`);
        expect(res.status).toBe(200);
        return seeded(res.body).length;
    };

    it("is the default of 10 when absent or not a number", async () => {
        // The artist has exactly ten similar artists, so a default above 10 would not show: 3 and abc tell them apart.
        expect(await count("")).toBe(10);
        expect(await count("?limit=abc")).toBe(10);
        expect(await count("?limit=")).toBe(10);
    });

    it("gives what was asked for within 1 to 50", async () => {
        expect(await count("?limit=3")).toBe(3);
        expect(await count("?limit=1")).toBe(1);
        // Three seeds give at most 30 artists, so the cap of 50 shows only as "no error and everything there is".
        expect(await count("?limit=9999")).toBe(10);
    });

    it("is at least 1 for zero or a negative number", async () => {
        expect(await count("?limit=0")).toBeGreaterThanOrEqual(1);
        expect(await count("?limit=-5")).toBeGreaterThanOrEqual(1);
    });
});
