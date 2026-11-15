/**
 * What a listener was served for a mood is remembered per mood across servings, so the next mix skips more than the
 * last one: each serving is added to that mood's memory, newest last, and the memory is cut to the most recent
 * SERVED_MEMORY ids (a mix serves 15 songs, so about twenty servings). Saving a mix for another mood leaves it be.
 * Real suite database; the song ids need no rows, the memory is plain ids.
 */
import { prisma } from "../../utils/db";
import { moodBucketService, SERVED_MEMORY } from "../moodBucketService";

const USER = "servedmem_user";
const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `servedmem-${from + i}`);

async function seedMemory(mood: string, servedTrackIds: string[]) {
    await prisma.userMoodMemory.create({ data: { userId: USER, mood, servedTrackIds } });
}
const served = async (mood = "chill") =>
    (await prisma.userMoodMemory.findUnique({ where: { userId_mood: { userId: USER, mood } } }))?.servedTrackIds ?? [];

beforeEach(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
});
afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.$disconnect();
});

describe("recordServedTracks", () => {
    it("adds a serving to what was remembered, the newest last, instead of replacing it", async () => {
        await seedMemory("chill", ids(0, 3));

        await moodBucketService.recordServedTracks(USER, "chill", ids(3, 6));
        await moodBucketService.recordServedTracks(USER, "chill", ids(6, 8));

        expect(await served()).toEqual(ids(0, 8));
    });

    it("starts a mood's memory with its first serving, with no saved mix needed", async () => {
        await moodBucketService.recordServedTracks(USER, "chill", ids(0, 3));

        expect(await served()).toEqual(ids(0, 3));
        expect(await prisma.userMoodMix.count({ where: { userId: USER } })).toBe(0);
    });

    it("remembers a song served again once, at its newest place", async () => {
        await seedMemory("chill", ids(0, 4));

        await moodBucketService.recordServedTracks(USER, "chill", ["servedmem-1", "servedmem-9"]);

        expect(await served()).toEqual(["servedmem-0", "servedmem-2", "servedmem-3", "servedmem-1", "servedmem-9"]);
    });

    it("keeps only the most recent songs once the memory is full, and the next mix still skips them", async () => {
        await seedMemory("chill", ids(0, SERVED_MEMORY - 5));

        await moodBucketService.recordServedTracks(USER, "chill", ids(1000, 1015));

        const kept = await served();
        expect(kept).toHaveLength(SERVED_MEMORY);
        expect(kept.slice(-15)).toEqual(ids(1000, 1015));
        // The oldest ten went; the rest stayed in order.
        expect(kept[0]).toBe("servedmem-10");
        expect(await moodBucketService.getRememberedTrackIds(USER, "chill")).toEqual(expect.arrayContaining(ids(1000, 1015)));
    });

    it("keeps the newest of a serving larger than the whole memory", async () => {
        await seedMemory("chill", ["servedmem-old"]);

        await moodBucketService.recordServedTracks(USER, "chill", ids(0, SERVED_MEMORY + 7));

        expect(await served()).toEqual(ids(7, SERVED_MEMORY + 7));
    });

    it("keeps each mood's memory apart", async () => {
        await seedMemory("party", ids(0, 2));

        await moodBucketService.recordServedTracks(USER, "chill", ids(5, 7));

        expect(await served("party")).toEqual(ids(0, 2));
        expect(await served("chill")).toEqual(ids(5, 7));
    });

    it("records nothing for an empty serving", async () => {
        await moodBucketService.recordServedTracks(USER, "chill", []);

        expect(await prisma.userMoodMemory.count({ where: { userId: USER } })).toBe(0);
    });

    it("two servings at once both land, including the first ever", async () => {
        await Promise.all([
            moodBucketService.recordServedTracks(USER, "chill", ids(0, 3)),
            moodBucketService.recordServedTracks(USER, "chill", ids(3, 6)),
        ]);

        expect([...(await served())].sort()).toEqual(ids(0, 6).sort());
    });

    it("goes with the listener", async () => {
        await seedMemory("chill", ids(0, 2));

        await prisma.user.delete({ where: { id: USER } });

        expect(await prisma.userMoodMemory.count({ where: { userId: USER } })).toBe(0);
    });
});

describe("getRememberedTrackIds", () => {
    it("is that mood's memory plus the saved mix when it is for that mood", async () => {
        await seedMemory("chill", ids(0, 2));
        await seedMemory("party", ids(10, 12));
        await prisma.userMoodMix.create({ data: { userId: USER, mood: "chill", trackIds: ids(20, 22), coverUrls: [], generatedAt: new Date() } });

        expect(new Set(await moodBucketService.getRememberedTrackIds(USER, "chill"))).toEqual(new Set([...ids(0, 2), ...ids(20, 22)]));
        expect(await moodBucketService.getRememberedTrackIds(USER, "party")).toEqual(ids(10, 12));
        expect(await moodBucketService.getRememberedTrackIds(USER, "happy")).toEqual([]);
    });
});
