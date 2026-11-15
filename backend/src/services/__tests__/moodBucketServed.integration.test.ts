/**
 * What a listener was served for a mood is remembered across servings, so the next mix skips more than the last one:
 * each serving is added to the memory, newest last, and the memory is cut to the most recent SERVED_MEMORY ids (a mix
 * serves 15 songs, so about twenty servings). Real suite database; the song ids need no rows, the memory is plain ids.
 */
import { prisma } from "../../utils/db";
import { moodBucketService, SERVED_MEMORY } from "../moodBucketService";

const USER = "servedmem_user";
const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `servedmem-${from + i}`);

async function seedMix(mood: string, trackIds: string[], servedTrackIds: string[]) {
    await prisma.userMoodMix.create({ data: { userId: USER, mood, trackIds, servedTrackIds, coverUrls: [], generatedAt: new Date() } });
}
const served = async () => (await prisma.userMoodMix.findUniqueOrThrow({ where: { userId: USER } })).servedTrackIds;

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
        await seedMix("chill", ids(0, 3), ids(0, 3));

        await moodBucketService.recordServedTracks(USER, "chill", ids(3, 6));
        await moodBucketService.recordServedTracks(USER, "chill", ids(6, 8));

        expect(await served()).toEqual(ids(0, 8));
    });

    it("remembers a song served again once, at its newest place", async () => {
        await seedMix("chill", [], ids(0, 4));

        await moodBucketService.recordServedTracks(USER, "chill", ["servedmem-1", "servedmem-9"]);

        expect(await served()).toEqual(["servedmem-0", "servedmem-2", "servedmem-3", "servedmem-1", "servedmem-9"]);
    });

    it("keeps only the most recent songs once the memory is full, and the next mix still skips them", async () => {
        await seedMix("chill", [], ids(0, SERVED_MEMORY - 5));

        await moodBucketService.recordServedTracks(USER, "chill", ids(1000, 1015));

        const kept = await served();
        expect(kept).toHaveLength(SERVED_MEMORY);
        expect(kept.slice(-15)).toEqual(ids(1000, 1015));
        // The oldest ten went; the rest stayed in order.
        expect(kept[0]).toBe("servedmem-10");
        expect(await moodBucketService.getRememberedTrackIds(USER, "chill")).toEqual(expect.arrayContaining(ids(1000, 1015)));
    });

    it("keeps the newest of a serving larger than the whole memory", async () => {
        await seedMix("chill", [], ["servedmem-old"]);

        await moodBucketService.recordServedTracks(USER, "chill", ids(0, SERVED_MEMORY + 7));

        expect(await served()).toEqual(ids(7, SERVED_MEMORY + 7));
    });

    it("leaves a memory kept for another mood, and a listener with no saved mix, alone", async () => {
        await seedMix("party", [], ids(0, 2));

        await moodBucketService.recordServedTracks(USER, "chill", ids(5, 7));
        expect(await served()).toEqual(ids(0, 2));

        await prisma.userMoodMix.deleteMany({ where: { userId: USER } });
        await moodBucketService.recordServedTracks(USER, "chill", ids(5, 7));
        expect(await prisma.userMoodMix.count({ where: { userId: USER } })).toBe(0);
    });

    it("two servings at once both land", async () => {
        await seedMix("chill", [], []);

        await Promise.all([
            moodBucketService.recordServedTracks(USER, "chill", ids(0, 3)),
            moodBucketService.recordServedTracks(USER, "chill", ids(3, 6)),
        ]);

        expect([...(await served())].sort()).toEqual(ids(0, 6).sort());
    });
});
