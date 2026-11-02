/**
 * GET /radio/row gives a page its radio stations and each one's cover in one reply, so the tiles draw once with their
 * covers. The server decides which stations exist. A station shuffles, so the cover is each listener's pick for the
 * local day, kept in Redis; a Discover album's cover is never one. Real router, real test database and Redis.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { redisClient } from "../../../utils/redis";
import router from "../tracks";
import { featureDetection } from "../../../services/featureDetection";
import { warmRadioCovers } from "../../../services/mixes/radioRow";
import * as stationSelection from "../../../services/mixes/stationSelection";

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

type RowStation = { type: string; value: string | null; name?: string; description?: string; count?: number; cover: string | null };
const row = (userId: string, query: Record<string, string> = {}) =>
    request(appFor(userId)).get("/radio/row").query({ scope: "home", tz: "UTC", ...query });
const stationsOf = async (userId: string, query: Record<string, string> = {}): Promise<RowStation[]> => {
    const res = await row(userId, query);
    expect(res.status).toBe(200);
    return res.body.stations;
};
const coverOfStation = (stations: RowStation[], type: string, value: string | null = null) =>
    stations.find((s) => s.type === type && s.value === value)!.cover;

function vibe(on: boolean) {
    return jest.spyOn(featureDetection, "getFeatures").mockResolvedValue({ musicCNN: on, vibeEmbeddings: on, audiobookshelfEnabled: false, fpcalc: true });
}

async function clearKeys() {
    const keys = [...(await redisClient.keys("radiocover:rcv_*")), ...(await redisClient.keys("radiocover:*:rcv_*"))];
    if (keys.length) await redisClient.del(...keys);
}

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

async function addAlbum(n: number, location: "LIBRARY" | "DISCOVER", tracks: number, cover: string, year: number, genre = "rcvgenre") {
    await prisma.artist.create({
        data: { id: `${P}art_${n}`, name: `Cover Artist ${n}`, normalizedName: `cover artist ${n}`, identityKey: `${P}ak${n}`, genres: [genre] },
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
    // Seven more genres and decades of 15 songs each, past the home row's six genres and four decades.
    for (let n = 0; n < 7; n++) await addAlbum(200 + n, "LIBRARY", 15, coverOf(200 + n), 1920 + n * 10, `rcvextra${n}`);
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

afterEach(() => jest.restoreAllMocks());

describe("GET /radio/row", () => {
    it("lists the home row's stations in order, each with its cover, in one reply", async () => {
        vibe(true);
        const stations = await stationsOf(`${P}a`);
        const types = stations.map((s) => s.type);
        expect(types.slice(0, 4)).toEqual(["all", "workout", "discovery", "favorites"]);
        const moods = stations.filter((s) => s.type === "mood");
        expect(moods.length).toBeGreaterThan(0);
        for (const m of moods) expect(m.name && m.description).toBeTruthy();
        // Six genres and four decades at most on home, biggest genres and newest decades first.
        const genres = stations.filter((s) => s.type === "genre");
        const decades = stations.filter((s) => s.type === "decade");
        expect(genres).toHaveLength(6);
        expect(genres[0]).toMatchObject({ value: "rcvgenre", count: LIBRARY_ALBUMS * TRACKS_PER_ALBUM });
        expect(decades.map((d) => d.value)).toEqual(["1990", "1980", "1970", "1960"]);
        expect(types.indexOf("mood")).toBeGreaterThan(types.indexOf("favorites"));
        expect(types.indexOf("genre")).toBeGreaterThan(types.lastIndexOf("mood"));
        expect(types.indexOf("decade")).toBeGreaterThan(types.lastIndexOf("genre"));
        for (const type of ["all", "discovery", "favorites"]) expect(coverOfStation(stations, type)).toMatch(/^native:cover-\d+$/);
        expect(coverOfStation(stations, "genre", "rcvgenre")).toMatch(/^native:cover-\d+$/);
        expect(coverOfStation(stations, "decade", "1990")).toMatch(/^native:cover-\d+$/);
        expect(coverOfStation(stations, "mood", "late-night")).toBe(coverOf(1));
    });

    it("lists every genre and decade for the radio page", async () => {
        vibe(true);
        const stations = await stationsOf(`${P}a`, { scope: "all" });
        expect(stations.filter((s) => s.type === "genre")).toHaveLength(8);
        expect(stations.filter((s) => s.type === "decade").map((d) => d.value)).toEqual(["1990", "1980", "1970", "1960", "1950", "1940", "1930", "1920"]);
    });

    it("leaves out Workout and the mood stations where the vibe analyzer does not run", async () => {
        vibe(false);
        const types = (await stationsOf(`${P}a`)).map((s) => s.type);
        expect(types).not.toContain("workout");
        expect(types).not.toContain("mood");
        expect(types.slice(0, 3)).toEqual(["all", "discovery", "favorites"]);
    });

    it("answers 400 for a scope it does not know", async () => {
        expect((await row(`${P}a`, { scope: "everything" })).status).toBe(400);
    });

    it("gives the same cover on later requests of the day although the station shuffles", async () => {
        vibe(true);
        const seen = new Set<string>();
        for (let i = 0; i < 25; i++) {
            const res = await request(appFor(`${P}a`)).get("/radio").query({ type: "all", limit: 5 });
            seen.add(res.body.tracks[0].album.coverArt);
        }
        // The station itself starts on a different album from one call to the next ...
        expect(seen.size).toBeGreaterThan(1);
        // ... but the tile's cover is picked once.
        const first = await stationsOf(`${P}a`);
        for (let i = 0; i < 5; i++) expect(await stationsOf(`${P}a`)).toEqual(first);
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
        const { localDay, NO_COVER_SECONDS, stationCovers } = await import("../../../services/mixes/stationCovers");
        await stationCovers([{ type: "all" }, { type: "genre", value: "no such genre" }], `${P}a`, "UTC");
        const left = localDay("UTC").secondsLeft;
        const [coverKey] = await redisClient.keys("radiocover:rcv_a:*:all:");
        expect(Math.abs((await redisClient.ttl(coverKey)) - left)).toBeLessThanOrEqual(5);
        const [emptyKey] = await redisClient.keys("radiocover:rcv_a:*:genre:no such genre");
        const emptyTtl = await redisClient.ttl(emptyKey);
        expect(emptyTtl).toBeGreaterThan(0);
        expect(emptyTtl).toBeLessThanOrEqual(NO_COVER_SECONDS);
    });

    it("still answers, with computed covers, when Redis fails", async () => {
        vibe(true);
        jest.spyOn(redisClient, "get").mockRejectedValue(new Error("redis down"));
        jest.spyOn(redisClient, "set").mockRejectedValue(new Error("redis down"));
        const stations = await stationsOf(`${P}a`);
        expect(coverOfStation(stations, "all")).toMatch(/^native:cover-\d+$/);
        expect(coverOfStation(stations, "discovery")).toMatch(/^native:cover-\d+$/);
    });

    it("picks per listener: Late Night follows each listener's own night plays", async () => {
        vibe(true);
        expect(coverOfStation(await stationsOf(`${P}a`), "mood", "late-night")).toBe(coverOf(1));
        expect(coverOfStation(await stationsOf(`${P}b`), "mood", "late-night")).toBe(coverOf(2));
    });

    it("gives null, not an error, for a station with no songs or one the server does not know", async () => {
        const { stationCovers } = await import("../../../services/mixes/stationCovers");
        const covers = await stationCovers([
            { type: "genre", value: "no such genre" },
            { type: "decade", value: "1850" },
            { type: "mood", value: "not-a-mood" },
        ], `${P}a`, "UTC");
        expect(covers).toEqual([null, null, null]);
        // The empty answer is kept too, so the next request reads it.
        expect((await redisClient.keys("radiocover:rcv_a:*:genre:no such genre")).length).toBe(1);
    });

    it("reads an unknown time zone in the server's own zone, as Late Night does", async () => {
        vibe(false);
        const { nightZone } = await import("../../../services/mixes/nightPlays");
        const bad = await stationsOf(`${P}a`, { tz: "Not/AZone" });
        expect(coverOfStation(bad, "all")).toMatch(/^native:cover-\d+$/);
        // Asking in the server's zone by name finds the same day's pick, not a new one.
        const named = await stationsOf(`${P}a`, { tz: await nightZone(undefined) });
        expect(coverOfStation(named, "all")).toBe(coverOfStation(bad, "all"));
        expect(await redisClient.keys("radiocover:rcv_a:*:all:")).toHaveLength(1);
    });

    it("never returns a Discover album's cover", async () => {
        vibe(false);
        // 60 Discover songs against the library's own: a station that let them in would show it in nearly every pick.
        for (let i = 0; i < 10; i++) {
            for (const s of await stationsOf(`${P}listener${i}`)) expect(s.cover).not.toBe(DISCOVER_COVER);
        }
    });
});

describe("the day's covers are picked before the listener asks", () => {
    it("a listener's first row of the day reads covers picked ahead, in the zone they last asked from", async () => {
        vibe(true);
        // The first request records the listener's zone.
        await stationsOf(`${P}a`, { tz: "Asia/Tokyo" });
        await clearKeys();
        await stationsOf(`${P}a`, { tz: "Asia/Tokyo" });
        const picks = await redisClient.keys("radiocover:rcv_a:*");
        await redisClient.del(...picks);
        await warmRadioCovers();
        expect((await redisClient.keys("radiocover:rcv_a:*")).length).toBeGreaterThanOrEqual(picks.length);
        const select = jest.spyOn(stationSelection, "selectRadioTracks");
        await stationsOf(`${P}a`, { tz: "Asia/Tokyo" });
        expect(select).not.toHaveBeenCalled();
    });

    it("forgets a listener who no longer exists", async () => {
        await redisClient.set("radiocover:tz:rcv_gone", "UTC");
        await warmRadioCovers();
        expect(await redisClient.exists("radiocover:tz:rcv_gone")).toBe(0);
    });

    it("picks once per listener per day", async () => {
        vibe(false);
        await stationsOf(`${P}b`, { tz: "UTC" });
        await warmRadioCovers();
        const select = jest.spyOn(stationSelection, "selectRadioTracks");
        await warmRadioCovers();
        expect(select).not.toHaveBeenCalled();
    });
});
