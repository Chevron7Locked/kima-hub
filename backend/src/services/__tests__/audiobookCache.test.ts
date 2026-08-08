/**
 * AudiobookCacheService.syncAll -- sortName.
 *
 * `GET /audiobooks` now orders on `sortName`, not `title` (see
 * routes/__tests__/audiobooks.route.test.ts), so it has to be kept in sync at
 * write time -- Audiobook has no displayTitle/hasUserOverrides equivalent, so
 * unlike Album this is a straight derivation from `title` alone, but `title`
 * itself is refreshed unconditionally on every sync (both the create AND the
 * update branch of the upsert set it from freshly fetched metadata), so
 * sortName has to refresh the same way or it goes stale the moment a synced
 * book's title changes upstream.
 */

jest.mock("../../utils/db", () => ({
    prisma: {
        audiobook: {
            upsert: jest.fn().mockResolvedValue({}),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../config", () => ({
    config: { music: { musicPath: "/music" } },
}));

jest.mock("../audiobookshelf", () => ({
    audiobookshelfService: { getAllAudiobooks: jest.fn() },
}));

import { audiobookCacheService } from "../audiobookCache";
import { audiobookshelfService } from "../audiobookshelf";
import { prisma } from "../../utils/db";

// No cover data on the fixture books below, so getFullCoverUrl/downloadCover
// are never reached -- only ensureCoverCacheDir needs stubbing.
beforeEach(() => {
    jest.spyOn(audiobookCacheService as any, "ensureCoverCacheDir").mockResolvedValue(false);
});

afterEach(() => jest.restoreAllMocks());

function minimalBook(id: string, title: string) {
    return {
        id,
        libraryId: "lib1",
        media: { metadata: { title, authorName: "Some Author" } },
    };
}

describe("syncAll -- sortName kept in sync with title", () => {
    it("sets sortName, article-stripped, on both the create and update branch of the upsert", async () => {
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([
            minimalBook("book-1", "The Great Book"),
        ]);

        await audiobookCacheService.syncAll();

        expect(prisma.audiobook.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "book-1" },
                create: expect.objectContaining({ title: "The Great Book", sortName: "great book" }),
                update: expect.objectContaining({ title: "The Great Book", sortName: "great book" }),
            }),
        );
    });

    it("leaves a title with no leading article unchanged", async () => {
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([
            minimalBook("book-2", "Dune"),
        ]);

        await audiobookCacheService.syncAll();

        expect(prisma.audiobook.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({ sortName: "dune" }),
                update: expect.objectContaining({ sortName: "dune" }),
            }),
        );
    });
});
