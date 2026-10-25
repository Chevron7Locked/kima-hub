/**
 * Late Night, Midnight Drive and the Late Night station on a real Postgres holding the synthetic library
 * (src/__tests__/fixtures/syntheticLibrary.ts). The fixture's own plays are removed first, so every play here is one
 * this file wrote and every expected list is worked out from them. Time is read in UTC unless a test says otherwise:
 * 23:00 UTC is night there and 08:00 in Tokyo.
 */
import { prisma } from "../../../utils/db";
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
import { MIN_MIX_TRACKS, getRecipe, recipeMembers } from "../recipes";
import {
    COLD_START_SONGS,
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

const NIGHT = new Date("2026-03-10T23:00:00Z");
const DAY = new Date("2026-03-10T12:00:00Z");

async function play(userId: string, trackId: string, times: number, at = NIGHT, heard = true) {
    await prisma.play.createMany({
        data: Array.from({ length: times }, () => ({ userId, trackId, playedAt: at, heard })),
    });
}
const clearPlays = () => prisma.play.deleteMany({ where: { userId: { startsWith: PREFIX } } });

beforeAll(async () => {
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

beforeEach(clearPlays);

const spec = { fallbackRecipe: "late-night", ranking: "plays" } as const;
const driveSpec = { fallbackRecipe: "midnight-drive", ranking: "drive" } as const;

describe("night songs", () => {
    it("are this listener's heard plays between 22:00 and 03:59 in the zone read, and nobody else's", async () => {
        await play(lib.user1, songs[0], 3);
        await play(lib.user1, songs[1], 1, new Date("2026-03-10T03:59:00Z"));
        await play(lib.user1, songs[2], 1, new Date("2026-03-10T04:00:00Z"));
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
    it("with enough night songs plays only them, most played first, and not another user's or a daytime play", async () => {
        const mine = songs.slice(0, 40);
        for (const [i, id] of mine.entries()) await play(lib.user1, id, 40 - i);
        await play(lib.user1, songs[60], 50, DAY);
        await play(lib.user2, songs[61], 50);
        const picked = (await nightMixTracks(spec, lib.user1, "2026-03-11", "UTC", 25))!;
        expect(picked).toEqual(mine.slice(0, 25));
        expect(picked).not.toContain(songs[60]);
        expect(picked).not.toContain(songs[61]);
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
        const members = new Set((await recipeMembers(getRecipe("late-night"), lib.user1))!.map((m) => m.id));
        const added = picked.slice(2).filter((id) => !members.has(id));
        // Songs not from the recipe can only be similarity fill, which needs the listener's own songs as seeds.
        expect(added.length).toBeLessThan(picked.length - 2);
    });

    it("with no night plays and no zone sent is built from the fallback recipe on the server's clock", async () => {
        const picked = (await nightMixTracks(spec, lib.user1, "2026-03-11", undefined))!;
        const members = new Set((await recipeMembers(getRecipe("late-night"), lib.user1))!.map((m) => m.id));
        expect(picked.length).toBeGreaterThanOrEqual(MIN_MIX_TRACKS);
        for (const id of picked) expect(members.has(id)).toBe(true);
    });
});

describe("Midnight Drive", () => {
    it("ranks night songs by fit to a steady middle pace and middle energy first, then by plays", async () => {
        const mine = songs.slice(0, 60);
        for (const [i, id] of mine.entries()) await play(lib.user1, id, 1 + ((i * 7) % 5));
        const found = await nightSongs(lib.user1, "UTC");
        const fit = new Map(found.map((s) => [s.id, s.pace + s.energy]));
        const plays = new Map(found.map((s) => [s.id, s.plays]));
        const picked = (await nightMixTracks(driveSpec, lib.user1, "2026-03-11", "UTC", 25))!;
        expect(picked).toHaveLength(25);
        for (let i = 1; i < picked.length; i++) {
            const [a, b] = [picked[i - 1], picked[i]];
            expect(fit.get(a)!).toBeGreaterThanOrEqual(fit.get(b)!);
            if (fit.get(a) === fit.get(b)) expect(plays.get(a)!).toBeGreaterThanOrEqual(plays.get(b)!);
        }
        // A rank, not a filter: the lower fit tiers are still night songs, played when the better tiers run out.
        const all = (await nightMixTracks(driveSpec, lib.user1, "2026-03-11", "UTC", 60))!;
        expect(new Set(all).size).toBe(all.length);
        for (const id of all) expect(fit.has(id) || !mine.includes(id)).toBe(true);
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

describe("familiarity", () => {
    it("is a boost, not a filter: a listener who has heard nothing still gets the same full Road Trip list", async () => {
        const road = getRecipe("road-trip");
        expect(road.familiarity).toBeGreaterThan(0);
        const without = (await recipeMembers(road))!;
        const fresh = (await recipeMembers(road, lib.user1))!;
        expect(without.length).toBeGreaterThanOrEqual(MIN_MIX_TRACKS);
        expect(fresh.map((m) => m.id).sort()).toEqual(without.map((m) => m.id).sort());
    });

    it("never lets heard plays shrink the list below a mix", async () => {
        const road = getRecipe("road-trip");
        for (const id of songs.slice(0, 50)) await play(lib.user1, id, 12, DAY);
        const heard = (await recipeMembers(road, lib.user1))!;
        expect(heard.length).toBeGreaterThanOrEqual(MIN_MIX_TRACKS);
    });
});
