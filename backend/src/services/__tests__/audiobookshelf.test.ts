// p-limit is pure ESM; mock it with a pass-through before any import.
jest.mock("p-limit", () => {
    return () => (fn: (...args: any[]) => any) => fn();
});

jest.mock("../../utils/db", () => ({
    prisma: {
        audiobook: {
            findMany: jest.fn().mockResolvedValue([]),
            upsert: jest.fn().mockResolvedValue({}),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

import { audiobookshelfService } from "../audiobookshelf";
import { logger } from "../../utils/logger";

const multiTrackBook = {
    media: {
        tracks: [
            { index: 2, startOffset: 1200, duration: 1200, contentUrl: "/abs/t2" },
            { index: 3, startOffset: 2400, duration: 1200, contentUrl: "/abs/t3" },
            { index: 1, startOffset: 0, duration: 1200, contentUrl: "/abs/t1" },
        ],
        numTracks: 3,
    },
};

function setupClient(response: object = { data: "stream-data", headers: {}, status: 200 }) {
    (audiobookshelfService as any).client = {
        get: jest.fn().mockResolvedValue(response),
    };
    return (audiobookshelfService as any).client;
}

beforeEach(() => {
    jest.spyOn(audiobookshelfService as any, "ensureInitialized").mockResolvedValue(undefined);
    // Clear the track cache so each test starts cold.
    (audiobookshelfService as any).trackCache.clear();
});

afterEach(() => jest.restoreAllMocks());

// ── Track resolution (1-based index) ──────────────────────────────────────────

describe("streamAudiobook track resolution", () => {
    beforeEach(() => {
        jest.spyOn(audiobookshelfService as any, "getAudiobook").mockResolvedValue(multiTrackBook);
        setupClient();
    });

    it("resolves trackIndex=1 to the track with index 1, not array position 1", async () => {
        const client = setupClient();
        await audiobookshelfService.streamAudiobook("book-1", undefined, 1);
        expect(client.get).toHaveBeenCalledWith("/abs/t1", expect.any(Object));
    });

    it("resolves trackIndex=3 to the track with index 3", async () => {
        const client = setupClient();
        await audiobookshelfService.streamAudiobook("book-1", undefined, 3);
        expect(client.get).toHaveBeenCalledWith("/abs/t3", expect.any(Object));
    });

    it("falls back to first track and warns when supplied trackIndex is not found", async () => {
        const client = setupClient();
        const warnSpy = logger.warn as jest.Mock;
        await audiobookshelfService.streamAudiobook("book-1", undefined, 99);
        expect(client.get).toHaveBeenCalledWith("/abs/t1", expect.any(Object));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("trackIndex=99"));
    });

    it("resolves first track without warning when trackIndex is not supplied", async () => {
        const client = setupClient();
        const warnSpy = logger.warn as jest.Mock;
        await audiobookshelfService.streamAudiobook("book-1", undefined, undefined);
        expect(client.get).toHaveBeenCalledWith("/abs/t1", expect.any(Object));
        expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("trackIndex"));
    });
});

// ── Track resolution cache: one getAudiobook call per TTL window ──────────────

describe("streamAudiobook track resolution cache", () => {
    it("calls getAudiobook once per book per TTL window across multiple seeks", async () => {
        const getAudiobookSpy = jest
            .spyOn(audiobookshelfService as any, "getAudiobook")
            .mockResolvedValue(multiTrackBook);
        setupClient();

        await audiobookshelfService.streamAudiobook("book-cache", undefined, 1);
        await audiobookshelfService.streamAudiobook("book-cache", undefined, 2);
        await audiobookshelfService.streamAudiobook("book-cache", undefined, 3);

        expect(getAudiobookSpy).toHaveBeenCalledTimes(1);
    });

    it("calls getAudiobook again after TTL expires", async () => {
        const getAudiobookSpy = jest
            .spyOn(audiobookshelfService as any, "getAudiobook")
            .mockResolvedValue(multiTrackBook);
        setupClient();

        await audiobookshelfService.streamAudiobook("book-ttl", undefined, 1);
        expect(getAudiobookSpy).toHaveBeenCalledTimes(1);

        // Manually age the cache entry past the TTL.
        const entry = (audiobookshelfService as any).trackCache.get("book-ttl");
        entry.fetchedAt = Date.now() - 6 * 60 * 1000; // 6 minutes ago

        await audiobookshelfService.streamAudiobook("book-ttl", undefined, 1);
        expect(getAudiobookSpy).toHaveBeenCalledTimes(2);
    });

    it("maintains separate cache entries for different books", async () => {
        const getAudiobookSpy = jest
            .spyOn(audiobookshelfService as any, "getAudiobook")
            .mockResolvedValue(multiTrackBook);
        setupClient();

        await audiobookshelfService.streamAudiobook("book-A", undefined, 1);
        await audiobookshelfService.streamAudiobook("book-B", undefined, 1);

        expect(getAudiobookSpy).toHaveBeenCalledTimes(2);

        // Subsequent calls to both hit the cache.
        await audiobookshelfService.streamAudiobook("book-A", undefined, 1);
        await audiobookshelfService.streamAudiobook("book-B", undefined, 1);
        expect(getAudiobookSpy).toHaveBeenCalledTimes(2);
    });
});

// ── Timeout: 15_000 on the stream request ─────────────────────────────────────

describe("streamAudiobook timeout", () => {
    it("passes timeout: 15_000 to the axios request", async () => {
        jest.spyOn(audiobookshelfService as any, "getAudiobook").mockResolvedValue(multiTrackBook);
        const client = setupClient();

        await audiobookshelfService.streamAudiobook("book-to", undefined, 1);

        expect(client.get).toHaveBeenCalledWith(
            "/abs/t1",
            expect.objectContaining({ timeout: 15_000 }),
        );
    });

    it("rejects when upstream returns a timeout error", async () => {
        jest.spyOn(audiobookshelfService as any, "getAudiobook").mockResolvedValue(multiTrackBook);

        // Simulate an axios timeout rejection (what axios emits when its own
        // timeout fires -- we verify the timeout value is 15_000 in the prior test).
        (audiobookshelfService as any).client = {
            get: jest.fn().mockRejectedValue(Object.assign(new Error("timeout"), { code: "ECONNABORTED" })),
        };

        await expect(
            audiobookshelfService.streamAudiobook("book-hang", undefined, 1),
        ).rejects.toThrow("timeout");
    });
});

// ── syncAudiobooksToCache: expanded fetch for missing/changed tracksJson ───────

describe("syncAudiobooksToCache expanded fetch", () => {
    const { prisma } = require("../../utils/db");

    const minifiedItem = (id: string, numTracks: number) => ({
        id,
        libraryId: "lib1",
        media: {
            metadata: { title: `Book ${id}`, authorName: "Author" },
            numTracks,
            duration: 3600,
        },
    });

    const expandedItem = (numTracks: number) => ({
        media: {
            numTracks,
            tracks: Array.from({ length: numTracks }, (_, i) => ({
                index: i + 1,
                startOffset: i * 1200,
                duration: 1200,
            })),
        },
    });

    beforeEach(() => {
        jest.spyOn(audiobookshelfService as any, "ensureInitialized").mockResolvedValue(undefined);
        jest.spyOn(audiobookshelfService as any, "getAllAudiobooks").mockResolvedValue([]);
        jest.spyOn(audiobookshelfService as any, "getAudiobook").mockResolvedValue(expandedItem(3));
        prisma.audiobook.findMany.mockResolvedValue([]);
        prisma.audiobook.upsert.mockResolvedValue({});
    });

    it("does not fetch expanded item when tracksJson is present and numTracks unchanged", async () => {
        const getAudiobookSpy = jest.spyOn(audiobookshelfService as any, "getAudiobook");
        jest.spyOn(audiobookshelfService as any, "getAllAudiobooks").mockResolvedValue([
            minifiedItem("book-ok", 3),
        ]);
        prisma.audiobook.findMany.mockResolvedValue([
            {
                id: "book-ok",
                numTracks: 3,
                tracksJson: [{ index: 1, startOffset: 0, duration: 1200 }],
                sectionsJson: [{ index: 1, title: "Part 1", start: 0 }],
            },
        ]);

        await audiobookshelfService.syncAudiobooksToCache();

        expect(getAudiobookSpy).not.toHaveBeenCalled();
    });

    it("fetches expanded item when tracksJson is NULL", async () => {
        const getAudiobookSpy = jest
            .spyOn(audiobookshelfService as any, "getAudiobook")
            .mockResolvedValue(expandedItem(3));
        jest.spyOn(audiobookshelfService as any, "getAllAudiobooks").mockResolvedValue([
            minifiedItem("book-null", 3),
        ]);
        prisma.audiobook.findMany.mockResolvedValue([
            { id: "book-null", numTracks: 3, tracksJson: null },
        ]);

        await audiobookshelfService.syncAudiobooksToCache();

        expect(getAudiobookSpy).toHaveBeenCalledWith("book-null");
    });

    it("fetches expanded item when numTracks changed", async () => {
        const getAudiobookSpy = jest
            .spyOn(audiobookshelfService as any, "getAudiobook")
            .mockResolvedValue(expandedItem(5));
        jest.spyOn(audiobookshelfService as any, "getAllAudiobooks").mockResolvedValue([
            minifiedItem("book-changed", 5),
        ]);
        prisma.audiobook.findMany.mockResolvedValue([
            {
                id: "book-changed",
                numTracks: 3,
                tracksJson: [{ index: 1, startOffset: 0, duration: 1200 }],
            },
        ]);

        await audiobookshelfService.syncAudiobooksToCache();

        expect(getAudiobookSpy).toHaveBeenCalledWith("book-changed");
    });

    it("persists tracksJson with 1-based indexes in {index,startOffset,duration} shape", async () => {
        jest.spyOn(audiobookshelfService as any, "getAllAudiobooks").mockResolvedValue([
            minifiedItem("book-shape", 2),
        ]);
        prisma.audiobook.findMany.mockResolvedValue([]);
        jest.spyOn(audiobookshelfService as any, "getAudiobook").mockResolvedValue(
            expandedItem(2),
        );

        await audiobookshelfService.syncAudiobooksToCache();

        const upsertCall = prisma.audiobook.upsert.mock.calls[0][0];
        const tracks = upsertCall.update.tracksJson;
        expect(tracks).toHaveLength(2);
        expect(tracks[0]).toMatchObject({ index: 1, startOffset: 0, duration: 1200 });
        expect(tracks[1]).toMatchObject({ index: 2, startOffset: 1200, duration: 1200 });
    });

    it("persists sectionsJson in the upsert with {index,title,start} shape", async () => {
        jest.spyOn(audiobookshelfService as any, "getAllAudiobooks").mockResolvedValue([
            minifiedItem("book-sections", 2),
        ]);
        prisma.audiobook.findMany.mockResolvedValue([]);
        jest.spyOn(audiobookshelfService as any, "getAudiobook").mockResolvedValue({
            media: {
                numTracks: 2,
                duration: 2400,
                tracks: [
                    { index: 1, startOffset: 0, duration: 1200 },
                    { index: 2, startOffset: 1200, duration: 1200 },
                ],
                audioFiles: [
                    { index: 1, metadata: { filename: "001 - Chapter One.mp3" } },
                    { index: 2, metadata: { filename: "002 - Chapter Two.mp3" } },
                ],
                chapters: [],
            },
        });

        await audiobookshelfService.syncAudiobooksToCache();

        const upsertCall = prisma.audiobook.upsert.mock.calls[0][0];
        const sections = upsertCall.update.sectionsJson;
        expect(sections).toHaveLength(2);
        expect(sections[0]).toMatchObject({ index: 1, title: "Chapter One", start: 0 });
        expect(sections[1]).toMatchObject({ index: 2, title: "Chapter Two", start: 1200 });
    });

    it("derives section titles from audioFiles filenames (Part NNN pattern)", async () => {
        jest.spyOn(audiobookshelfService as any, "getAllAudiobooks").mockResolvedValue([
            minifiedItem("book-partnames", 2),
        ]);
        prisma.audiobook.findMany.mockResolvedValue([]);
        jest.spyOn(audiobookshelfService as any, "getAudiobook").mockResolvedValue({
            media: {
                numTracks: 2,
                duration: 3600,
                tracks: [
                    { index: 1, startOffset: 0, duration: 1800 },
                    { index: 2, startOffset: 1800, duration: 1800 },
                ],
                audioFiles: [
                    { index: 1, metadata: { filename: "Part 001.mp3" } },
                    { index: 2, metadata: { filename: "Part 002.mp3" } },
                ],
                chapters: [],
            },
        });

        await audiobookshelfService.syncAudiobooksToCache();

        const upsertCall = prisma.audiobook.upsert.mock.calls[0][0];
        const sections = upsertCall.update.sectionsJson;
        expect(sections[0].title).toBe("Part 001");
        expect(sections[1].title).toBe("Part 002");
    });

    it("calls getAudiobook for each book that needs an expanded fetch", async () => {
        const expandSpy = jest
            .spyOn(audiobookshelfService as any, "getAudiobook")
            .mockImplementation(async () => expandedItem(1));

        // 8 books, all needing an expanded fetch (no existing rows).
        const books = Array.from({ length: 8 }, (_, i) => minifiedItem(`book-${i}`, 1));
        jest.spyOn(audiobookshelfService as any, "getAllAudiobooks").mockResolvedValue(books);
        prisma.audiobook.findMany.mockResolvedValue([]);

        // p-limit is mocked as a pass-through in tests; verify each book's
        // getAudiobook was called (concurrency cap enforced in production).
        await audiobookshelfService.syncAudiobooksToCache();

        expect(expandSpy).toHaveBeenCalledTimes(8);
    });
});

// ── syncAudiobooksToCache: sortName kept in sync with title ────────────────────

describe("syncAudiobooksToCache sortName", () => {
    const { prisma } = require("../../utils/db");

    beforeEach(() => {
        jest.spyOn(audiobookshelfService as any, "ensureInitialized").mockResolvedValue(undefined);
        jest.spyOn(audiobookshelfService as any, "getAudiobook").mockResolvedValue({ media: {} });
        prisma.audiobook.findMany.mockResolvedValue([]);
        prisma.audiobook.upsert.mockResolvedValue({});
    });

    // `sharedData` is one object reused for both the `create` and `update`
    // branches of the upsert, so a single call proves both at once -- unlike
    // audiobookCache.ts's upsert, which has two separate object literals and
    // needs both checked independently (see audiobookCache.test.ts).
    it("derives sortName from title, article-stripped, for both upsert branches", async () => {
        jest.spyOn(audiobookshelfService as any, "getAllAudiobooks").mockResolvedValue([
            {
                id: "book-article",
                libraryId: "lib1",
                media: { metadata: { title: "The Great Book", authorName: "Author" }, numTracks: 0 },
            },
        ]);

        await audiobookshelfService.syncAudiobooksToCache();

        const upsertCall = prisma.audiobook.upsert.mock.calls[0][0];
        expect(upsertCall.update).toMatchObject({ title: "The Great Book", sortName: "great book" });
        expect(upsertCall.create).toMatchObject({ title: "The Great Book", sortName: "great book" });
    });

    it("leaves a title with no leading article unchanged", async () => {
        jest.spyOn(audiobookshelfService as any, "getAllAudiobooks").mockResolvedValue([
            {
                id: "book-noarticle",
                libraryId: "lib1",
                media: { metadata: { title: "Dune", authorName: "Author" }, numTracks: 0 },
            },
        ]);

        await audiobookshelfService.syncAudiobooksToCache();

        const upsertCall = prisma.audiobook.upsert.mock.calls[0][0];
        expect(upsertCall.update.sortName).toBe("dune");
        expect(upsertCall.create.sortName).toBe("dune");
    });
});
