/**
 * syncAll removes books absent from Audiobookshelf's list, refuses to prune on an
 * empty list, deletes isMissing books, and parses "(2008)" as 2008.
 * Real database; Audiobookshelf is stubbed.
 */

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

const P = "zz-audiobookPrune-";

// The prune pass deletes every row not in the stub's list, so a file starts and ends with no audiobooks.
async function wipe() {
    await prisma.audiobook.deleteMany({});
}
async function seed(id: string, title = "Seeded") {
    await prisma.audiobook.create({
        data: { id: `${P}${id}`, title, sortName: title.toLowerCase(), audioUrl: `${P}${id}` },
    });
}
async function ids() {
    return (await prisma.audiobook.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((b) => b.id);
}
beforeAll(wipe);
afterAll(wipe);

beforeEach(async () => {
    await wipe();
    jest.spyOn(audiobookCacheService as any, "ensureCoverCacheDir").mockResolvedValue(false);
});

afterEach(() => jest.restoreAllMocks());

function minimalBook(id: string, title: string) {
    return {
        id: `${P}${id}`,
        libraryId: "lib1",
        media: { metadata: { title, authorName: "Some Author" } },
    };
}

describe("syncAll -- prune pass", () => {
    it("deletes rows whose ids are not in ABS's live set", async () => {
        await seed("old-1");
        await seed("old-2");
        await seed("old-3");
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([
            minimalBook("live-1", "Book One"),
        ]);

        const result = await audiobookCacheService.syncAll();

        expect(await ids()).toEqual([`${P}live-1`]);
        expect(result.pruned).toBe(3);
    });

    it("refuses to prune when ABS returns an empty list (failed fetch must not wipe the library)", async () => {
        await seed("kept-1");
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([]);

        const result = await audiobookCacheService.syncAll();

        expect(await ids()).toEqual([`${P}kept-1`]);
        expect(result.pruned).toBe(0);
    });

    it("deletes an isMissing book instead of skipping it", async () => {
        await seed("gone-1", "Vanished");
        const missing = { ...minimalBook("gone-1", "Vanished"), isMissing: true };
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([
            minimalBook("live-1", "Book One"),
            missing,
        ]);

        await audiobookCacheService.syncAll();

        expect(await ids()).toEqual([`${P}live-1`]);
    });

    it("parses bracketed years: '(2008)' -> 2008, not null", async () => {
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([
            {
                ...minimalBook("y1", "Saturn's Children"),
                media: {
                    metadata: { title: "Saturn's Children", authorName: "C Stross", publishedYear: "(2008)" },
                },
            },
        ]);

        await audiobookCacheService.syncAll();

        expect((await prisma.audiobook.findUnique({ where: { id: `${P}y1` } }))?.publishedYear).toBe(2008);
    });
});
