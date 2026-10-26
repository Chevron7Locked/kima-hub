/**
 * Late Night, Midnight Drive and the Late Night station on a real Postgres holding the synthetic library
 * (src/__tests__/fixtures/syntheticLibrary.ts). The fixture's own plays are removed first, so every play here is one
 * this file wrote and every expected list is worked out from them. Time is read in UTC unless a test says otherwise:
 * 23:00 UTC is night there and 08:00 in Tokyo.
 */
import { prisma } from "../../../utils/db";
import { redisClient, waitForRedisReady } from "../../../utils/redis";
import { buildMatching } from "../../matching/state";
import {
    LibraryHandle,
    Row,
    loadRows,
    removeSyntheticLibrary,
    seedSyntheticLibrary,
    seedSyntheticMoods,
} from "../../../__tests__/fixtures/syntheticLibrary";
import { generateLateNightMix, generateMidnightDrive } from "../moodMixes";
import { buildMoodState } from "../../moods/state";
import * as matchingRank from "../../matching/rank";
import { matchingContext } from "../../matching/rank";
import { MIN_MIX_TRACKS, getRecipe, recipeMembers } from "../recipes";
import {
    COLD_START_SONGS,
    ENERGY_BAND_KEY,
    nightMixTracks,
    nightSongs,
    nightStationPool,
    nightZone,
    pickNightStationPage,
} from "../nightPlays";

jest.setTimeout(300_000);

const PREFIX = "nitp_";
let lib: LibraryHandle;
let rows: Row[];
/** Owned, playable songs by distinct artists with distinct titles, in id order: no cap or title merge touches them. */
let songs: string[];

// Plays are dated a few days back from the clock, so they stay inside the lookback whenever the suite runs.
const BASE = new Date();
BASE.setUTCHours(0, 0, 0, 0);
BASE.setUTCDate(BASE.getUTCDate() - 3);
const at = (hh: number, mm = 0) => new Date(BASE.getTime() + (hh * 60 + mm) * 60_000);
const NIGHT = at(23);
const DAY = at(12);

async function play(userId: string, trackId: string, times: number, at = NIGHT, heard = true) {
    await prisma.play.createMany({
        data: Array.from({ length: times }, () => ({ userId, trackId, playedAt: at, heard })),
    });
}
const clearPlays = () => prisma.play.deleteMany({ where: { userId: { startsWith: PREFIX } } });

beforeAll(async () => {
    await waitForRedisReady();
    lib = await seedSyntheticLibrary(PREFIX);
    await seedSyntheticMoods(PREFIX);
    await prisma.$transaction((tx) => buildMoodState(tx));
    rows = await loadRows(PREFIX, lib.user1);
    const seenArtists = new Set<string>();
    const seenTitles = new Set<string>();
    const titles = new Map((await prisma.track.findMany({
        where: { id: { startsWith: PREFIX } }, select: { id: true, title: true },
    })).map((t) => [t.id, t.title.toLowerCase()]));
    songs = rows
        .filter((r) => !r.missingSince && !r.corrupt && r.album.location === "LIBRARY")
        .filter((r) => {
            const title = titles.get(r.id)!;
            if (seenArtists.has(r.album.artistId) || seenTitles.has(title)) return false;
            seenArtists.add(r.album.artistId);
            seenTitles.add(title);
            return true;
        })
        .map((r) => r.id);
    expect(songs.length).toBeGreaterThan(80);
});

afterAll(async () => {
    await removeSyntheticLibrary(PREFIX);
    await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    await prisma.$disconnect();
});

beforeEach(async () => {
    await clearPlays();
    await redisClient.del(ENERGY_BAND_KEY);
});

const spec = { fallbackRecipe: "late-night", ranking: "plays" } as const;
const driveSpec = { fallbackRecipe: "midnight-drive", ranking: "drive" } as const;

const daysOf = async (s: typeof spec | typeof driveSpec, days: number, limit = 20) => {
    const lists: string[][] = [];
    for (let d = 1; d <= days; d++) {
        const day = `2026-04-${String(d).padStart(2, "0")}`;
        lists.push((await nightMixTracks(s, lib.user1, day, "UTC", limit))!);
    }
    return lists;
};

describe("night songs", () => {
    it("are this listener's heard plays between 22:00 and 03:59 in the zone read, and nobody else's", async () => {
        await play(lib.user1, songs[0], 3);
        await play(lib.user1, songs[1], 1, at(3, 59));
        await play(lib.user1, songs[2], 1, at(4));
        await play(lib.user1, songs[3], 2, DAY);
        await play(lib.user1, songs[4], 2, NIGHT, false);
        await play(lib.user2, songs[5], 4);
        const found = await nightSongs(lib.user1, "UTC");
        expect(found.map((s) => [s.id, s.plays])).toEqual([[songs[0], 3], [songs[1], 1]]);
    });

    it("move with the zone: 23:00 UTC is 08:00 in Tokyo and 19:00 in New York, but 00:00 in Lagos", async () => {
        await play(lib.user1, songs[0], 2);
        expect(await nightSongs(lib.user1, "Asia/Tokyo")).toEqual([]);
        expect(await nightSongs(lib.user1, "America/New_York")).toEqual([]);
        expect((await nightSongs(lib.user1, "Africa/Lagos")).map((s) => s.id)).toEqual([songs[0]]);
    });

    it("count a title once across its copies, summing plays and keeping the most played copy", async () => {
        const first = await prisma.track.findUniqueOrThrow({ where: { id: songs[0] } });
        const copy = await prisma.track.findFirstOrThrow({
            where: { albumId: first.albumId, id: { not: first.id }, missingSince: null, corrupt: false },
            orderBy: { id: "asc" },
        });
        const original = copy.title;
        await prisma.track.update({ where: { id: copy.id }, data: { title: first.title.toUpperCase() } });
        try {
            await play(lib.user1, first.id, 2);
            await play(lib.user1, copy.id, 3);
            const found = await nightSongs(lib.user1, "UTC");
            expect(found).toHaveLength(1);
            expect(found[0]).toMatchObject({ id: copy.id, plays: 5 });
        } finally {
            await prisma.track.update({ where: { id: copy.id }, data: { title: original } });
        }
    });
});

describe("the time zone", () => {
    it("is the one sent when it is a real zone, else the server's own", async () => {
        const server = Intl.DateTimeFormat().resolvedOptions().timeZone;
        expect(await nightZone("Asia/Tokyo")).toBe("Asia/Tokyo");
        expect(await nightZone(undefined)).toBe(server);
        expect(await nightZone("Not/AZone")).toBe(server);
        expect(await nightZone("")).toBe(server);
    });
});

describe("Late Night (the mix)", () => {
    it("with enough night songs plays only them, and not another user's or a daytime play", async () => {
        const mine = songs.slice(0, 40);
        for (const [i, id] of mine.entries()) await play(lib.user1, id, 40 - i);
        await play(lib.user1, songs[60], 50, DAY);
        await play(lib.user2, songs[61], 50);
        const picked = (await nightMixTracks(spec, lib.user1, "2026-03-11", "UTC", 25))!;
        expect(picked).toHaveLength(25);
        for (const id of picked) expect(mine).toContain(id);
    });

    it("changes from day to day for a listener with many night songs, and holds for one day", async () => {
        for (const id of songs.slice(0, 40)) await play(lib.user1, id, 2);
        const [one, two] = await daysOf(spec, 2);
        expect(one).not.toEqual(two);
        expect(await nightMixTracks(spec, lib.user1, "2026-04-01", "UTC", 20)).toEqual(one);
    });

    it("plays a much-played song on more days than a once-played one, and still lets every night song in", async () => {
        const mine = songs.slice(0, 40);
        for (const id of mine) await play(lib.user1, id, 1);
        await play(lib.user1, mine[0], 9);
        const lists = await daysOf(spec, 30);
        const days = (id: string) => lists.filter((l) => l.includes(id)).length;
        const others = mine.slice(1).map(days);
        const mean = others.reduce((a, b) => a + b, 0) / others.length;
        expect(days(mine[0])).toBeGreaterThan(mean + 5);
        expect(Math.min(...others)).toBeGreaterThan(0);
    });

    it("gives the same listener the same list for the same day, and another listener a different one", async () => {
        for (const [i, id] of songs.slice(0, 40).entries()) await play(lib.user1, id, 1 + (i % 3));
        for (const [i, id] of songs.slice(40, 80).entries()) await play(lib.user2, id, 1 + (i % 3));
        const a = await nightMixTracks(spec, lib.user1, "2026-03-11", "UTC", 25);
        expect(await nightMixTracks(spec, lib.user1, "2026-03-11", "UTC", 25)).toEqual(a);
        const b = await nightMixTracks(spec, lib.user2, "2026-03-11", "UTC", 25);
        expect(b).not.toEqual(a);
        expect(b!.every((id) => songs.slice(40, 80).includes(id))).toBe(true);
    });

    it("on a cold start with some night songs keeps every one of them, first, and fills up with other songs", async () => {
        const mine = songs.slice(0, 10);
        for (const [i, id] of mine.entries()) await play(lib.user1, id, 10 - i);
        expect(mine.length).toBeLessThan(COLD_START_SONGS);
        const picked = (await nightMixTracks(spec, lib.user1, "2026-03-11", "UTC"))!;
        expect(picked.slice(0, 10)).toEqual(mine);
        expect(picked.length).toBeGreaterThanOrEqual(MIN_MIX_TRACKS);
        expect(new Set(picked).size).toBe(picked.length);
    });

    it("with fewer night songs than a mix needs still returns a full mix, from the fallback recipe's songs", async () => {
        await play(lib.user1, songs[0], 5);
        await play(lib.user1, songs[1], 2);
        const picked = (await nightMixTracks(spec, lib.user1, "2026-03-11", "UTC"))!;
        expect(picked.slice(0, 2)).toEqual([songs[0], songs[1]]);
        expect(picked.length).toBeGreaterThanOrEqual(MIN_MIX_TRACKS);
        // No similarity data in this library, so everything after the listener's own songs is the recipe's draw.
        expect(await matchingContext([songs[0]])).toBeNull();
        const members = new Set((await recipeMembers(getRecipe("late-night"), lib.user1))!.map((m) => m.id));
        const added = picked.slice(2);
        expect(added.length).toBeGreaterThan(0);
        for (const id of added) expect(members.has(id)).toBe(true);
    });

    it("with no night plays and no zone sent is built from the fallback recipe on the server's clock", async () => {
        const picked = (await nightMixTracks(spec, lib.user1, "2026-03-11", undefined))!;
        const members = new Set((await recipeMembers(getRecipe("late-night"), lib.user1))!.map((m) => m.id));
        expect(picked.length).toBeGreaterThanOrEqual(MIN_MIX_TRACKS);
        for (const id of picked) expect(members.has(id)).toBe(true);
    });
});

describe("Midnight Drive", () => {
    it("draws night songs of a better fit (steady middle pace, middle energy) on more days than a worse fit, all at equal plays", async () => {
        const mine = songs.slice(0, 60);
        for (const id of mine) await play(lib.user1, id, 1);
        const found = await nightSongs(lib.user1, "UTC", { energy: true });
        const fit = new Map(found.map((s) => [s.id, s.pace + s.energy]));
        const tiers = [...new Set(fit.values())].sort();
        expect(tiers.length).toBeGreaterThan(1);
        const lists = await daysOf(driveSpec, 30, 20);
        const meanDays = (tier: number) => {
            const ids = mine.filter((id) => fit.get(id) === tier);
            return ids.reduce((sum, id) => sum + lists.filter((l) => l.includes(id)).length, 0) / ids.length;
        };
        expect(meanDays(tiers[tiers.length - 1])).toBeGreaterThan(meanDays(tiers[0]) + 3);
        // A draw, not a filter: asking for every song returns all 60.
        const all = (await nightMixTracks(driveSpec, lib.user1, "2026-04-01", "UTC", 60))!;
        expect([...all].sort()).toEqual([...mine].sort());
    });

    it("reads energy as the middle half of the library's arousal, and only when asked", async () => {
        const mine = songs.slice(0, 60);
        for (const id of mine) await play(lib.user1, id, 1);
        const arousals = (await prisma.$queryRaw<Array<{ arousal: number }>>`
            SELECT t.arousal FROM "Track" t JOIN "Album" a ON a.id = t."albumId"
            WHERE t.id LIKE ${PREFIX + "%"} AND t.arousal IS NOT NULL AND t."missingSince" IS NULL AND t.corrupt = false
              AND a.location = 'LIBRARY'`).map((r) => r.arousal).sort((a, b) => a - b);
        const quantile = (q: number) => {
            const x = q * (arousals.length - 1);
            const lo = Math.floor(x);
            return arousals[lo] + (x - lo) * ((arousals[lo + 1] ?? arousals[lo]) - arousals[lo]);
        };
        const [lo, hi] = [quantile(0.25), quantile(0.75)];
        const arousalOf = new Map((await prisma.track.findMany({ where: { id: { in: mine } }, select: { id: true, arousal: true } }))
            .map((t) => [t.id, t.arousal]));
        const withEnergy = await nightSongs(lib.user1, "UTC", { energy: true });
        expect(withEnergy.length).toBe(60);
        const energies = new Set<number>();
        for (const s of withEnergy) {
            const a = arousalOf.get(s.id);
            const expected = a === null || a === undefined ? 0.5 : a >= lo && a <= hi ? 1 : 0;
            expect(s.energy).toBe(expected);
            energies.add(s.energy);
        }
        expect(energies.has(0) && energies.has(1)).toBe(true);
        expect((await nightSongs(lib.user1, "UTC")).every((s) => s.energy === 0.5)).toBe(true);
    });
});

describe("the tie order between night songs that rank the same", () => {
    // 20 songs by one artist and 15 by others, each played once: every song ranks the same, so the day's seeded order
    // alone chooses, and the artist cap (2) is applied once to that order. The 18 big-artist songs beyond the cap used to
    // sit ahead of every other song on every day, so the same two were always picked.
    let big: string[];
    beforeAll(async () => {
        await prisma.artist.create({ data: { id: `${PREFIX}bigart`, name: "Big Artist", identityKey: `${PREFIX}bigak` } });
        await prisma.album.create({
            data: { id: `${PREFIX}bigalb`, artistId: `${PREFIX}bigart`, rgMbid: `${PREFIX}bigrg`, title: "Big", primaryType: "Album" },
        });
        big = Array.from({ length: 20 }, (_, i) => `${PREFIX}big${String(i).padStart(2, "0")}`);
        await prisma.track.createMany({
            data: big.map((id, i) => ({
                id, albumId: `${PREFIX}bigalb`, title: `Big Song ${i}`, trackNo: i + 1, duration: 200,
                filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
            })),
        });
    });

    it("rotates which of the big artist's songs are picked from day to day, two at a time", async () => {
        for (const id of big) await play(lib.user1, id, 1);
        for (const id of songs.slice(0, 15)) await play(lib.user1, id, 1);
        const seen = new Set<string>();
        for (let day = 1; day <= 10; day++) {
            const picked = (await nightMixTracks(spec, lib.user1, `2026-03-${String(day).padStart(2, "0")}`, "UTC", 25))!;
            const fromBig = picked.filter((id) => big.includes(id));
            expect(fromBig).toHaveLength(2);
            expect(picked.filter((id) => songs.slice(0, 15).includes(id))).toHaveLength(15);
            fromBig.forEach((id) => seen.add(id));
        }
        expect(seen.size).toBeGreaterThan(4);
    });
});

describe("the night mixes as listed on Home", () => {
    it("are Late Night and Midnight Drive, with their own ids, titles, descriptions and colours, from the listener's night songs", async () => {
        for (const [i, id] of songs.slice(0, 40).entries()) await play(lib.user1, id, 1 + (i % 4));
        const late = (await generateLateNightMix(lib.user1, "2026-03-11", "UTC"))!;
        const drive = (await generateMidnightDrive(lib.user1, "2026-03-11", "UTC"))!;
        expect(late).toMatchObject({
            id: "late-night-2026-03-11", type: "late-night", name: "Late Night", description: "The songs you play after dark",
        });
        expect(drive).toMatchObject({
            id: "midnight-drive-2026-03-11", type: "midnight-drive", name: "Midnight Drive",
            description: "Your night songs that keep a steady pace",
        });
        for (const mix of [late, drive]) {
            expect(mix.trackIds.length).toBeGreaterThanOrEqual(MIN_MIX_TRACKS);
            expect(mix.trackCount).toBe(mix.trackIds.length);
            for (const id of mix.trackIds) expect(songs.slice(0, 40)).toContain(id);
        }
    });

    it("are not made when the library has nothing to build from, rather than empty", async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
        try {
            expect(await generateLateNightMix(lib.user1, "2026-03-11", "UTC")).toBeNull();
        } finally {
            await prisma.$transaction((tx) => buildMoodState(tx));
        }
    });
});

describe("the Late Night station", () => {
    it("holds the night songs played twice or more when 30 or more were, and all of them otherwise", async () => {
        for (const id of songs.slice(0, 35)) await play(lib.user1, id, 2);
        for (const id of songs.slice(35, 50)) await play(lib.user1, id, 1);
        const pool = await nightStationPool(lib.user1, "UTC", "late-night");
        expect(pool.map((s) => s.id).sort()).toEqual(songs.slice(0, 35).sort());

        await clearPlays();
        for (const id of songs.slice(0, 20)) await play(lib.user1, id, 2);
        for (const id of songs.slice(20, 35)) await play(lib.user1, id, 1);
        const all = await nightStationPool(lib.user1, "UTC", "late-night");
        expect(all.map((s) => s.id).sort()).toEqual(expect.arrayContaining(songs.slice(0, 35).sort()));
    });

    it("keeps a cold start's own songs and fills it to a full page, with no repeats", async () => {
        for (const id of songs.slice(0, 5)) await play(lib.user1, id, 3);
        const pool = await nightStationPool(lib.user1, "UTC", "late-night");
        expect(pool.slice(0, 5).map((s) => s.id).sort()).toEqual(songs.slice(0, 5).sort());
        expect(pool.length).toBeGreaterThanOrEqual(MIN_MIX_TRACKS);
        expect(new Set(pool.map((s) => s.id)).size).toBe(pool.length);
    });

    it("with no listener plays the fallback recipe's songs, and a refill returns tracks", async () => {
        const members = (await recipeMembers(getRecipe("late-night")))!.map((m) => m.id).sort();
        expect((await nightStationPool(undefined, "UTC", "late-night")).map((s) => s.id).sort()).toEqual(members);
        const page = await pickNightStationPage("late-night", "UTC", { limit: 20, seed: "s1", listener: lib.user1 });
        expect(page.trackIds).toHaveLength(20);
    });

    it("plays only a listener's night songs when 30 or more and not another's", async () => {
        for (const id of songs.slice(0, 40)) await play(lib.user1, id, 2);
        for (const id of songs.slice(40, 80)) await play(lib.user2, id, 5);
        const page = await pickNightStationPage("late-night", "UTC", { limit: 40, seed: "s2", listener: lib.user1 });
        expect([...page.trackIds].sort()).toEqual(songs.slice(0, 40).sort());
    });
});

describe("night plays older than a year, and the clock around local midnight and a change of clocks", () => {
    const day = (iso: string) => new Date(iso);

    it("ignore plays older than the lookback and count those inside it", async () => {
        const now = new Date("2026-06-01T12:00:00Z");
        await play(lib.user1, songs[0], 2, day("2025-05-20T23:00:00Z"));
        await play(lib.user1, songs[1], 2, day("2025-06-02T23:00:00Z"));
        expect((await nightSongs(lib.user1, "UTC", { now })).map((s) => s.id)).toEqual([songs[1]]);
    });

    it("read the night in the listener's zone across local midnight (Tokyo is UTC+9)", async () => {
        const now = new Date("2026-06-01T12:00:00Z");
        // Local: 21:59 (out), 22:00 (in), 23:30 (in), 00:30 the next day (in), 03:59 (in), 04:00 (out).
        const plays: Array<[string, number]> = [
            ["2026-05-20T12:59:00Z", 0], ["2026-05-20T13:00:00Z", 1], ["2026-05-20T14:30:00Z", 2],
            ["2026-05-20T15:30:00Z", 3], ["2026-05-20T18:59:00Z", 4], ["2026-05-20T19:00:00Z", 5],
        ];
        for (const [iso, i] of plays) await play(lib.user1, songs[i], 1, day(iso));
        const found = (await nightSongs(lib.user1, "Asia/Tokyo", { now })).map((s) => s.id).sort();
        expect(found).toEqual([songs[1], songs[2], songs[3], songs[4]].sort());
    });

    it("keep the same local hours on the day the clocks go forward (New York, 8 March 2026: 02:00 EST becomes 03:00 EDT)", async () => {
        const now = new Date("2026-06-01T12:00:00Z");
        // Local: 01:30 EST (in, 06:30Z), 03:30 EDT (in, 07:30Z), 04:00 EDT (out, 08:00Z), 21:59 EDT (out, 01:59Z next
        // day), 22:00 EDT (in, 02:00Z next day).
        const plays: Array<[string, number]> = [
            ["2026-03-08T06:30:00Z", 0], ["2026-03-08T07:30:00Z", 1], ["2026-03-08T08:00:00Z", 2],
            ["2026-03-09T01:59:00Z", 3], ["2026-03-09T02:00:00Z", 4],
        ];
        for (const [iso, i] of plays) await play(lib.user1, songs[i], 1, day(iso));
        const found = (await nightSongs(lib.user1, "America/New_York", { now })).map((s) => s.id).sort();
        expect(found).toEqual([songs[0], songs[1], songs[4]].sort());
    });
});

describe("the energy band", () => {
    it("is read from the database once and then kept in Redis, and not at all for a listener with no night songs", async () => {
        const queries = jest.spyOn(prisma, "$queryRaw");
        expect(await nightSongs(lib.user1, "UTC", { energy: true })).toEqual([]);
        expect(queries).toHaveBeenCalledTimes(1);
        expect(await redisClient.exists(ENERGY_BAND_KEY)).toBe(0);

        for (const id of songs.slice(0, 20)) await play(lib.user1, id, 1);
        queries.mockClear();
        const first = await nightSongs(lib.user1, "UTC", { energy: true });
        expect(queries).toHaveBeenCalledTimes(2);
        expect(await redisClient.ttl(ENERGY_BAND_KEY)).toBeGreaterThan(60);

        queries.mockClear();
        expect(await nightSongs(lib.user1, "UTC", { energy: true })).toEqual(first);
        expect(queries).toHaveBeenCalledTimes(1);

        // The kept band is the one read: one that no song's arousal is inside makes every song with a reading low energy.
        await redisClient.setex(ENERGY_BAND_KEY, 600, JSON.stringify({ band: [-9, -8] }));
        const outside = await nightSongs(lib.user1, "UTC", { energy: true });
        expect(outside.every((s) => s.energy !== 1)).toBe(true);
        expect(first.some((s) => s.energy === 1)).toBe(true);
    });

    it("is not asked for by a listener who does not need energy", async () => {
        for (const id of songs.slice(0, 5)) await play(lib.user1, id, 1);
        await nightSongs(lib.user1, "UTC");
        expect(await redisClient.exists(ENERGY_BAND_KEY)).toBe(0);
    });
});

describe("a night mix with 30 or more songs from a few artists", () => {
    // 30 night songs by 3 artists: the artist cap (2, relaxed to 3 to reach the 8-song minimum) leaves 9, short of the 20
    // asked for. The mix is filled with songs that sound like the listener's own, as a cold start is.
    const FEW = Array.from({ length: 3 }, (_, a) => ({
        artist: `${PREFIX}fewart${a}`,
        album: `${PREFIX}fewalb${a}`,
        tracks: Array.from({ length: 10 }, (_, i) => `${PREFIX}few${a}_${String(i).padStart(2, "0")}`),
    }));
    const own = FEW.flatMap((f) => f.tracks);

    beforeAll(async () => {
        for (const [a, f] of FEW.entries()) {
            await prisma.artist.create({ data: { id: f.artist, name: `Few ${a}`, identityKey: `${PREFIX}fewak${a}` } });
            await prisma.album.create({
                data: { id: f.album, artistId: f.artist, rgMbid: `${PREFIX}fewrg${a}`, title: `Few ${a}`, primaryType: "Album" },
            });
            await prisma.track.createMany({
                data: f.tracks.map((id, i) => ({
                    id, albumId: f.album, title: `Few Song ${a}-${i}`, trackNo: i + 1, duration: 200,
                    filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
                })),
            });
        }
        await prisma.$executeRaw`
            INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
            SELECT n.id, e.embedding, e.model_version, e.analyzed_at
            FROM unnest(${own}::text[]) WITH ORDINALITY AS n(id, ord)
            JOIN track_embeddings e ON e.track_id = ${songs[0]}`;
        await prisma.$executeRaw`DELETE FROM matching_state`;
        await buildMatching();
    });
    afterAll(async () => {
        await prisma.$executeRaw`DELETE FROM matching_state`;
        await prisma.$executeRaw`DELETE FROM track_embeddings WHERE track_id = ANY(${own}::text[])`;
    });

    it("is filled to the limit with similar songs, in both mixes", async () => {
        for (const id of own) await play(lib.user1, id, 2);
        for (const s of [spec, driveSpec]) {
            const picked = (await nightMixTracks(s, lib.user1, "2026-04-02", "UTC", 20))!;
            expect(picked).toHaveLength(20);
            expect(new Set(picked).size).toBe(20);
            expect(picked.filter((id) => own.includes(id)).length).toBeLessThanOrEqual(9);
            expect(picked.filter((id) => own.includes(id)).length).toBeGreaterThanOrEqual(6);
        }
    });

    it("is filled to the limit for a listener whose night songs are all by one artist, with that artist's own share kept", async () => {
        await prisma.play.deleteMany({ where: { userId: lib.user1 } });
        for (const id of FEW[0].tracks) await play(lib.user1, id, 5);
        for (const s of [spec, driveSpec]) {
            const picked = (await nightMixTracks(s, lib.user1, "2026-04-03", "UTC", 20))!;
            expect(picked).toHaveLength(20);
            expect(new Set(picked).size).toBe(20);
            const byArtist = picked.filter((id) => FEW[0].tracks.includes(id)).length;
            expect(byArtist).toBeGreaterThanOrEqual(2);
            expect(byArtist).toBeLessThanOrEqual(3);
        }
    });

    it("still answers when the similar-song search fails, from the fallback recipe", async () => {
        await prisma.play.deleteMany({ where: { userId: lib.user1 } });
        for (const id of FEW[0].tracks) await play(lib.user1, id, 5);
        const spy = jest.spyOn(matchingRank, "rankMatches").mockRejectedValue(new Error("database dropped"));
        try {
            const picked = await nightMixTracks(spec, lib.user1, "2026-04-04", "UTC", 20);
            expect(spy).toHaveBeenCalled();
            expect(picked === null || picked.length >= MIN_MIX_TRACKS).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });
});
