/**
 * saveUserMoodMix with trackIds stores those tracks in order; without them it
 * regenerates through getMoodMix, which draws from the mood page's recipe.
 * Real database: the songs, the user and the saved mix are rows. The page recipe's draw is stubbed.
 */

jest.mock("../mixes/recipes", () => ({
    RECIPE_LINE: 1.25,
    UnrankableLibraryError: class UnrankableLibraryError extends Error {},
    getRecipe: jest.fn((id: string) => ({ id })),
    pickPageTracks: jest.fn(),
}));

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { moodBucketService, MoodType } from "../moodBucketService";
import { prisma } from "../../utils/db";
import { pickPageTracks } from "../mixes/recipes";

const P = "zz-moodBucket-";
const USER_ID = `${P}user`;
const MOOD: MoodType = "happy";
const cover = (n: number | string) => `https://example.com/cover${n}.jpg`;

async function wipe() {
    await prisma.user.deleteMany({ where: { id: USER_ID } }); // the saved mix goes with it
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

/** A song on an album of its own, so each has its own cover. Playable unless asked otherwise. */
async function seedSong(
    id: string,
    opts: { corrupt?: boolean; location?: "LIBRARY" | "DISCOVER"; missing?: boolean } = {},
) {
    await prisma.album.create({
        data: {
            id: `${P}alb-${id}`, artistId: `${P}art`, title: id, identityKey: `${P}alb-${id}`, rgMbid: `${P}alb-${id}`, primaryType: "Album",
            location: opts.location ?? "LIBRARY", coverUrl: cover(id),
        },
    });
    await prisma.track.create({
        data: {
            id: `${P}${id}`, albumId: `${P}alb-${id}`, title: id, trackNo: 1, duration: 200,
            filePath: `/tmp/${P}${id}.flac`, fileModified: new Date(), fileSize: 1000,
            corrupt: opts.corrupt ?? false, missingSince: opts.missing ? new Date() : null,
        },
    });
}
const ids = (...names: (string | number)[]) => names.map((n) => `${P}${n}`);
const saved = () => prisma.userMoodMix.findUnique({ where: { userId: USER_ID } });

afterAll(wipe);

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await prisma.user.create({ data: { id: USER_ID, username: USER_ID, passwordHash: "x" } });
    await prisma.artist.create({ data: { id: `${P}art`, name: "Mood Artist", identityKey: `${P}art` } });
});

describe("saveUserMoodMix with explicit trackIds", () => {
    beforeEach(async () => {
        for (const n of [1, 2, 3]) await seedSong(String(n));
    });

    it("persists the exact trackIds and derived coverUrls", async () => {
        const explicitTrackIds = ids(1, 2, 3);
        const expectedCoverUrls = [cover(1), cover(2), cover(3)];

        const result = await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, explicitTrackIds);

        expect(result).not.toBeNull();
        expect(result!.trackIds).toEqual(explicitTrackIds);
        expect(result!.coverUrls).toEqual(expectedCoverUrls);
        expect(result!.trackCount).toBe(3);
        expect(await saved()).toMatchObject({
            mood: MOOD,
            trackIds: explicitTrackIds,
            coverUrls: expectedCoverUrls,
            servedTrackIds: explicitTrackIds,
        });
    });

    it("saving then reading back returns the persisted trackIds in the same order", async () => {
        const explicitTrackIds = ids(3, 1, 2);

        await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, explicitTrackIds);
        const userMix = await moodBucketService.getUserMoodMix(USER_ID);

        expect(userMix).not.toBeNull();
        expect(userMix!.trackIds).toEqual(explicitTrackIds);
        expect(userMix!.coverUrls).toEqual([cover(3), cover(1), cover(2)]);
        expect(userMix!.trackCount).toBe(3);
    });

    it("saving again replaces the one saved mix", async () => {
        await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, ids(1, 2));
        await moodBucketService.saveUserMoodMix(USER_ID, "sad", 15, ids(3));

        expect(await prisma.userMoodMix.count({ where: { userId: USER_ID } })).toBe(1);
        expect(await saved()).toMatchObject({ mood: "sad", trackIds: ids(3) });
    });

    it("returns empty coverUrls for trackIds without album coverUrl", async () => {
        await prisma.album.updateMany({ where: { id: { startsWith: P } }, data: { coverUrl: null } });

        const result = await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, ids(1, 2));

        expect(result).not.toBeNull();
        expect(result!.trackIds).toEqual(ids(1, 2));
        expect(result!.coverUrls).toEqual([]);
        expect(result!.trackCount).toBe(2);
    });

    it("caps coverUrls to 4 even when more tracks have covers", async () => {
        for (const n of [4, 5]) await seedSong(String(n));

        const result = await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, ids(1, 2, 3, 4, 5));

        expect(result).not.toBeNull();
        expect(result!.coverUrls).toEqual([cover(1), cover(2), cover(3), cover(4)]);
        // But trackCount reflects all tracks
        expect(result!.trackCount).toBe(5);
    });

    it("preserves the order of trackIds, not the order the songs were stored in", async () => {
        const explicitTrackIds = ids(3, 1, 2);

        const result = await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, explicitTrackIds);

        expect(result!.trackIds).toEqual(explicitTrackIds);
        expect((await saved())!.trackIds).toEqual(explicitTrackIds);
    });

    it("filters out trackIds that are not found in the DB", async () => {
        const result = await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, [`${P}1`, `${P}999`]);

        expect(result).not.toBeNull();
        expect(result!.trackIds).toEqual(ids(1));
        expect(result!.trackCount).toBe(1);
    });

    it("drops a corrupt, missing or Discover song, which is not a playable song", async () => {
        await seedSong("bad", { corrupt: true });
        await seedSong("gone", { missing: true });
        await seedSong("disc", { location: "DISCOVER" });

        const result = await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, ids(1, "bad", "gone", "disc", 2));

        expect(result!.trackIds).toEqual(ids(1, 2));
        expect((await saved())!.trackIds).toEqual(ids(1, 2));
    });

    it("returns null and keeps the previous mix when none of the songs sent is playable", async () => {
        await seedSong("bad", { corrupt: true });
        await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, ids(1, 2));

        const result = await moodBucketService.saveUserMoodMix(USER_ID, "sad", 15, ids("bad", "nope"));

        expect(result).toBeNull();
        expect(await saved()).toMatchObject({ mood: MOOD, trackIds: ids(1, 2) });
    });
});

describe("saveUserMoodMix without explicit trackIds (regenerate path)", () => {
    const regen = Array.from({ length: 8 }, (_, i) => `regen-${i + 1}`);

    beforeEach(async () => {
        for (const n of regen) await seedSong(n);
        // The page recipe's draw for getMoodMix
        (pickPageTracks as jest.Mock).mockResolvedValue(ids(...regen));
    });

    it("calls getMoodMix and persists the regenerated mix", async () => {
        const result = await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15);

        const covers = regen.slice(0, 4).map(cover);
        expect(result).not.toBeNull();
        expect(result!.trackIds).toEqual(ids(...regen));
        expect(result!.coverUrls).toEqual(covers);

        // getMoodMix drew from the Upbeat page's recipe
        expect(pickPageTracks).toHaveBeenCalledTimes(1);
        expect(pickPageTracks).toHaveBeenCalledWith({ id: "upbeat" }, expect.objectContaining({ limit: 15 }));

        expect(await saved()).toMatchObject({ mood: MOOD, trackIds: ids(...regen), coverUrls: covers });
    });

    it("skips what the listener was already served for the mood", async () => {
        await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, ids(regen[0]));

        await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15);

        expect(pickPageTracks).toHaveBeenLastCalledWith({ id: "upbeat" }, { limit: 15, exclude: ids(regen[0]) });
    });

    it("returns null when getMoodMix returns null (not enough tracks), leaving the previous mix", async () => {
        await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, ids(regen[0]));
        (pickPageTracks as jest.Mock).mockResolvedValue(null);

        const result = await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15);

        expect(result).toBeNull();
        expect((await saved())!.trackIds).toEqual(ids(regen[0]));
    });

    it("handles undefined trackIds (same as not providing it)", async () => {
        const result = await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, undefined);

        expect(result).not.toBeNull();
        expect(result!.trackIds).toEqual(ids(...regen));
    });

    it("handles empty array trackIds (same as not providing it)", async () => {
        const result = await moodBucketService.saveUserMoodMix(USER_ID, MOOD, 15, []);

        expect(result).not.toBeNull();
        expect(result!.trackIds).toEqual(ids(...regen));
    });
});

describe("getUserMoodMix", () => {
    it("returns null when no user mix exists", async () => {
        expect(await moodBucketService.getUserMoodMix(USER_ID)).toBeNull();
    });

    it("returns the saved mix with correct format", async () => {
        await seedSong("1");
        await seedSong("2");
        await prisma.userMoodMix.create({
            data: {
                userId: USER_ID, mood: MOOD, trackIds: ids(1, 2), coverUrls: [cover(1), cover(2)],
                servedTrackIds: [], generatedAt: new Date("2025-01-01T00:00:00.000Z"),
            },
        });

        const result = await moodBucketService.getUserMoodMix(USER_ID);

        expect(result).not.toBeNull();
        expect(result!.type).toBe("mood");
        expect(result!.mood).toBe(MOOD);
        expect(result!.trackIds).toEqual(ids(1, 2));
        expect(result!.trackCount).toBe(2);
        expect(result!.coverUrls).toEqual([cover(1), cover(2)]);
        expect(result!.id).toContain("your-mood-mix-");
    });

    it("counts only the songs that still play, and takes the covers from those", async () => {
        await seedSong("1");
        await seedSong("2", { corrupt: true });
        await prisma.userMoodMix.create({
            data: {
                userId: USER_ID, mood: MOOD, trackIds: ids(1, 2), coverUrls: [cover(1), cover(2)],
                servedTrackIds: [], generatedAt: new Date(),
            },
        });

        const result = await moodBucketService.getUserMoodMix(USER_ID);

        expect(result!.trackIds).toEqual(ids(1));
        expect(result!.coverUrls).toEqual([cover(1)]);
    });

    it("returns null for invalid mood", async () => {
        await prisma.userMoodMix.create({
            data: { userId: USER_ID, mood: "invalid-mood", trackIds: [], coverUrls: [], servedTrackIds: [], generatedAt: new Date() },
        });

        expect(await moodBucketService.getUserMoodMix(USER_ID)).toBeNull();
    });
});
