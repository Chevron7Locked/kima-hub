/**
 * getMoodMix draws evenly from every member of the mood page's recipe (Calm: the calm page recipe), at most 2 songs
 * per artist, skips what this user was already served while enough others remain, and stores what it served on
 * UserMoodMix so the next mix can skip it. On the 3,000-track synthetic library with learned moods.
 */

const mockStore = new Map<string, string>();
jest.mock("../../utils/redis", () => require("./helpers/memoryRedis").memoryRedisMock(mockStore));

import { prisma } from "../../utils/db";
import { moodBucketService, MoodType } from "../moodBucketService";
import { buildMoodState } from "../moods/state";
import { MIN_MIX_TRACKS } from "../mixes/artistCap";
import { pickRecipeStation } from "../../__tests__/helpers/stationPicks";
import { untilLockWait } from "../../__tests__/helpers/lockWait";
import {
    removeSyntheticLibrary,
    seedSyntheticLibrary,
    seedSyntheticMoods,
} from "../../__tests__/fixtures/syntheticLibrary";

jest.setTimeout(300_000);

const PREFIX = "mmp_";

/** Every member of each mood page's recipe. */
const members = new Map<MoodType, Set<string>>();
const artistOf = new Map<string, string>();

const drawIds = async (mood: MoodType, draws: number, exclude?: string[]) => {
    const union = new Set<string>();
    for (let d = 0; d < draws; d++) {
        const mix = await moodBucketService.getMoodMix(mood, 15, exclude);
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(15);
        expect(new Set(mix!.trackIds).size).toBe(15);
        const perArtist = new Map<string, number>();
        for (const id of mix!.trackIds) perArtist.set(artistOf.get(id)!, (perArtist.get(artistOf.get(id)!) ?? 0) + 1);
        expect(Math.max(...perArtist.values())).toBeLessThanOrEqual(2);
        for (const id of mix!.trackIds) union.add(id);
    }
    return union;
};

/** The i-th member of the Calm page's recipe. */
const m = (i: number) => [...members.get("chill")!][i];

describe("getMoodMix draws from the mood page's recipe (database)", () => {
    beforeAll(async () => {
        await seedSyntheticLibrary(PREFIX);
        await seedSyntheticMoods(PREFIX);
        await prisma.$transaction((tx) => buildMoodState(tx));
        for (const [mood, recipe] of [["chill", "calm"], ["party", "energetic"], ["happy", "upbeat"], ["sad", "melancholy"], ["aggressive", "intense"]] as const) {
            members.set(mood, new Set(await pickRecipeStation(recipe, { limit: 100_000 })));
        }
        const tracks = await prisma.track.findMany({
            where: { id: { startsWith: PREFIX } },
            select: { id: true, album: { select: { artistId: true } } },
        });
        for (const t of tracks) artistOf.set(t.id, t.album.artistId);
    });

    // The worker DB is shared by every suite in this Jest worker: remove our rows.
    afterAll(async () => {
        await prisma.userMoodMix.deleteMany({ where: { userId: { startsWith: "mmp_user" } } });
        await prisma.userMoodMemory.deleteMany({ where: { userId: { startsWith: "mmp_user" } } });
        await removeSyntheticLibrary(PREFIX);
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
        await prisma.$disconnect();
    });

    it.each(["happy", "sad", "chill", "aggressive", "party"] as const)(
        "%s: draws only the page recipe's members, reaching nearly all of them",
        async (mood) => {
            const want = members.get(mood)!;
            expect(want.size).toBeGreaterThan(100);
            // Draws of 15 adding up to four times the members: each is missed with probability about e^-4 (2%).
            const union = await drawIds(mood, Math.ceil((want.size * 4) / 15));
            expect([...union].filter((id) => !want.has(id))).toEqual([]);
            expect(union.size).toBeGreaterThan(want.size * 0.9);
        },
    );

    it("excludes previously served ids from the next mix", async () => {
        const excluded = [...members.get("chill")!].slice(0, 100);
        const union = await drawIds("chill", 10, excluded);
        for (const id of union) expect(excluded).not.toContain(id);
    });

    it("brings the oldest served songs back when exclusions leave too few, and keeps the newest skipped", async () => {
        const excluded = [...members.get("chill")!];
        const mix = await moodBucketService.getMoodMix("chill", 15, excluded);
        // A thin mix would be worse than repeating: the oldest MIN_MIX_TRACKS come back rather than returning null.
        expect(mix).not.toBeNull();
        expect(mix!.trackIds.length).toBeGreaterThan(0);
        expect(mix!.trackIds.length).toBeLessThanOrEqual(MIN_MIX_TRACKS);
        for (const id of mix!.trackIds) expect(excluded.slice(0, MIN_MIX_TRACKS)).toContain(id);
        // Each album's cover once.
        expect(mix!.coverUrls.length).toBeGreaterThan(0);
        expect(new Set(mix!.coverUrls).size).toBe(mix!.coverUrls.length);
    });

    it("shows each preset's count as the songs its page plays", async () => {
        const presets = await moodBucketService.getMoodPresets();
        for (const preset of presets) {
            expect(preset.trackCount).toBe(members.get(preset.id as MoodType)!.size);
        }

        // A page recipe the library cannot rank plays nothing, and counts nothing.
        const { happy_sd } = await prisma.moodState.findUniqueOrThrow({ where: { id: "default" } });
        await prisma.moodState.update({ where: { id: "default" }, data: { happy_sd: 0 } });
        try {
            const unranked = await moodBucketService.getMoodPresets();
            expect(unranked.find((p) => p.id === "happy")!.trackCount).toBe(0);
            expect(unranked.find((p) => p.id === "chill")!.trackCount).toBe(members.get("chill")!.size);
        } finally {
            await prisma.moodState.update({ where: { id: "default" }, data: { happy_sd } });
        }
    });

    it("names the mix after the mood and has no mix before the mood step has built the library's statistics", async () => {
        const mix = await moodBucketService.getMoodMix("chill", 15);
        expect(mix).toMatchObject({ mood: "chill", name: "Calm Mix", description: "Tracks that match your calm vibe" });
        expect(mix!.id).toMatch(/^mood-chill-\d+$/);
        const state = await prisma.moodState.findUniqueOrThrow({ where: { id: "default" } });
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
        try {
            expect(await moodBucketService.getMoodMix("chill", 15)).toBeNull();
        } finally {
            await prisma.moodState.create({ data: state });
        }
    });

    it("has no mix when the library cannot rank the page's recipe", async () => {
        // No spread in the happy scores: the Upbeat page's recipe cannot rank anyone.
        const { happy_sd } = await prisma.moodState.findUniqueOrThrow({ where: { id: "default" } });
        await prisma.moodState.update({ where: { id: "default" }, data: { happy_sd: 0 } });
        try {
            expect(await moodBucketService.getMoodMix("happy", 15)).toBeNull();
            expect(await moodBucketService.saveUserMoodMix("mmp_user_unranked", "happy", 15)).toBeNull();
            // The Calm page's recipe does not use happy.
            expect(await moodBucketService.getMoodMix("chill", 15)).not.toBeNull();
        } finally {
            await prisma.moodState.update({ where: { id: "default" }, data: { happy_sd } });
        }
    });

    it("persists the served track ids alongside the saved mix", async () => {
        const userId = "mmp_user_save";
        await prisma.user.create({
            data: { id: userId, username: "mmp-save", passwordHash: "x" },
        });
        const saved = await moodBucketService.saveUserMoodMix(userId, "chill", 15, [
            m(0), m(1), m(2),
        ]);
        expect(saved).not.toBeNull();

        const row = await prisma.userMoodMix.findUnique({ where: { userId } });
        expect(row!.trackIds).toEqual([m(0), m(1), m(2)]);
        // What the user was given is remembered for that mood, next to the saved mix itself.
        const memory = await prisma.userMoodMemory.findUnique({ where: { userId_mood: { userId, mood: "chill" } } });
        expect(memory!.servedTrackIds).toEqual([m(0), m(1), m(2)]);
    });

    it("keeps what each mood served when a mix for a different mood is saved", async () => {
        const userId = "mmp_user_two_moods";
        await prisma.user.create({ data: { id: userId, username: "mmp-two", passwordHash: "x" } });
        const party = (i: number) => [...members.get("party")!][i];
        await moodBucketService.saveUserMoodMix(userId, "chill", 15, [m(0), m(1)]);
        await moodBucketService.recordServedTracks(userId, "chill", [m(2)]);

        await moodBucketService.saveUserMoodMix(userId, "party", 15, [party(0)]);

        // The saved mix is the party one now, and chill still remembers everything it gave.
        expect((await prisma.userMoodMix.findUniqueOrThrow({ where: { userId } })).mood).toBe("party");
        expect(new Set(await moodBucketService.getRememberedTrackIds(userId, "chill"))).toEqual(new Set([m(0), m(1), m(2)]));
        expect(new Set(await moodBucketService.getRememberedTrackIds(userId, "party"))).toEqual(new Set([party(0)]));
    });

    it("serves a mix that skips what the mood remembered and remembers it, in one step", async () => {
        const userId = "mmp_user_serve_mix";
        await prisma.user.create({ data: { id: userId, username: "mmp-serve-mix", passwordHash: "x" } });

        const first = await moodBucketService.serveMoodMix(userId, "chill", 15);
        const second = await moodBucketService.serveMoodMix(userId, "chill", 15);

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(second!.trackIds.filter((id) => first!.trackIds.includes(id))).toEqual([]);
        expect(new Set(await moodBucketService.getRememberedTrackIds(userId, "chill"))).toEqual(
            new Set([...first!.trackIds, ...second!.trackIds]),
        );
    });

    it("two servings at once draw different mixes, because the second waits for the first to be remembered", async () => {
        const userId = "mmp_user_simultaneous";
        await prisma.user.create({ data: { id: userId, username: "mmp-simul", passwordHash: "x" } });

        const [a, b] = await Promise.all([
            moodBucketService.serveMoodMix(userId, "chill", 15),
            moodBucketService.serveMoodMix(userId, "chill", 15),
        ]);

        expect(a!.trackIds).toHaveLength(15);
        expect(b!.trackIds).toHaveLength(15);
        expect(b!.trackIds.filter((id) => a!.trackIds.includes(id))).toEqual([]);
        expect((await moodBucketService.getRememberedTrackIds(userId, "chill")).length).toBe(30);
    });

    it("a serving waits while another for the same listener and mood is drawing, and not for another mood", async () => {
        const userId = "mmp_user_lock";
        await prisma.user.create({ data: { id: userId, username: "mmp-lock", passwordHash: "x" } });
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const holding = prisma.$transaction(
            async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mood-serve:${userId}:chill`}, 0))`;
                await held;
            },
            { timeout: 60_000 },
        );
        try {
            // Another mood is not held up.
            expect(await moodBucketService.serveMoodMix(userId, "party", 15)).not.toBeNull();

            let done = false;
            const waiting = moodBucketService.serveMoodMix(userId, "chill", 15).then((mix) => ((done = true), mix));
            await untilLockWait("pg_advisory_xact_lock");
            expect(done).toBe(false);

            release();
            expect((await waiting)!.trackIds).toHaveLength(15);
        } finally {
            release();
            await holding;
        }
    });

    it("remembers what a serving gave the user and skips it on the next mix", async () => {
        const userId = "mmp_user_serve";
        await prisma.user.create({
            data: { id: userId, username: "mmp-serve", passwordHash: "x" },
        });
        // Save first, then record a later serving, as the route does.
        await moodBucketService.saveUserMoodMix(userId, "chill", 15, [m(0)]);
        await moodBucketService.recordServedTracks(userId, "chill", [m(1), m(2)]);

        const remembered = await moodBucketService.getRememberedTrackIds(userId, "chill");
        expect(new Set(remembered)).toEqual(new Set([m(0), m(1), m(2)]));

        // A mix for a different mood must not inherit this mood's history.
        expect(await moodBucketService.getRememberedTrackIds(userId, "party")).toEqual([]);
    });
});
