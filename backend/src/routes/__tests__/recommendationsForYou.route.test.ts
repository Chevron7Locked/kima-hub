/**
 * GET /recommendations/for-you seeds from the artists of the listener's 50 most recent plays of playable songs: a
 * Discover or missing song's plays seed nothing, another listener's plays seed nothing, and the three most played
 * artists give their similar artists. `limit` is a number from 1 to 50, 10 when absent or not a number. Real test database.
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
const WIDE = `${P}many`;
const CROWDED = `${P}crowded`;
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
    for (const u of [ME, OTHER, WIDE, CROWDED]) await prisma.user.create({ data: { id: u, username: u, passwordHash: "x" } });
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
    // A listener with two seed artists of ten similar artists each (20 in all), so a page size of 10 shows.
    for (const seed of ["z1", "z2"]) {
        await prisma.artist.create({ data: { id: id(`art_${seed}`), name: `Seed ${seed}`, normalizedName: `seed ${seed}`, identityKey: id(`ak_${seed}`) } });
        await prisma.album.create({
            data: { id: id(`alb_${seed}`), rgMbid: id(`rg_${seed}`), artistId: id(`art_${seed}`), identityKey: id(`ik_${seed}`), title: `Seed ${seed}`, primaryType: "Album", location: "LIBRARY" },
        });
        await prisma.track.create({
            data: { id: id(`t_${seed}`), albumId: id(`alb_${seed}`), title: seed, trackNo: 1, duration: 200, filePath: `/tmp/${P}${seed}.flac`, fileModified: new Date(), fileSize: 1000 },
        });
        for (let k = 0; k < 10; k++) {
            await prisma.artist.create({ data: { id: id(`${seed}_sim_${k}`), name: `${seed} similar ${k}`, normalizedName: `${seed} similar ${k}`, identityKey: id(`${seed}_sk_${k}`) } });
            await prisma.similarArtist.create({ data: { fromArtistId: id(`art_${seed}`), toArtistId: id(`${seed}_sim_${k}`), weight: 1 } });
        }
    }
    // A listener whose one seed artist has 12 similar artists the library already owns (weighted highest) and 13 it does
    // not. The unowned ones share one weight and are inserted in reverse id order, so only the tie-break orders them.
    await prisma.artist.create({ data: { id: id("art_q"), name: "Seed q", normalizedName: "seed q", identityKey: id("ak_q") } });
    await prisma.album.create({
        data: { id: id("alb_q"), rgMbid: id("rg_q"), artistId: id("art_q"), identityKey: id("ik_q"), title: "Seed q", primaryType: "Album", location: "LIBRARY" },
    });
    await prisma.track.create({
        data: { id: id("t_q"), albumId: id("alb_q"), title: "q", trackNo: 1, duration: 200, filePath: `/tmp/${P}q.flac`, fileModified: new Date(), fileSize: 1000 },
    });
    for (let k = 0; k < 12; k++) {
        const owned = id(`q_owned_${k}`);
        await prisma.artist.create({ data: { id: owned, name: `q owned ${k}`, normalizedName: `q owned ${k}`, identityKey: id(`qok_${k}`) } });
        await prisma.ownedAlbum.create({ data: { artistId: owned, rgMbid: id(`qorg_${k}`), source: "native" } });
        await prisma.similarArtist.create({ data: { fromArtistId: id("art_q"), toArtistId: owned, weight: 2 } });
    }
    for (let k = 12; k >= 0; k--) {
        const free = id(`q_free_${String(k).padStart(2, "0")}`);
        await prisma.artist.create({ data: { id: free, name: `q free ${k}`, normalizedName: `q free ${k}`, identityKey: id(`qfk_${k}`) } });
        await prisma.similarArtist.create({ data: { fromArtistId: id("art_q"), toArtistId: free, weight: 1 } });
    }
    await prisma.play.createMany({
        data: [
            ...plays(CROWDED, "q", 4),
            ...plays(WIDE, "z1", 3), ...plays(WIDE, "z2", 2),
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
        const res = await request(appFor(WIDE)).get(`/recommendations/for-you${query}`);
        expect(res.status).toBe(200);
        return seeded(res.body).length;
    };

    it("is the default of 10 when absent or not a number", async () => {
        // There are 20 artists to give, so a default other than 10 (or NaN, which gave none) shows.
        expect(await count("")).toBe(10);
        expect(await count("?limit=abc")).toBe(10);
        expect(await count("?limit=")).toBe(10);
    });

    it("gives what was asked for within 1 to 50", async () => {
        expect(await count("?limit=3")).toBe(3);
        expect(await count("?limit=1")).toBe(1);
        // The cap of 50 itself is parseLimit's, tested in library/__tests__/paging.test.ts: three seeds give at most 30 here.
        expect(await count("?limit=9999")).toBe(20);
    });

    it("is at least 1 for zero or a negative number", async () => {
        // Zero is read as "no value": the default. A negative number is raised to 1.
        expect(await count("?limit=0")).toBe(10);
        expect(await count("?limit=-5")).toBe(1);
    });
});

describe("a seed artist whose most similar artists the library already owns", () => {
    const freeIds = (n: number) => Array.from({ length: n }, (_, k) => id(`q_free_${String(k).padStart(2, "0")}`));
    const forYou = async (query: string) => {
        const res = await request(appFor(CROWDED)).get(`/recommendations/for-you${query}`);
        expect(res.status).toBe(200);
        return res.body.artists.map((a: { id: string }) => a.id);
    };

    it("still gives `limit` artists when enough unowned ones exist", async () => {
        // The 12 owned artists weigh most: taking the top ten similar artists first and dropping owned ones after would give none.
        expect(await forYou("?limit=10")).toHaveLength(10);
        expect(await forYou("?limit=13")).toHaveLength(13);
        expect(await forYou("?limit=30")).toHaveLength(13);
    });

    it("never gives an owned artist", async () => {
        expect((await forYou("?limit=50")).every((a: string) => a.startsWith(id("q_free_")))).toBe(true);
    });

    it("breaks equal weights by artist id, the same order every time", async () => {
        expect(await forYou("?limit=5")).toEqual(freeIds(5));
        expect(await forYou("?limit=5")).toEqual(freeIds(5));
    });
});
