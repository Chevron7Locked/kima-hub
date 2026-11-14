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

    describe("on a library bigger than a page of ids", () => {
        const STORED = 1100;
        const seedMany = () =>
            prisma.audiobook.createMany({
                data: Array.from({ length: STORED }, (_, i) => {
                    const id = `${P}bulk-${String(i).padStart(4, "0")}`;
                    return { id, title: id, sortName: id, audioUrl: id };
                }),
            });

        it("deletes the books ABS no longer lists in batches, never with one list of every id", async () => {
            await seedMany();
            await seed("keep-me");
            (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([minimalBook("keep-me", "Keeper")]);
            jest.spyOn(audiobookCacheService as any, "syncAudiobook").mockResolvedValue(true);
            const prune = jest.spyOn(prisma.audiobook, "deleteMany");

            const result = await audiobookCacheService.syncAll();

            expect(await ids()).toEqual([`${P}keep-me`]);
            expect(result.pruned).toBe(STORED);
            const wheres = prune.mock.calls.map(([args]) => args?.where as { id?: { in?: string[]; notIn?: string[] } });
            expect(wheres.length).toBeGreaterThanOrEqual(2);
            for (const where of wheres) {
                expect(where.id?.notIn).toBeUndefined();
                expect(where.id?.in?.length).toBeLessThanOrEqual(500);
            }
        });

        it("reads the stored ids a page at a time, by id", async () => {
            await seedMany();
            (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([minimalBook("keep-me", "Keeper")]);
            jest.spyOn(audiobookCacheService as any, "syncAudiobook").mockResolvedValue(true);
            const find = jest.spyOn(prisma.audiobook, "findMany");

            await audiobookCacheService.syncAll();

            expect(find.mock.calls[0][0]).toMatchObject({ take: 500, orderBy: { id: "asc" } });
            expect((find.mock.calls[1][0] as { where?: { id?: { gt?: string } } }).where?.id?.gt).toEqual(expect.any(String));
        });

        it("keeps the books ABS still lists, wherever they fall among the pages", async () => {
            await seedMany();
            const live = [0, 499, 500, 501, 1099].map((i) => `bulk-${String(i).padStart(4, "0")}`);
            (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue(live.map((id) => minimalBook(id, id)));
            jest.spyOn(audiobookCacheService as any, "syncAudiobook").mockResolvedValue(true);

            const result = await audiobookCacheService.syncAll();

            expect(await ids()).toEqual(live.map((id) => `${P}${id}`));
            expect(result.pruned).toBe(STORED - live.length);
        });

        it("stops between pages when told to stop: what was deleted stays deleted, the rest is left for the next sync", async () => {
            await seedMany();
            (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([minimalBook("keep-me", "Keeper")]);
            jest.spyOn(audiobookCacheService as any, "syncAudiobook").mockResolvedValue(true);
            const prune = jest.spyOn(prisma.audiobook, "deleteMany");

            const result = await audiobookCacheService.syncAll({ shouldStop: () => prune.mock.calls.length >= 1 });

            expect(prune).toHaveBeenCalledTimes(1);
            expect(await prisma.audiobook.count()).toBe(STORED - 500);
            expect(result.pruned).toBe(500);
        });
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
