/**
 * Audiobooks Route Tests -- spec 1.10 + sections remediation
 *
 * Covers:
 * - List (GET /) and series (GET /series/:name): tracks + trackCount present
 *   when DB row has tracksJson; NULL numTracks -> trackCount absent, never 0/1.
 * - Detail (GET /:id): cache-only response with sections + tracks from DB;
 *   null sectionsJson triggers audiobookCacheService resync.
 */

// All mocks before imports.

jest.mock("../../utils/db", () => ({
    prisma: {
        audiobook: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
        },
        audiobookProgress: {
            findMany: jest.fn().mockResolvedValue([]),
            findUnique: jest.fn().mockResolvedValue(null),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../utils/errors", () => ({
    safeError: jest.fn((res: any, _msg: string, err: any) => {
        res.status(500).json({ error: String(err) });
    }),
}));

jest.mock("../../services/audiobookshelf", () => ({
    audiobookshelfService: {
        getAllAudiobooks: jest.fn(),
        searchAudiobooks: jest.fn(),
        streamAudiobook: jest.fn(),
        updateProgress: jest.fn(),
    },
}));

jest.mock("../../services/audiobookCache", () => ({
    audiobookCacheService: {
        getAudiobook: jest.fn(),
        syncAll: jest.fn(),
    },
}));

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "user-1", username: "tester", role: "user" };
        next();
    },
}));

jest.mock("../../middleware/rateLimiter", () => ({
    apiLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../services/notificationService", () => ({
    notificationService: { notifySystem: jest.fn() },
}));

jest.mock("../../config", () => ({
    config: {
        music: { musicPath: "/music" },
    },
}));

import express from "express";
import request from "supertest";
import audiobooksRoutes from "../audiobooks";
import { prisma } from "../../utils/db";
import { getSystemSettings } from "../../utils/systemSettings";
import { audiobookCacheService } from "../../services/audiobookCache";

function createApp() {
    const app = express();
    app.use(express.json());
    app.use("/audiobooks", audiobooksRoutes);
    return app;
}

const enabledSettings = { audiobookshelfEnabled: true };

const tracksFixture = [
    { index: 1, startOffset: 0, duration: 1200 },
    { index: 2, startOffset: 1200, duration: 1200 },
];

const sectionsFixture = [
    { index: 1, title: "Part 1", start: 0 },
    { index: 2, title: "Part 2", start: 1200 },
];

const bookRow = {
    id: "abs-book-1",
    title: "The Fellowship",
    sortName: "fellowship",
    author: "Tolkien",
    narrator: "Andy Serkis",
    description: "desc",
    coverUrl: null,
    localCoverPath: null,
    duration: 2400,
    libraryId: "lib1",
    series: "Lord of the Rings",
    seriesSequence: "1",
    genres: [],
    lastSyncedAt: new Date(),
    numTracks: 2,
    tracksJson: tracksFixture,
    sectionsJson: sectionsFixture,
};

const bookRowNullTracks = {
    ...bookRow,
    id: "abs-book-2",
    numTracks: null,
    tracksJson: null,
    sectionsJson: null,
};

// ── GET / (list) ──────────────────────────────────────────────────────────────

describe("GET /audiobooks", () => {
    const app = createApp();

    beforeEach(() => {
        (getSystemSettings as jest.Mock).mockResolvedValue(enabledSettings);
        (prisma.audiobookProgress.findMany as jest.Mock).mockResolvedValue([]);
    });

    // sortName, not title -- "The Hobbit" used to file under T. Kept in sync
    // at write time in audiobookCache.ts and audiobookshelf.ts, same as
    // Artist.sortName and Album.sortName.
    it("orders the list on sortName, not title", async () => {
        (prisma.audiobook.findMany as jest.Mock).mockResolvedValue([]);

        await request(app).get("/audiobooks");

        expect(prisma.audiobook.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { sortName: "asc" } }),
        );
    });

    // The query being ordered on sortName (above) proves nothing about the
    // response body -- the DTO is a hand-built object literal, not a spread,
    // so a field the query fetches is not automatically one the client
    // receives. The client-side series-mode fallback (see
    // useAudiobookLibrary.test.tsx) depends on this actually being present.
    it("includes sortName in the response body", async () => {
        (prisma.audiobook.findMany as jest.Mock).mockResolvedValue([bookRow]);

        const res = await request(app).get("/audiobooks");

        expect(res.body[0].sortName).toBe("fellowship");
    });

    // The series NAME is sorted client-side too, and has no stored column --
    // it is computed per response by the same `artistSortName` the write path
    // uses. Without it the series view files "The Lord of the Rings" under T
    // while the same library sorts "The Fellowship" under F one tab over.
    it("includes an article-stripped sortName on the series object", async () => {
        (prisma.audiobook.findMany as jest.Mock).mockResolvedValue([
            { ...bookRow, series: "The Lord of the Rings" },
        ]);

        const res = await request(app).get("/audiobooks");

        expect(res.body[0].series).toEqual(
            expect.objectContaining({
                name: "The Lord of the Rings",
                sortName: "lord of the rings",
            }),
        );
    });

    it("includes tracks and trackCount for a row with tracksJson", async () => {
        (prisma.audiobook.findMany as jest.Mock).mockResolvedValue([bookRow]);

        const res = await request(app).get("/audiobooks");

        expect(res.status).toBe(200);
        const book = res.body[0];
        expect(book.tracks).toEqual(tracksFixture);
        expect(book.trackCount).toBe(2);
    });

    it("omits tracks and trackCount when tracksJson and numTracks are NULL", async () => {
        (prisma.audiobook.findMany as jest.Mock).mockResolvedValue([bookRowNullTracks]);

        const res = await request(app).get("/audiobooks");

        expect(res.status).toBe(200);
        const book = res.body[0];
        expect(book.tracks).toBeUndefined();
        expect(book.trackCount).toBeUndefined();
        expect(book).not.toHaveProperty("trackCount");
    });

    it("never coerces NULL numTracks to 0 or 1", async () => {
        (prisma.audiobook.findMany as jest.Mock).mockResolvedValue([bookRowNullTracks]);

        const res = await request(app).get("/audiobooks");
        const book = res.body[0];

        expect(book.trackCount).not.toBe(0);
        expect(book.trackCount).not.toBe(1);
        expect(book.trackCount).toBeUndefined();
    });
});

// ── GET /series/:name ─────────────────────────────────────────────────────────

describe("GET /audiobooks/series/:seriesName", () => {
    const app = createApp();

    beforeEach(() => {
        (getSystemSettings as jest.Mock).mockResolvedValue(enabledSettings);
        (prisma.audiobookProgress.findMany as jest.Mock).mockResolvedValue([]);
    });

    it("includes tracks and trackCount for a row with tracksJson", async () => {
        (prisma.audiobook.findMany as jest.Mock).mockResolvedValue([bookRow]);

        const res = await request(app).get("/audiobooks/series/Lord%20of%20the%20Rings");

        expect(res.status).toBe(200);
        const book = res.body[0];
        expect(book.tracks).toEqual(tracksFixture);
        expect(book.trackCount).toBe(2);
    });

    it("omits trackCount when numTracks is NULL", async () => {
        (prisma.audiobook.findMany as jest.Mock).mockResolvedValue([bookRowNullTracks]);

        const res = await request(app).get("/audiobooks/series/Lord%20of%20the%20Rings");

        expect(res.status).toBe(200);
        const book = res.body[0];
        expect(book).not.toHaveProperty("trackCount");
    });
});

// ── GET /:id (detail) ─────────────────────────────────────────────────────────

describe("GET /audiobooks/:id", () => {
    const app = createApp();

    beforeEach(() => {
        (getSystemSettings as jest.Mock).mockResolvedValue(enabledSettings);
        (prisma.audiobookProgress.findUnique as jest.Mock).mockResolvedValue(null);
        (audiobookCacheService.getAudiobook as jest.Mock).mockResolvedValue(bookRow);
    });

    it("returns sections and tracks from DB cache without hitting ABS", async () => {
        (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue(bookRow);

        const res = await request(app).get("/audiobooks/abs-book-1");

        expect(res.status).toBe(200);
        expect(res.body.sections).toEqual(sectionsFixture);
        expect(res.body.tracks).toEqual(tracksFixture);
        expect(res.body.tracksUnavailable).toBeUndefined();
        expect(res.body.chapters).toBeUndefined();
        expect(res.body.audioFiles).toBeUndefined();
    });

    it("triggers resync via audiobookCacheService when sectionsJson is null", async () => {
        (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue(bookRowNullTracks);
        (audiobookCacheService.getAudiobook as jest.Mock).mockResolvedValue(bookRow);

        const res = await request(app).get("/audiobooks/abs-book-2");

        expect(res.status).toBe(200);
        expect(audiobookCacheService.getAudiobook).toHaveBeenCalledWith("abs-book-2");
        expect(res.body.sections).toEqual(sectionsFixture);
    });

    it("returns empty sections array when audiobookCacheService returns book with null sectionsJson", async () => {
        (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue(bookRowNullTracks);
        (audiobookCacheService.getAudiobook as jest.Mock).mockResolvedValue(bookRowNullTracks);

        const res = await request(app).get("/audiobooks/abs-book-2");

        expect(res.status).toBe(200);
        expect(res.body.sections).toEqual([]);
        expect(res.body.tracks).toEqual([]);
    });

    it("returns 404 when audiobook is not found after resync", async () => {
        (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue(null);
        (audiobookCacheService.getAudiobook as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get("/audiobooks/missing-id");

        expect(res.status).toBe(404);
    });

    it("includes trackCount from numTracks when present", async () => {
        (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue(bookRow);

        const res = await request(app).get("/audiobooks/abs-book-1");

        expect(res.status).toBe(200);
        expect(res.body.trackCount).toBe(2);
    });

    it("omits trackCount when numTracks is NULL", async () => {
        (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue(bookRowNullTracks);
        (audiobookCacheService.getAudiobook as jest.Mock).mockResolvedValue(bookRowNullTracks);

        const res = await request(app).get("/audiobooks/abs-book-2");

        expect(res.status).toBe(200);
        expect(res.body).not.toHaveProperty("trackCount");
    });
});
