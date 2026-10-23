/**
 * saveUserMoodMix with trackIds stores those tracks in order; without them it
 * regenerates through getMoodMix, which draws from the mood page's recipe.
 */

jest.mock("../../utils/db", () => ({
    prisma: {
        userMoodMix: {
            upsert: jest.fn(),
            findUnique: jest.fn(),
        },
        track: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../mixes/recipes", () => ({
    RECIPE_LINE: 1,
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

const USER_ID = "user-test-123";
const MOOD: MoodType = "happy";

// Mocked track data for explicit trackIds path
const MOCK_TRACKS = [
    { id: "track-1", album: { coverUrl: "https://example.com/cover1.jpg" } },
    { id: "track-2", album: { coverUrl: "https://example.com/cover2.jpg" } },
    { id: "track-3", album: { coverUrl: "https://example.com/cover3.jpg" } },
];

// Mocked track data for regenerate path (getMoodMix)
const MOCK_REGEN_TRACKS = [
    { id: "regen-track-1", album: { coverUrl: "https://example.com/regen1.jpg" } },
    { id: "regen-track-2", album: { coverUrl: "https://example.com/regen2.jpg" } },
    { id: "regen-track-3", album: { coverUrl: "https://example.com/regen3.jpg" } },
    { id: "regen-track-4", album: { coverUrl: "https://example.com/regen4.jpg" } },
    { id: "regen-track-5", album: { coverUrl: "https://example.com/regen5.jpg" } },
    { id: "regen-track-6", album: { coverUrl: "https://example.com/regen6.jpg" } },
    { id: "regen-track-7", album: { coverUrl: "https://example.com/regen7.jpg" } },
    { id: "regen-track-8", album: { coverUrl: "https://example.com/regen8.jpg" } },
];


describe("saveUserMoodMix with explicit trackIds", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Track lookup returns the tracks matching the provided trackIds
        (prisma.track.findMany as jest.Mock).mockResolvedValue(MOCK_TRACKS);
    });

    it("persists the exact trackIds and derived coverUrls", async () => {
        const explicitTrackIds = ["track-1", "track-2", "track-3"];
        const expectedCoverUrls = [
            "https://example.com/cover1.jpg",
            "https://example.com/cover2.jpg",
            "https://example.com/cover3.jpg",
        ];

        const result = await moodBucketService.saveUserMoodMix(
            USER_ID,
            MOOD,
            15,
            explicitTrackIds
        );

        expect(result).not.toBeNull();
        expect(result!.trackIds).toEqual(explicitTrackIds);
        expect(result!.coverUrls).toEqual(expectedCoverUrls);
        expect(result!.trackCount).toBe(3);

        // Verify upsert was called with the exact trackIds and coverUrls
        expect(prisma.userMoodMix.upsert).toHaveBeenCalledTimes(1);
        const upsertCall = (prisma.userMoodMix.upsert as jest.Mock).mock.calls[0][0];
        expect(upsertCall.where).toEqual({ userId: USER_ID });
        expect(upsertCall.create).toEqual(
            expect.objectContaining({
                userId: USER_ID,
                mood: MOOD,
                trackIds: explicitTrackIds,
                coverUrls: expectedCoverUrls,
            })
        );
        expect(upsertCall.update).toEqual(
            expect.objectContaining({
                mood: MOOD,
                trackIds: explicitTrackIds,
                coverUrls: expectedCoverUrls,
            })
        );

        // Verify track.findMany was called with the exact trackIds
        expect(prisma.track.findMany).toHaveBeenCalledTimes(1);
        const trackCall = (prisma.track.findMany as jest.Mock).mock.calls[0][0];
        expect(trackCall.where).toEqual({ id: { in: explicitTrackIds } });
    });

    it("saving then reading back returns the persisted trackIds in the same order", async () => {
        const explicitTrackIds = ["track-1", "track-2", "track-3"];
        const expectedCoverUrls = [
            "https://example.com/cover1.jpg",
            "https://example.com/cover2.jpg",
            "https://example.com/cover3.jpg",
        ];

        // Simulate the upsert from saveUserMoodMix
        (prisma.userMoodMix.upsert as jest.Mock).mockResolvedValue({
            userId: USER_ID,
            mood: MOOD,
            trackIds: explicitTrackIds,
            coverUrls: expectedCoverUrls,
            generatedAt: new Date(),
        });

        // Save the mix
        await moodBucketService.saveUserMoodMix(
            USER_ID,
            MOOD,
            15,
            explicitTrackIds
        );

        // Now get the user mix
        (prisma.userMoodMix.findUnique as jest.Mock).mockResolvedValue({
            userId: USER_ID,
            mood: MOOD,
            trackIds: explicitTrackIds,
            coverUrls: expectedCoverUrls,
            generatedAt: new Date(),
        });

        const userMix = await moodBucketService.getUserMoodMix(USER_ID);

        expect(userMix).not.toBeNull();
        expect(userMix!.trackIds).toEqual(explicitTrackIds);
        expect(userMix!.coverUrls).toEqual(expectedCoverUrls);
        expect(userMix!.trackCount).toBe(3);
    });

    it("returns empty coverUrls for trackIds without album coverUrl", async () => {
        const tracksWithoutCover = [
            { id: "track-1", album: { coverUrl: null as unknown as string } },
            { id: "track-2", album: { coverUrl: null as unknown as string } },
        ];
        (prisma.track.findMany as jest.Mock).mockResolvedValue(tracksWithoutCover);

        const result = await moodBucketService.saveUserMoodMix(
            USER_ID,
            MOOD,
            15,
            ["track-1", "track-2"]
        );

        expect(result).not.toBeNull();
        expect(result!.trackIds).toEqual(["track-1", "track-2"]);
        expect(result!.coverUrls).toEqual([]);
        expect(result!.trackCount).toBe(2);
    });

    it("caps coverUrls to 4 even when more tracks have covers", async () => {
        const tracksWithCovers = [
            { id: "track-1", album: { coverUrl: "https://example.com/cover1.jpg" } },
            { id: "track-2", album: { coverUrl: "https://example.com/cover2.jpg" } },
            { id: "track-3", album: { coverUrl: "https://example.com/cover3.jpg" } },
            { id: "track-4", album: { coverUrl: "https://example.com/cover4.jpg" } },
            { id: "track-5", album: { coverUrl: "https://example.com/cover5.jpg" } },
        ];
        (prisma.track.findMany as jest.Mock).mockResolvedValue(tracksWithCovers);

        const result = await moodBucketService.saveUserMoodMix(
            USER_ID,
            MOOD,
            15,
            ["track-1", "track-2", "track-3", "track-4", "track-5"]
        );

        expect(result).not.toBeNull();
        expect(result!.coverUrls).toHaveLength(4);
        expect(result!.coverUrls).toEqual([
            "https://example.com/cover1.jpg",
            "https://example.com/cover2.jpg",
            "https://example.com/cover3.jpg",
            "https://example.com/cover4.jpg",
        ]);
        // But trackCount reflects all tracks
        expect(result!.trackCount).toBe(5);
    });

    it("preserves order of trackIds even when DB returns them in different order", async () => {
        // DB returns tracks in a different order than the provided trackIds
        const tracksInDifferentOrder = [
            { id: "track-3", album: { coverUrl: "https://example.com/cover3.jpg" } },
            { id: "track-1", album: { coverUrl: "https://example.com/cover1.jpg" } },
            { id: "track-2", album: { coverUrl: "https://example.com/cover2.jpg" } },
        ];
        (prisma.track.findMany as jest.Mock).mockResolvedValue(tracksInDifferentOrder);

        const explicitTrackIds = ["track-1", "track-2", "track-3"];
        const result = await moodBucketService.saveUserMoodMix(
            USER_ID,
            MOOD,
            15,
            explicitTrackIds
        );

        expect(result).not.toBeNull();
        // trackIds should be in the original order
        expect(result!.trackIds).toEqual(explicitTrackIds);
    });

    it("filters out trackIds that are not found in the DB", async () => {
        const tracksInDb = [
            { id: "track-1", album: { coverUrl: "https://example.com/cover1.jpg" } },
            // track-999 is not in the DB
        ];
        (prisma.track.findMany as jest.Mock).mockResolvedValue(tracksInDb);

        const result = await moodBucketService.saveUserMoodMix(
            USER_ID,
            MOOD,
            15,
            ["track-1", "track-999"]
        );

        expect(result).not.toBeNull();
        expect(result!.trackIds).toEqual(["track-1"]);
        expect(result!.trackCount).toBe(1);
    });
});


describe("saveUserMoodMix without explicit trackIds (regenerate path)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Track lookup for regenerate path
        (prisma.track.findMany as jest.Mock).mockResolvedValue(MOCK_REGEN_TRACKS);
        // The page recipe's draw for getMoodMix
        (pickPageTracks as jest.Mock).mockResolvedValue(MOCK_REGEN_TRACKS.map((t) => t.id));
    });

    it("calls getMoodMix and persists the regenerated mix", async () => {
        const result = await moodBucketService.saveUserMoodMix(
            USER_ID,
            MOOD,
            15
        );

        expect(result).not.toBeNull();
        expect(result!.trackIds).toEqual(MOCK_REGEN_TRACKS.map((t) => t.id));
        expect(result!.coverUrls).toEqual([
          "https://example.com/regen1.jpg",
          "https://example.com/regen2.jpg",
          "https://example.com/regen3.jpg",
          "https://example.com/regen4.jpg",
        ]);

        // getMoodMix drew from the Upbeat page's recipe, then read the drawn tracks
        expect(pickPageTracks).toHaveBeenCalledTimes(1);
        expect(pickPageTracks).toHaveBeenCalledWith({ id: "upbeat" }, expect.objectContaining({ limit: 15 }));
        expect(prisma.track.findMany).toHaveBeenCalledTimes(1);

        // Verify upsert was called with regenerated data
        expect(prisma.userMoodMix.upsert).toHaveBeenCalledTimes(1);
        const upsertCall = (prisma.userMoodMix.upsert as jest.Mock).mock.calls[0][0];
        expect(upsertCall.where).toEqual({ userId: USER_ID });
        expect(upsertCall.create).toEqual(
          expect.objectContaining({
              userId: USER_ID,
              mood: MOOD,
              trackIds: MOCK_REGEN_TRACKS.map((t) => t.id),
              coverUrls: [
                  "https://example.com/regen1.jpg",
                  "https://example.com/regen2.jpg",
                  "https://example.com/regen3.jpg",
                  "https://example.com/regen4.jpg",
              ],
          })
        );
    });

    it("returns null when getMoodMix returns null (not enough tracks)", async () => {
        (pickPageTracks as jest.Mock).mockResolvedValue(null);

        const result = await moodBucketService.saveUserMoodMix(
            USER_ID,
            MOOD,
            15
        );

        expect(result).toBeNull();
        // track.findMany should NOT be called when getMoodMix returns null early
        expect(prisma.track.findMany).not.toHaveBeenCalled();
    });

    it("handles undefined trackIds (same as not providing it)", async () => {
        const result = await moodBucketService.saveUserMoodMix(
            USER_ID,
            MOOD,
            15,
            undefined
        );

        expect(result).not.toBeNull();
        // Should use regenerate path
        expect(result!.trackIds).toEqual(MOCK_REGEN_TRACKS.map((t) => t.id));
    });

    it("handles empty array trackIds (same as not providing it)", async () => {
        const result = await moodBucketService.saveUserMoodMix(
            USER_ID,
            MOOD,
            15,
            []
        );

        expect(result).not.toBeNull();
        // Empty array should fall through to regenerate path
        expect(result!.trackIds).toEqual(MOCK_REGEN_TRACKS.map((t) => t.id));
    });
});

describe("getUserMoodMix", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns null when no user mix exists", async () => {
        (prisma.userMoodMix.findUnique as jest.Mock).mockResolvedValue(null);

        const result = await moodBucketService.getUserMoodMix(USER_ID);
        expect(result).toBeNull();
    });

    it("returns the saved mix with correct format", async () => {
        const savedAt = new Date("2025-01-01T00:00:00.000Z");
        (prisma.userMoodMix.findUnique as jest.Mock).mockResolvedValue({
            userId: USER_ID,
            mood: MOOD,
            trackIds: ["track-1", "track-2"],
            coverUrls: ["https://example.com/cover1.jpg", "https://example.com/cover2.jpg"],
            generatedAt: savedAt,
        });

        const result = await moodBucketService.getUserMoodMix(USER_ID);

        expect(result).not.toBeNull();
        expect(result!.type).toBe("mood");
        expect(result!.mood).toBe(MOOD);
        expect(result!.trackIds).toEqual(["track-1", "track-2"]);
        expect(result!.trackCount).toBe(2);
        expect(result!.id).toContain("your-mood-mix-");
    });

    it("returns null for invalid mood", async () => {
        (prisma.userMoodMix.findUnique as jest.Mock).mockResolvedValue({
            userId: USER_ID,
            mood: "invalid-mood",
            trackIds: [],
            coverUrls: [],
            generatedAt: new Date(),
        });

        const result = await moodBucketService.getUserMoodMix(USER_ID);
        expect(result).toBeNull();
    });
});
