/**
 * POST /radio/covers gives a station tile its cover for the whole page in one request. A station shuffles, so the
 * cover is each listener's pick for the local day, kept in Redis: the same listener gets the same cover all day, and a
 * Discover album's cover is never one. Real router, real test database and Redis.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { redisClient } from "../../../utils/redis";
import router from "../tracks";

jest.setTimeout(120_000);

const P = "rcv_";
const LIBRARY_ALBUMS = 12;
const TRACKS_PER_ALBUM = 3;
const DISCOVER_TRACKS = 60;
const coverOf = (n: number) => `native:cover-${n}`;
const DISCOVER_COVER = "native:cover-discover";

function appFor(userId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { id: userId, username: userId, role: "user" } as typeof req.user;
        next();
    });
    app.use("/", router);
    return app;
}

const covers = (userId: string, stations: unknown, tz?: unknown) =>
    request(appFor(userId)).post("/radio/covers").send({ stations, tz });

async function clearKeys() {
    const keys = await redisClient.keys("radiocover:rcv_*");
    if (keys.length) await redisClient.del(...keys);
}

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

async function addAlbum(n: number, location: "LIBRARY" | "DISCOVER", tracks: number, cover: string, year: number) {
    await prisma.artist.create({
        data: { id: `${P}art_${n}`, name: `Cover Artist ${n}`, normalizedName: `cover artist ${n}`, identityKey: `${P}ak${n}`, genres: ["rcvgenre"] },
    });
    await prisma.album.create({
        data: {
            id: `${P}alb_${n}`, rgMbid: `${P}rg${n}`, artistId: `${P}art_${n}`, identityKey: `${P}ik${n}`,
            title: `Cover Album ${n}`, primaryType: "Album", location, coverUrl: cover, year,
        },
    });
    await prisma.$executeRaw`
        INSERT INTO "Track" (id, "albumId", title, "trackNo", duration, "filePath", "fileModified", "fileSize", corrupt, "updatedAt")
        SELECT ${P + "trk_" + n + "_"} || lpad(i::text, 3, '0'), ${`${P}alb_${n}`}, ${"Cover Track " + n + " "} || i, 1, 200,
               '/tmp/' || ${P} || ${n} || '_' || i || '.flac', now(), 1000, false, now()
        FROM generate_series(0, ${tracks - 1}) AS i`;
}


beforeAll(async () => {
    await cleanup();
    await clearKeys();
    for (const u of ["a", "b"]) await prisma.user.create({ data: { id: `${P}${u}`, username: `${P}${u}`, passwordHash: "x" } });
    for (let n = 0; n < LIBRARY_ALBUMS; n++) await addAlbum(n, "LIBRARY", TRACKS_PER_ALBUM, coverOf(n), 1990);
    await addAlbum(100, "DISCOVER", DISCOVER_TRACKS, DISCOVER_COVER, 1990);
    // Favorites are the listener's own plays (a's): library songs of albums 0-5, and some Discover ones that must never count.
    await prisma.$executeRaw`
        INSERT INTO "Play" (id, "userId", "trackId")
        SELECT ${P + "fav_"} || n || '_' || i, ${P + "a"}, ${P + "trk_"} || n || '_' || lpad(i::text, 3, '0')
        FROM generate_series(0, 5) AS n, generate_series(0, 2) AS i`;
    await prisma.$executeRaw`
        INSERT INTO "Play" (id, "userId", "trackId")
        SELECT ${P + "dfav_"} || i, ${P + "a"}, ${P + "trk_100_"} || lpad(i::text, 3, '0')
        FROM generate_series(0, 29) AS i`;
    // Late Night plays the listener's own plays from after dark (23:30 UTC yesterday, read in UTC): a on album 1, b on album 2.
    const night = new Date();
    night.setUTCDate(night.getUTCDate() - 1);
    night.setUTCHours(23, 30, 0, 0);
    for (const [user, album] of [["a", 1], ["b", 2]] as const) {
        for (let i = 0; i < TRACKS_PER_ALBUM; i++) {
            await prisma.play.create({
                data: { id: `${P}night_${user}_${i}`, userId: `${P}${user}`, trackId: `${P}trk_${album}_00${i}`, playedAt: night, heard: true },
            });
        }
    }
});

afterAll(async () => {
    await cleanup();
});

beforeEach(clearKeys);

describe("POST /radio/covers", () => {
    it("answers every tile type of a page in one request", async () => {
        const stations = [
            { type: "all" },
            { type: "discovery" },
            { type: "favorites" },
            { type: "genre", value: "rcvgenre" },
            { type: "decade", value: "1990" },
            { type: "mood", value: "late-night" },
            { type: "workout" },
        ];
        const res = await covers(`${P}a`, stations, "UTC");
        expect(res.status).toBe(200);
        expect(res.body.covers).toHaveLength(stations.length);
        res.body.covers.forEach((c: { type: string; value: string | null; cover: string | null }, i: number) => {
            expect(c.type).toBe(stations[i].type);
            expect(c.value).toBe((stations[i] as { value?: string }).value ?? null);
        });
        const byType = (type: string) => res.body.covers.find((c: { type: string }) => c.type === type).cover;
        for (const type of ["all", "discovery", "favorites", "genre", "decade"]) {
            expect(byType(type)).toMatch(/^native:cover-\d+$/);
            expect(byType(type)).not.toBe(DISCOVER_COVER);
        }
        expect(byType("mood")).toBe(coverOf(1));
    });

    it("gives the same cover on later requests of the day although the station shuffles", async () => {
        const seen = new Set<string>();
        for (let i = 0; i < 25; i++) {
            const res = await request(appFor(`${P}a`)).get("/radio").query({ type: "all", limit: 5 });
            seen.add(res.body.tracks[0].album.coverArt);
        }
        // The station itself starts on a different album from one call to the next ...
        expect(seen.size).toBeGreaterThan(1);
        // ... but the tile's cover is picked once.
        const stations = [{ type: "all" }, { type: "discovery" }, { type: "genre", value: "rcvgenre" }];
        const first = (await covers(`${P}a`, stations, "UTC")).body.covers;
        for (let i = 0; i < 10; i++) {
            expect((await covers(`${P}a`, stations, "UTC")).body.covers).toEqual(first);
        }
    });

    it("a new local day is a new key, with the seconds left of it", async () => {
        const { localDay } = await import("../../../services/mixes/stationCovers");
        const now = new Date("2026-11-01T22:00:00Z");
        const tokyo = localDay("Asia/Tokyo", now);
        const la = localDay("America/Los_Angeles", now);
        expect(tokyo.day).toBe("2026-11-02");
        expect(la.day).toBe("2026-11-01");
        expect(tokyo.secondsLeft).toBe(17 * 3600);
        expect(localDay("Not/AZone", now).day).toBe("2026-11-01");
    });

    it("keeps a cover until the listener's day ends, and a missing cover only briefly", async () => {
        const { localDay, NO_COVER_SECONDS } = await import("../../../services/mixes/stationCovers");
        await covers(`${P}a`, [{ type: "all" }, { type: "genre", value: "no such genre" }], "UTC");
        const left = localDay("UTC").secondsLeft;
        const [coverKey] = await redisClient.keys("radiocover:rcv_a:*:all:");
        expect(Math.abs((await redisClient.ttl(coverKey)) - left)).toBeLessThanOrEqual(5);
        const [emptyKey] = await redisClient.keys("radiocover:rcv_a:*:genre:no such genre");
        const emptyTtl = await redisClient.ttl(emptyKey);
        expect(emptyTtl).toBeGreaterThan(0);
        expect(emptyTtl).toBeLessThanOrEqual(NO_COVER_SECONDS);
    });

    it("drops the value of a station type that ignores it, so junk values make one pick", async () => {
        const res = await covers(`${P}a`, [{ type: "all", value: "x" }, { type: "all", value: "y" }, { type: "favorites", value: "z" }], "UTC");
        expect(res.status).toBe(200);
        expect(res.body.covers.map((c: { value: string | null }) => c.value)).toEqual([null, null, null]);
        expect(res.body.covers[0].cover).toBe(res.body.covers[1].cover);
        expect(await redisClient.keys("radiocover:rcv_a:*")).toHaveLength(2);
    });

    it("still answers, with computed covers, when Redis fails", async () => {
        const get = jest.spyOn(redisClient, "get").mockRejectedValue(new Error("redis down"));
        const set = jest.spyOn(redisClient, "set").mockRejectedValue(new Error("redis down"));
        try {
            const res = await covers(`${P}a`, [{ type: "all" }, { type: "discovery" }], "UTC");
            expect(res.status).toBe(200);
            for (const c of res.body.covers) expect(c.cover).toMatch(/^native:cover-\d+$/);
        } finally {
            get.mockRestore();
            set.mockRestore();
        }
    });

    it("picks per listener: Late Night follows each listener's own night plays", async () => {
        const late = [{ type: "mood", value: "late-night" }];
        expect((await covers(`${P}a`, late, "UTC")).body.covers[0].cover).toBe(coverOf(1));
        expect((await covers(`${P}b`, late, "UTC")).body.covers[0].cover).toBe(coverOf(2));
    });

    it("gives null, not an error, for a station with no songs or one the server does not know", async () => {
        const res = await covers(`${P}a`, [
            { type: "genre", value: "no such genre" },
            { type: "decade", value: "1850" },
            { type: "mood", value: "not-a-mood" },
        ], "UTC");
        expect(res.status).toBe(200);
        expect(res.body.covers.map((c: { cover: string | null }) => c.cover)).toEqual([null, null, null]);
        // The empty answer is kept too, so the next request reads it.
        expect((await redisClient.keys("radiocover:rcv_a:*:genre:no such genre")).length).toBe(1);
    });

    it("reads an unknown time zone in the server's own zone, as Late Night does", async () => {
        const { nightZone } = await import("../../../services/mixes/nightPlays");
        const bad = await covers(`${P}a`, [{ type: "all" }], "Not/AZone");
        expect(bad.status).toBe(200);
        expect(bad.body.covers[0].cover).toMatch(/^native:cover-\d+$/);
        // Asking in the server's zone by name finds the same day's pick, not a new one.
        const named = await covers(`${P}a`, [{ type: "all" }], await nightZone(undefined));
        expect(named.body.covers[0].cover).toBe(bad.body.covers[0].cover);
        expect(await redisClient.keys("radiocover:rcv_a:*:all:")).toHaveLength(1);
    });

    it("never returns a Discover album's cover", async () => {
        // 60 Discover songs against 36 library ones: a station that let them in would show it in nearly every pick.
        const stations = [{ type: "all" }, { type: "discovery" }, { type: "favorites" }, { type: "genre", value: "rcvgenre" }, { type: "decade", value: "1990" }];
        for (let i = 0; i < 20; i++) {
            const res = await covers(`${P}listener${i}`, stations, "UTC");
            for (const c of res.body.covers) expect(c.cover).not.toBe(DISCOVER_COVER);
        }
    });

    it.each([
        ["no stations list", undefined],
        ["a stations value that is not a list", "all"],
        ["a station type the tiles never use", [{ type: "artist", value: "x" }]],
        ["a station with no type", [{ value: "x" }]],
        ["a value that is not text", [{ type: "genre", value: 5 }]],
        ["a value that is far too long", [{ type: "genre", value: "x".repeat(500) }]],
        ["more than 64 stations", Array.from({ length: 65 }, () => ({ type: "all" }))],
    ])("answers 400 for %s", async (_name, stations) => {
        const res = await covers(`${P}a`, stations, "UTC");
        expect(res.status).toBe(400);
    });

    it("accepts 64 stations", async () => {
        const res = await covers(`${P}a`, Array.from({ length: 64 }, () => ({ type: "all" })), "UTC");
        expect(res.status).toBe(200);
        expect(res.body.covers).toHaveLength(64);
    });
});
