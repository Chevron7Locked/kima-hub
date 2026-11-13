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

jest.setTimeout(60_000);

const P = "rfy_";
const ME = `${P}me`;
const OTHER = `${P}other`;
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
    for (const u of [ME, OTHER]) await prisma.user.create({ data: { id: u, username: u, passwordHash: "x" } });
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
    await prisma.play.createMany({
        data: [
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
    a.use("/recommendations", recommendationRoutes);
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
