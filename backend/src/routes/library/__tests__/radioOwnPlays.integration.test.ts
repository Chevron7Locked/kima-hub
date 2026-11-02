/**
 * The favorites and discovery radio stations are the listener's own: favorites are the songs this listener plays most,
 * discovery the songs this listener has never played. Another user's plays change neither. Real router, real test
 * database and Redis; the covers case reads the same selection through GET /radio/row.
 *
 * Library: songs 0-1 have a missing file, 2-3 are corrupt, 4-39 play. User A played songs 10 and 11 (and, as bait, a
 * missing, a corrupt and a Discover song), user B played song 20 on another album, user C played nothing.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { redisClient } from "../../../utils/redis";
import router from "../tracks";
import { selectRadioTracks } from "../../../services/mixes/stationSelection";

jest.setTimeout(120_000);

const P = "rlo_";
const A = `${P}a`;
const B = `${P}b`;
const C = `${P}c`;
const trk = (i: number) => `${P}trk_${String(i).padStart(3, "0")}`;
const DISCOVER_SONG = `${P}dtrk`;
const SIGNED_OUT = undefined;

function appFor(userId: string | undefined) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (userId) req.user = { id: userId, username: userId, role: "user" } as typeof req.user;
        next();
    });
    app.use("/", router);
    return app;
}

async function station(userId: string | undefined, type: string, limit = 20): Promise<string[]> {
    const res = await request(appFor(userId)).get("/radio").query({ type, limit });
    expect(res.status).toBe(200);
    return (res.body.tracks as { id: string }[]).map((t) => t.id);
}

/** Every id the station offers over `calls` requests. */
async function offered(userId: string, type: string, limit: number, calls: number): Promise<Set<string>> {
    const seen = new Set<string>();
    for (let k = 0; k < calls; k++) for (const id of await station(userId, type, limit)) seen.add(id);
    return seen;
}

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

async function clearKeys() {
    const keys = await redisClient.keys(`radiocover:${P}*`);
    if (keys.length) await redisClient.del(...keys);
}

async function addAlbum(n: string, location: "LIBRARY" | "DISCOVER", cover: string) {
    await prisma.artist.create({
        data: { id: `${P}art_${n}`, name: `Own Artist ${n}`, normalizedName: `own artist ${n}`, identityKey: `${P}ak${n}` },
    });
    await prisma.album.create({
        data: { id: `${P}alb_${n}`, rgMbid: `${P}rg${n}`, artistId: `${P}art_${n}`, identityKey: `${P}ik${n}`, title: `Own Album ${n}`, primaryType: "Album", location, coverUrl: cover },
    });
}

beforeAll(async () => {
    await cleanup();
    await clearKeys();
    for (const u of [A, B, C]) await prisma.user.create({ data: { id: u, username: u, passwordHash: "x" } });
    await addAlbum("main", "LIBRARY", "native:own-main");
    await addAlbum("other", "LIBRARY", "native:own-other");
    await addAlbum("disc", "DISCOVER", "native:own-disc");
    await prisma.$executeRaw`
        INSERT INTO "Track" (id, "albumId", title, "trackNo", duration, "filePath", "fileModified", "fileSize", "missingSince", corrupt, "updatedAt")
        SELECT ${P + "trk_"} || lpad(i::text, 3, '0'), ${P + "alb_main"}, 'Own Track ' || i, 1, 200,
               '/tmp/' || ${P} || i || '.flac', now(), 1000,
               CASE WHEN i < 2 THEN now() END, i BETWEEN 2 AND 3, now()
        FROM generate_series(0, 39) AS i`;
    // Song 20 lives on the other album, so the two listeners' favorites have different covers.
    await prisma.track.update({ where: { id: trk(20) }, data: { albumId: `${P}alb_other` } });
    await prisma.$executeRaw`
        INSERT INTO "Track" (id, "albumId", title, "trackNo", duration, "filePath", "fileModified", "fileSize", corrupt, "updatedAt")
        VALUES (${DISCOVER_SONG}, ${P + "alb_disc"}, 'Own Discover Track', 1, 200, '/tmp/rlo_disc.flac', now(), 1000, false, now())`;
    // A heard songs 10 and 11 (11 twice, a day apart: two listens), plus a missing, a corrupt and a Discover song.
    const day = 86_400_000;
    const plays: [string, string, number][] = [
        [A, trk(10), 0], [A, trk(11), 0], [A, trk(11), day], [A, trk(0), 0], [A, trk(2), 0], [A, DISCOVER_SONG, 0],
        [B, trk(20), 0],
    ];
    await prisma.play.createMany({
        data: plays.map(([userId, trackId, ago], i) => ({ id: `${P}play_${i}`, userId, trackId, playedAt: new Date(Date.now() - ago - i * 1000), heard: true })),
    });
});

afterAll(async () => {
    await cleanup();
});

beforeEach(clearKeys);
// Jest closes Redis before afterAll, so the last test's keys are cleared here.
afterEach(clearKeys);

describe("favorites is this listener's own plays", () => {
    it("offers A only A's songs and B only B's", async () => {
        expect([...(await offered(A, "favorites", 20, 15))].sort()).toEqual([trk(10), trk(11)]);
        expect([...(await offered(B, "favorites", 20, 15))]).toEqual([trk(20)]);
    });

    it("never offers a missing, corrupt or Discover song, however often it was played", async () => {
        const seen = await offered(A, "favorites", 20, 15);
        for (const bad of [trk(0), trk(2), DISCOVER_SONG]) expect(seen.has(bad)).toBe(false);
    });

    it("weights by the listener's listens: the twice-listened song comes first more often", async () => {
        let wins = 0;
        const rounds = 200;
        for (let k = 0; k < rounds; k++) {
            const picked = await selectRadioTracks("favorites", undefined, {}, 1, A);
            if ("trackIds" in picked && picked.trackIds[0] === trk(11)) wins++;
        }
        // Two listens against one: about two thirds (a fair coin would be 100).
        expect(wins).toBeGreaterThan(rounds * 0.5);
    });

    it("falls back to random library songs for a listener with no plays", async () => {
        const seen = await offered(C, "favorites", 20, 10);
        expect(seen.size).toBeGreaterThan(20);
        for (const bad of [trk(0), trk(2), DISCOVER_SONG]) expect(seen.has(bad)).toBe(false);
    });
});

describe("discovery is this listener's never-played songs", () => {
    it("never offers A a song A played, and does offer the song only B played", async () => {
        const seen = await offered(A, "discovery", 5, 40);
        for (const played of [trk(10), trk(11)]) expect(seen.has(played)).toBe(false);
        expect(seen.has(trk(20))).toBe(true);
    });

    it("never offers B the song B played, and does offer what only A played", async () => {
        const seen = await offered(B, "discovery", 5, 40);
        expect(seen.has(trk(20))).toBe(false);
        expect(seen.has(trk(10)) || seen.has(trk(11))).toBe(true);
    });

    it("offers a listener with no plays any library song", async () => {
        const seen = await offered(C, "discovery", 5, 40);
        expect([trk(10), trk(20)].every((id) => seen.has(id))).toBe(true);
    });

    it("never offers a missing, corrupt or Discover song, even to a listener who played none", async () => {
        for (const who of [A, C]) {
            const seen = await offered(who, "discovery", 10, 10);
            for (const bad of [trk(0), trk(1), trk(2), trk(3), DISCOVER_SONG]) expect(seen.has(bad)).toBe(false);
        }
    });

    it("when the listener has heard nearly everything, fills with their least-played songs", async () => {
        // D heard every playable song twice except songs 30-33 (once): the fill takes the least played first.
        const D = `${P}d`;
        await prisma.user.create({ data: { id: D, username: D, passwordHash: "x" } });
        const heard: { id: string; userId: string; trackId: string; playedAt: Date; heard: boolean }[] = [];
        for (let i = 4; i < 40; i++) {
            const times = i >= 30 && i <= 33 ? 1 : 2;
            for (let k = 0; k < times; k++) heard.push({ id: `${P}d_${i}_${k}`, userId: D, trackId: trk(i), playedAt: new Date(Date.now() - (k + 1) * 86_400_000), heard: true });
        }
        // Someone else played 30-33 three times each: counted across everyone they would no longer be D's least played.
        for (let i = 30; i <= 33; i++) {
            for (let k = 0; k < 3; k++) heard.push({ id: `${P}c_${i}_${k}`, userId: C, trackId: trk(i), playedAt: new Date(Date.now() - (k + 1) * 86_400_000), heard: true });
        }
        await prisma.play.createMany({ data: heard });
        // The route then shuffles what the selection keeps, so read the selection: its first four are the least played.
        const picked = await selectRadioTracks("discovery", undefined, {}, 4, D);
        expect("trackIds" in picked).toBe(true);
        if ("trackIds" in picked) expect(picked.trackIds.slice(0, 4).sort()).toEqual([trk(30), trk(31), trk(32), trk(33)]);
        await prisma.play.deleteMany({ where: { userId: C } });
    });
});

describe("a request with no listener", () => {
    it.each(["favorites", "discovery"])("%s answers 401, never everyone's plays", async (type) => {
        const res = await request(appFor(SIGNED_OUT)).get("/radio").query({ type, limit: 20 });
        expect(res.status).toBe(401);
    });
});

describe("station covers follow the listener", () => {
    const cover = async (user: string, type: string) => {
        const res = await request(appFor(user)).get("/radio/row").query({ scope: "home", tz: "UTC" });
        expect(res.status).toBe(200);
        return (res.body.stations as { type: string; cover: string | null }[]).find((s) => s.type === type)!.cover;
    };

    it("favorites tiles differ per listener and come from that listener's own songs", async () => {
        expect(await cover(A, "favorites")).toBe("native:own-main");
        expect(await cover(B, "favorites")).toBe("native:own-other");
    });

    it("each listener's pick is kept for the day under their own key", async () => {
        await cover(A, "favorites");
        await cover(B, "favorites");
        const keys = (await redisClient.keys(`radiocover:${P}*`)).filter((k) => k.includes(":favorites:"));
        expect(keys.some((k) => k.includes(`:${A}:`))).toBe(true);
        expect(keys.some((k) => k.includes(`:${B}:`))).toBe(true);
    });
});
