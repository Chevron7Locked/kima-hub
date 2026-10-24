/**
 * getMoodMix draws evenly from every member of the mood page's recipe (Calm: the calm page recipe), at most 2 songs
 * per artist, skips what this user was already served while enough others remain, and stores what it served on
 * UserMoodMix so the next mix can skip it. On the 3,000-track synthetic library with learned moods.
 */

const store = new Map<string, string>();
jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
        multi: jest.fn(() => {
            const ops: Array<() => void> = [];
            const chain = {
                setex: (k: string, _ttl: number, v: string) => { ops.push(() => store.set(k, v)); return chain; },
                del: (k: string) => { ops.push(() => store.delete(k)); return chain; },
                sadd: () => chain,
                expire: () => chain,
                exec: async () => { ops.forEach((op) => op()); return []; },
            };
            return chain;
        }),
    },
}));

import { prisma } from "../../utils/db";
import { moodBucketService, MoodType } from "../moodBucketService";
import { buildMoodState } from "../moods/state";
import { pickRecipeStation } from "../mixes/recipes";
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

    it("starts over from every member when exclusions leave too few", async () => {
        const excluded = [...members.get("chill")!];
        const mix = await moodBucketService.getMoodMix("chill", 15, excluded);
        // A thin mix would be worse than repeating: the draw falls back to every member rather than returning null.
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toHaveLength(15);
    });

    it("shows each preset's count as the songs its page plays, not the size of the mood's bucket", async () => {
        const presets = await moodBucketService.getMoodPresets();
        const buckets = await prisma.moodBucket.groupBy({ by: ["mood"], _count: { _all: true } });
        for (const preset of presets) {
            expect(preset.trackCount).toBe(members.get(preset.id as MoodType)!.size);
            // The fixture's buckets are random rows, sized unlike any page recipe.
            expect(preset.trackCount).not.toBe(buckets.find((b) => b.mood === preset.id)?._count._all ?? 0);
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
        // What the user was given is remembered next to the saved mix itself.
        expect(row!.servedTrackIds).toEqual([m(0), m(1), m(2)]);
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
