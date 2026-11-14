/**
 * The audiobook list and series carry tracks and trackCount (absent, never 0, when numTracks is null). Detail is
 * served from the cache with sections and tracks, and resyncs when sectionsJson is null. Real router and database;
 * Audiobookshelf itself and the settings are stood in for.
 */

// All mocks before imports.

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../utils/errors", () => {
    const actual = jest.requireActual("../../utils/errors") as typeof errorsModule;
    return {
        ...actual,
        safeError: jest.fn((res: Response, _context: string, error: unknown) => {
            res.status(500).json({ error: String(error) });
        }),
    };
});

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

jest.mock("../../config", () => ({
    config: {
        music: { musicPath: "/music" },
    },
}));

import express from "express";
import request from "supertest";
import { UserFacingError } from "../../utils/errors";
import type * as errorsModule from "../../utils/errors";
import type { Response } from "express";
import { prisma } from "../../utils/db";
import { getSystemSettings } from "../../utils/systemSettings";
import { audiobookCacheService } from "../../services/audiobookCache";
import { audiobookshelfService } from "../../services/audiobookshelf";
import { whenRequestWorkEnded } from "../../utils/stopCheck";
import audiobooksRoutes from "../audiobooks";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";

function createApp() {
    const app = express();
    app.use(express.json());
    mountAsServer(app, "/audiobooks", audiobooksRoutes, "/api/audiobooks");
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

// Every row this file seeds has this prefix, so cleanup (and the list, which has no filter) can tell them apart.
const P = "abs_rt_";
const WITH_TRACKS = `${P}tracks`;
const NO_TRACKS = `${P}notracks`;

const row = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    title: id,
    sortName: id,
    audioUrl: `https://abs.invalid/${id}`,
    ...fields,
});

const fellowship = row(WITH_TRACKS, {
    title: "The Fellowship",
    sortName: "fellowship",
    author: "Tolkien",
    narrator: "Andy Serkis",
    description: "desc",
    duration: 2400,
    libraryId: "lib1",
    series: "Lord of the Rings",
    seriesSequence: "1",
    numTracks: 2,
    tracksJson: tracksFixture,
    sectionsJson: sectionsFixture,
});

// A row the cache has not filled in: no tracks, no sections.
const bare = row(NO_TRACKS, { title: "Bare", sortName: "bare", series: "Lord of the Rings", seriesSequence: "2" });

// What a resync answers with for the bare row.
const synced = { ...fellowship, id: NO_TRACKS };

const SERIES_NAMES = ["100% Hits", "Fifty%2FFifty", "A/B"];
const seriesId = (i: number) => `${P}series${i}`;

const ownRows = { where: { id: { startsWith: P } } };

beforeAll(async () => {
    await prisma.audiobook.deleteMany(ownRows);
    await prisma.audiobook.createMany({
        data: [
            fellowship,
            bare,
            // "The Hobbit" files under H; by title "Iliad" would come first.
            row(`${P}hobbit`, { title: "The Hobbit", sortName: "hobbit" }),
            row(`${P}iliad`, { title: "Iliad", sortName: "iliad" }),
            row(`${P}article`, { title: "x", series: "The Lord of the Rings", seriesSequence: "1" }),
            // Names that differ from each series only in what a loose match would let through.
            row(`${P}decoy1`, { series: "100" }),
            row(`${P}decoy2`, { series: "Fifty/Fifty" }),
            row(`${P}decoy3`, { series: "A" }),
            ...SERIES_NAMES.map((series, i) => row(seriesId(i), { series })),
        ],
    });
});

afterAll(async () => {
    await prisma.audiobook.deleteMany(ownRows);
});

const mine = (body: Array<{ id: string }>) => body.filter((b) => b.id.startsWith(P));

// ── GET / (list) ──────────────────────────────────────────────────────────────

describe("GET /audiobooks", () => {
    const app = createApp();

    beforeEach(() => {
        (getSystemSettings as jest.Mock).mockResolvedValue(enabledSettings);
    });

    // sortName is written by audiobookCache.ts and audiobookshelf.ts, like Artist.sortName and Album.sortName.
    it("orders the list on sortName, not title", async () => {
        const res = await request(app).get("/audiobooks");

        const ids = mine(res.body).map((b: { id: string }) => b.id);
        expect(ids.indexOf(`${P}hobbit`)).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf(`${P}hobbit`)).toBeLessThan(ids.indexOf(`${P}iliad`));
    });

    // The DTO is built by hand, so a field the query reads is not automatically
    // in the response; the client's series fallback needs sortName.
    it("includes sortName in the response body", async () => {
        const res = await request(app).get("/audiobooks");

        expect(res.body.find((b: { id: string }) => b.id === WITH_TRACKS).sortName).toBe("fellowship");
    });

    // The series NAME is sorted client-side too, and has no stored column --
    // it is computed per response by the same `artistSortName` the write path
    // uses. Without it the series view files "The Lord of the Rings" under T
    // while the same library sorts "The Fellowship" under F one tab over.
    it("includes an article-stripped sortName on the series object", async () => {
        const res = await request(app).get("/audiobooks");

        expect(res.body.find((b: { id: string }) => b.id === `${P}article`).series).toEqual(
            expect.objectContaining({
                name: "The Lord of the Rings",
                sortName: "lord of the rings",
            }),
        );
    });

    it("includes tracks and trackCount for a row with tracksJson", async () => {
        const res = await request(app).get("/audiobooks");

        expect(res.status).toBe(200);
        const book = res.body.find((b: { id: string }) => b.id === WITH_TRACKS);
        expect(book.tracks).toEqual(tracksFixture);
        expect(book.trackCount).toBe(2);
    });

    it("omits tracks and trackCount when tracksJson and numTracks are NULL", async () => {
        const res = await request(app).get("/audiobooks");

        expect(res.status).toBe(200);
        const book = res.body.find((b: { id: string }) => b.id === NO_TRACKS);
        expect(book.tracks).toBeUndefined();
        expect(book.trackCount).toBeUndefined();
        expect(book).not.toHaveProperty("trackCount");
    });
});

// ── GET /series/:name ─────────────────────────────────────────────────────────

describe("GET /audiobooks/series/:seriesName", () => {
    const app = createApp();

    beforeEach(() => {
        (getSystemSettings as jest.Mock).mockResolvedValue(enabledSettings);
    });

    it("lists the series' books in sequence, with tracks and trackCount for a row with tracksJson", async () => {
        const res = await request(app).get("/audiobooks/series/Lord%20of%20the%20Rings");

        expect(res.status).toBe(200);
        expect(res.body.map((b: { id: string }) => b.id)).toEqual([WITH_TRACKS, NO_TRACKS]);
        const book = res.body[0];
        expect(book.tracks).toEqual(tracksFixture);
        expect(book.trackCount).toBe(2);
    });

    it.each(SERIES_NAMES.map((name, i) => [name, i] as const))("looks up the series named %p as sent", async (name, i) => {
        const res = await request(app).get(`/audiobooks/series/${encodeURIComponent(name)}`);

        expect(res.status).toBe(200);
        expect(res.body.map((b: { id: string }) => b.id)).toEqual([seriesId(i)]);
    });

    it("omits trackCount when numTracks is NULL", async () => {
        const res = await request(app).get("/audiobooks/series/Lord%20of%20the%20Rings");

        expect(res.status).toBe(200);
        const book = res.body.find((b: { id: string }) => b.id === NO_TRACKS);
        expect(book).not.toHaveProperty("trackCount");
    });
});

// ── GET /:id (detail) ─────────────────────────────────────────────────────────

describe("GET /audiobooks/:id", () => {
    const app = createApp();

    beforeEach(() => {
        jest.clearAllMocks();
        (getSystemSettings as jest.Mock).mockResolvedValue(enabledSettings);
        (audiobookCacheService.getAudiobook as jest.Mock).mockResolvedValue(synced);
    });

    it("returns sections and tracks from DB cache without hitting ABS", async () => {
        const res = await request(app).get(`/audiobooks/${WITH_TRACKS}`);

        expect(res.status).toBe(200);
        expect(res.body.sections).toEqual(sectionsFixture);
        expect(res.body.tracks).toEqual(tracksFixture);
        expect(res.body.tracksUnavailable).toBeUndefined();
        expect(res.body.chapters).toBeUndefined();
        expect(res.body.audioFiles).toBeUndefined();
        expect(audiobookCacheService.getAudiobook).not.toHaveBeenCalled();
    });

    it("triggers resync via audiobookCacheService when sectionsJson is null", async () => {
        const res = await request(app).get(`/audiobooks/${NO_TRACKS}`);

        expect(res.status).toBe(200);
        expect(audiobookCacheService.getAudiobook).toHaveBeenCalledWith(NO_TRACKS);
        expect(res.body.sections).toEqual(sectionsFixture);
    });

    it("returns empty sections array when audiobookCacheService returns book with null sectionsJson", async () => {
        (audiobookCacheService.getAudiobook as jest.Mock).mockResolvedValue(await prisma.audiobook.findUnique({ where: { id: NO_TRACKS } }));

        const res = await request(app).get(`/audiobooks/${NO_TRACKS}`);

        expect(res.status).toBe(200);
        expect(res.body.sections).toEqual([]);
        expect(res.body.tracks).toEqual([]);
    });

    it("returns 404 when audiobook is not found after resync", async () => {
        (audiobookCacheService.getAudiobook as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get(`/audiobooks/${P}missing`);

        expect(res.status).toBe(404);
        expect(audiobookCacheService.getAudiobook).toHaveBeenCalledWith(`${P}missing`);
    });

    it("includes trackCount from numTracks when present", async () => {
        const res = await request(app).get(`/audiobooks/${WITH_TRACKS}`);

        expect(res.status).toBe(200);
        expect(res.body.trackCount).toBe(2);
    });

    it("omits trackCount when numTracks is NULL", async () => {
        (audiobookCacheService.getAudiobook as jest.Mock).mockResolvedValue(await prisma.audiobook.findUnique({ where: { id: NO_TRACKS } }));

        const res = await request(app).get(`/audiobooks/${NO_TRACKS}`);

        expect(res.status).toBe(200);
        expect(res.body).not.toHaveProperty("trackCount");
    });
});

// ── GET /continue-listening ───────────────────────────────────────────────────

describe("GET /audiobooks/continue-listening", () => {
    const app = createApp();
    const BOOK = `${P}cl_book`;
    const GONE = `${P}cl_gone`;
    const PLAIN = `${P}cl_plain`;
    let createdUser = false;

    beforeAll(async () => {
        createdUser = !(await prisma.user.findUnique({ where: { id: "user-1" } }));
        await prisma.user.upsert({ where: { id: "user-1" }, create: { id: "user-1", username: `${P}cl_user`, passwordHash: "x" }, update: {} });
        await prisma.audiobook.createMany({
            data: [
                row(BOOK, { coverUrl: "items/cl/cover", coverVersion: "c0ffee1234" }),
                row(PLAIN, { coverUrl: "items/plain/cover" }),
            ],
        });
        for (const id of [BOOK, GONE, PLAIN]) {
            await prisma.audiobookProgress.create({
                data: { userId: "user-1", audiobookshelfId: id, title: id, coverUrl: "items/cl/cover", currentTime: 60, duration: 600 },
            });
        }
    });
    afterAll(async () => {
        await prisma.audiobookProgress.deleteMany({ where: { audiobookshelfId: { startsWith: `${P}cl_` } } });
        await prisma.audiobook.deleteMany({ where: { id: { startsWith: `${P}cl_` } } });
        if (createdUser) await prisma.user.deleteMany({ where: { id: "user-1" } });
    });
    beforeEach(() => {
        (getSystemSettings as jest.Mock).mockResolvedValue(enabledSettings);
    });

    const cards = async () => {
        const res = await request(app).get("/audiobooks/continue-listening");
        expect(res.status).toBe(200);
        return res.body as { audiobookshelfId: string; coverUrl: string | null }[];
    };

    it("shows a book's cover by the versioned address every other audiobook list uses", async () => {
        expect((await cards()).find((c) => c.audiobookshelfId === BOOK)?.coverUrl).toBe(`/audiobooks/${BOOK}/cover/c0ffee1234`);
    });

    it("shows a book whose version is not known yet by the address without one", async () => {
        expect((await cards()).find((c) => c.audiobookshelfId === PLAIN)?.coverUrl).toBe(`/audiobooks/${PLAIN}/cover`);
    });

    it("sends no audiobook__ value, whether the book is still in the library or not", async () => {
        const all = await cards();
        expect(all.map((c) => c.coverUrl).filter((u) => u?.startsWith("audiobook__"))).toEqual([]);
        expect(all.find((c) => c.audiobookshelfId === GONE)?.coverUrl).toBeNull();
    });
});

// ── POST /sync ──────────────────────────────────────────────────────────────────

describe("POST /audiobooks/sync", () => {
    const app = createApp();

    beforeEach(() => {
        (getSystemSettings as jest.Mock).mockResolvedValue(enabledSettings);
        (audiobookCacheService.syncAll as jest.Mock).mockResolvedValue({
            synced: 3,
            failed: 0,
            skipped: 0,
            errors: [],
        });
    });

    it("returns 200 on successful sync", async () => {
        const res = await request(app).post("/audiobooks/sync");

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.result.synced).toBe(3);
    });

    it("is work the shutdown waits for, with the stop check handed to the sync", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        (audiobookCacheService.syncAll as jest.Mock).mockImplementation(async () => {
            await held;
            return { synced: 1, failed: 0, skipped: 0, errors: [] };
        });

        const responding = request(app).post("/audiobooks/sync").then((res) => res);
        for (let i = 0; i < 200 && (audiobookCacheService.syncAll as jest.Mock).mock.calls.length === 0; i++) {
            await new Promise((r) => setImmediate(r));
        }
        expect(audiobookCacheService.syncAll).toHaveBeenCalledWith({ shouldStop: expect.any(Function) });

        let drained = false;
        const waiting = whenRequestWorkEnded().then(() => (drained = true));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(drained).toBe(false);

        release();
        await waiting;
        expect((await responding).status).toBe(200);
        expect(drained).toBe(true);
    });

    it("returns 400 when Audiobookshelf is not configured", async () => {
        expectLog("error");
        (audiobookCacheService.syncAll as jest.Mock).mockRejectedValue(
            new UserFacingError("Audiobookshelf is not configured — add the server URL and API key in Settings"),
        );

        const res = await request(app).post("/audiobooks/sync");

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain("not configured");
    });

    it("returns 400 when Audiobookshelf rejects credentials (401)", async () => {
        expectLog("error");
        const absError = Object.assign(new Error("Unauthorized"), {
            response: { status: 401 },
        });
        (audiobookCacheService.syncAll as jest.Mock).mockRejectedValue(absError);

        const res = await request(app).post("/audiobooks/sync");

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain("rejected the stored credentials");
    });

    it("returns 400 when Audiobookshelf rejects credentials (403)", async () => {
        expectLog("error");
        const absError = Object.assign(new Error("Forbidden"), {
            response: { status: 403 },
        });
        (audiobookCacheService.syncAll as jest.Mock).mockRejectedValue(absError);

        const res = await request(app).post("/audiobooks/sync");

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain("rejected the stored credentials");
    });

    it("returns 502 for other upstream status codes", async () => {
        expectLog("error");
        const absError = Object.assign(new Error("Bad Gateway"), {
            response: { status: 502 },
        });
        (audiobookCacheService.syncAll as jest.Mock).mockRejectedValue(absError);

        const res = await request(app).post("/audiobooks/sync");

        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain("Audiobookshelf returned status 502");
    });

    it("returns 500 without internal details for genuine internal errors", async () => {
        expectLog("error");
        (audiobookCacheService.syncAll as jest.Mock).mockRejectedValue(
            new Error("EACCES: permission denied, mkdir '/data/covers/audiobooks'"),
        );

        const res = await request(app).post("/audiobooks/sync");

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe("Audiobook sync failed");
    });
});


describe("an audiobook id", () => {
    const app = createApp();
    beforeEach(() => {
        jest.clearAllMocks();
        (getSystemSettings as jest.Mock).mockResolvedValue(enabledSettings);
    });

    // The id goes into Audiobookshelf requests made with its key; Express decodes %2F, so a crafted id could aim them
    // elsewhere. Audiobookshelf ids are letters, digits, "_" and "-".
    it.each([
        ["get", "/audiobooks/..%2Fusers%3F"],
        ["get", "/audiobooks/..%2Fusers%3F/stream"],
        ["post", "/audiobooks/..%2Fme%3F/progress"],
        ["delete", "/audiobooks/..%2Fme%3F/progress"],
        ["get", "/audiobooks/..%2F..%2Fx/cover"],
    ] as const)("that is not one is refused at %s %s before Audiobookshelf is asked", async (method, path) => {
        const res = await request(app)[method](path).send({ currentTime: 1, duration: 2 });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Audiobook not found" });
        expect(audiobookshelfService.streamAudiobook).not.toHaveBeenCalled();
        expect(audiobookshelfService.updateProgress).not.toHaveBeenCalled();
        expect(audiobookCacheService.getAudiobook).not.toHaveBeenCalled();
    });
});
