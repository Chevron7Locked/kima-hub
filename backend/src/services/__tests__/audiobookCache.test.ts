/**
 * syncAll refreshes `sortName` from `title` on both create and update, since
 * `GET /audiobooks` orders on it and titles can change upstream.
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

const P = "zz-audiobookCache-";

// The prune pass deletes every row not in the stub's list, so a file starts and ends with no audiobooks.
async function wipe() {
    await prisma.audiobook.deleteMany({});
}
beforeAll(wipe);
afterAll(wipe);

// No cover data on the fixture books below, so getFullCoverUrl/downloadCover
// are never reached -- only ensureCoverCacheDir needs stubbing.
beforeEach(async () => {
    await wipe();
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
    it("sets sortName, article-stripped, when the book is first stored and when its title changes", async () => {
        const stub = audiobookshelfService.getAllAudiobooks as jest.Mock;

        stub.mockResolvedValue([minimalBook(`${P}book-1`, "The Great Book")]);
        await audiobookCacheService.syncAll();
        expect(await prisma.audiobook.findUnique({ where: { id: `${P}book-1` } })).toMatchObject({
            title: "The Great Book",
            sortName: "great book",
        });

        stub.mockResolvedValue([minimalBook(`${P}book-1`, "A Better Title")]);
        await audiobookCacheService.syncAll();
        expect(await prisma.audiobook.findUnique({ where: { id: `${P}book-1` } })).toMatchObject({
            title: "A Better Title",
            sortName: "better title",
        });
    });

    it("leaves a title with no leading article unchanged", async () => {
        (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue([
            minimalBook(`${P}book-2`, "Dune"),
        ]);

        await audiobookCacheService.syncAll();

        expect((await prisma.audiobook.findUnique({ where: { id: `${P}book-2` } }))?.sortName).toBe("dune");
    });
});
