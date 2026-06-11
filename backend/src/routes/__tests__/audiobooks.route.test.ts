/**
 * Audiobooks Route Tests -- spec 1.10
 *
 * Covers:
 * - List (GET /) and series (GET /series/:name): tracks + trackCount present
 *   when DB row has tracksJson; NULL numTracks -> trackCount absent, never 0/1.
 * - Detail (GET /:id): ABS failure + DB cache -> tracks from DB; ABS failure
 *   + no DB cache -> tracksUnavailable:true, no tracks array.
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
        getAudiobook: jest.fn(),
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
import { audiobookshelfService } from "../../services/audiobookshelf";
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

const bookRow = {
    id: "abs-book-1",
    title: "The Fellowship",
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
};

const bookRowNullTracks = {
    ...bookRow,
    id: "abs-book-2",
    numTracks: null,
    tracksJson: null,
};

// ── GET / (list) ──────────────────────────────────────────────────────────────

describe("GET /audiobooks", () => {
    const app = createApp();

    beforeEach(() => {
        (getSystemSettings as jest.Mock).mockResolvedValue(enabledSettings);
        (prisma.audiobookProgress.findMany as jest.Mock).mockResolvedValue([]);
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

    it("returns tracks from DB when ABS is unreachable and DB has tracksJson", async () => {
        (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue(bookRow);
        (audiobookshelfService.getAudiobook as jest.Mock).mockRejectedValue(
            new Error("connection refused"),
        );

        const res = await request(app).get("/audiobooks/abs-book-1");

        expect(res.status).toBe(200);
        expect(res.body.tracks).toEqual(tracksFixture);
        expect(res.body.tracksUnavailable).toBeUndefined();
    });

    it("returns tracksUnavailable:true when ABS is unreachable and DB has no tracksJson", async () => {
        (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue(bookRowNullTracks);
        (audiobookCacheService.getAudiobook as jest.Mock).mockResolvedValue(bookRowNullTracks);
        (audiobookshelfService.getAudiobook as jest.Mock).mockRejectedValue(
            new Error("connection refused"),
        );

        const res = await request(app).get("/audiobooks/abs-book-2");

        expect(res.status).toBe(200);
        expect(res.body.tracksUnavailable).toBe(true);
        expect(res.body.tracks).toBeUndefined();
    });

    it("returns tracks from live ABS when available", async () => {
        const liveTracks = [
            { index: 1, startOffset: 0, duration: 600, contentUrl: "/abs/t1" },
        ];
        (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue(bookRowNullTracks);
        (audiobookshelfService.getAudiobook as jest.Mock).mockResolvedValue({
            media: { chapters: [], audioFiles: [], tracks: liveTracks },
        });

        const res = await request(app).get("/audiobooks/abs-book-2");

        expect(res.status).toBe(200);
        expect(res.body.tracks).toHaveLength(1);
        expect(res.body.tracks[0].index).toBe(1);
        expect(res.body.tracksUnavailable).toBeUndefined();
    });

    it("includes trackCount from numTracks when present", async () => {
        (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue(bookRow);
        (audiobookshelfService.getAudiobook as jest.Mock).mockResolvedValue({
            media: { chapters: [], audioFiles: [], tracks: [] },
        });

        const res = await request(app).get("/audiobooks/abs-book-1");

        expect(res.status).toBe(200);
        expect(res.body.trackCount).toBe(2);
    });

    it("omits trackCount when numTracks is NULL", async () => {
        (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue(bookRowNullTracks);
        (audiobookCacheService.getAudiobook as jest.Mock).mockResolvedValue(bookRowNullTracks);
        (audiobookshelfService.getAudiobook as jest.Mock).mockResolvedValue({
            media: { chapters: [], audioFiles: [], tracks: [] },
        });

        const res = await request(app).get("/audiobooks/abs-book-2");

        expect(res.status).toBe(200);
        expect(res.body).not.toHaveProperty("trackCount");
    });
});
