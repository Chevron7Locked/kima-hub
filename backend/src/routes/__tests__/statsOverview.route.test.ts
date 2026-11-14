/**
 * `GET /api/stats`: the page's two sections made of plays (listening and signature) read one fold of the plays into
 * listens between them, not one fold each. Real database; the signed-in person is stood in.
 */
import express from "express";
import request from "supertest";
import statsRoutes from "../stats";
import { prisma } from "../../utils/db";
import { mountAsServer } from "./helpers/serverMount";

jest.setTimeout(60_000);

const P = "ovr_";
const USER = `${P}user`;
const id = (s: string) => `${P}${s}`;
const DAY = 86_400_000;

function makeApp() {
    const app = express();
    app.use((req, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" } as typeof req.user;
        next();
    });
    mountAsServer(app, "/api/stats", statsRoutes, "/api/stats", { standIn: "preset" });
    return app;
}

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await prisma.artist.create({
        data: { id: id("art"), name: "Overview route", normalizedName: "overview route", identityKey: id("ak") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), identityKey: id("ik"), title: "Overview route album", primaryType: "Album", year: 2010 },
    });
    await prisma.track.create({
        data: {
            id: id("s1"), albumId: id("alb"), title: "s1", trackNo: 1, duration: 200, filePath: `/tmp/${P}s1.flac`,
            fileModified: new Date(), fileSize: 1000, energy: 0.5, valence: 0.5, bpm: 120, key: "C", keyScale: "major",
        },
    });
    // Three listens, a day apart.
    await prisma.play.createMany({
        data: [1, 2, 3].map((d) => ({
            id: id(`play_${d}`), userId: USER, trackId: id("s1"), playedAt: new Date(Date.now() - d * DAY), source: "LIBRARY" as const,
        })),
    });
});

afterAll(async () => {
    await cleanup();
});

/** Counted at the database client, so it holds however the sections are built: the fold is the one statement with a recursive walk. */
let folds = 0;
beforeEach(() => {
    folds = 0;
    const client = prisma as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const method of ["$queryRaw", "$executeRaw"] as const) {
        const real = client[method];
        jest.spyOn(client, method).mockImplementation(function (this: unknown, ...a: unknown[]) {
            const sql = (a[0] as { sql?: unknown } | null)?.sql;
            if (typeof sql === "string" && /WITH RECURSIVE/i.test(sql)) folds++;
            return real.apply(this, a);
        });
    }
});
afterEach(() => jest.restoreAllMocks());

describe("GET /api/stats", () => {
    it("folds the plays into listens once for the whole page", async () => {
        const res = await request(makeApp()).get("/api/stats?tz=UTC");
        expect(res.status).toBe(200);
        expect(folds).toBe(1);
    });

    it("folds once for a windowed page too, and both sections read that fold", async () => {
        const res = await request(makeApp()).get("/api/stats?tz=UTC&period=30d");
        expect(res.status).toBe(200);
        expect(folds).toBe(1);
        expect(res.body.listening.plays).toBe(3);
        expect(res.body.signature.concentration).toEqual({ forHalf: 1, forEighty: 1, distinct: 1 });
    });

    it("folds once for the hour detail and once for the region detail", async () => {
        const app = makeApp();
        expect((await request(app).get("/api/stats/hour?dow=1&hour=1&tz=UTC")).status).toBe(200);
        expect(folds).toBe(1);
        folds = 0;
        expect((await request(app).get("/api/stats/region?x=13&y=13")).status).toBe(200);
        expect(folds).toBe(1);
    });
});
