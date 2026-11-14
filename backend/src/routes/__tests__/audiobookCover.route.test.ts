/**
 * GET /audiobooks/:id/cover is unauthenticated and must not serve a file outside
 * the covers folder; Express decodes %2F in a param after matching. A real file
 * outside the root is planted and requested. Real router and database.
 */

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue(null),
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
    audiobookCacheService: { getAudiobook: jest.fn(), syncAll: jest.fn() },
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
        music: {
            musicPath: require("path").join(require("os").tmpdir(), `kima-cover-music-${process.pid}`),
        },
    },
}));

import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import audiobookRoutes from "../../routes/audiobooks";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { getSystemSettings } from "../../utils/systemSettings";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";

const BOOK = "cover_rt_book";
const MUSIC = config.music.musicPath;
const ALBUM_COVER = path.join(MUSIC, "Artist", "Album", "cover.jpg");
const ALBUM_COVER_BODY = "an album cover inside the music folder";

// Where a path that escapes the music root would land: the route appends ".jpg" itself.
const PROBE_BODY = "if you can read this, the traversal worked";
const probeFile = path.join(os.tmpdir(), `kima-cover-traversal-${process.pid}.jpg`);

/**
 * The id that reaches outside. Built from the real temp path rather than
 * hardcoded, so this works wherever os.tmpdir() points. encodeURIComponent
 * turns the separators into %2F, which is the whole trick: Express matches
 * `/:id/cover` on the still-encoded segment, then decodes it for the handler.
 */
function traversingId(): string {
    const withoutExt = probeFile.replace(/\.jpg$/, "");
    const relative = path.relative(path.join(MUSIC, "cover-cache", "audiobooks"), withoutExt);
    return encodeURIComponent(relative);
}

function makeApp() {
    const app = express();
    app.use(express.json());
    mountAsServer(app, "/", audiobookRoutes, "/api/audiobooks");
    return app;
}

describe("GET /audiobooks/:id/cover", () => {
    let app: express.Application;

    beforeAll(async () => {
        app = makeApp();
        await prisma.audiobook.deleteMany({ where: { id: BOOK } });
        await prisma.audiobook.create({ data: { id: BOOK, title: "Book", audioUrl: "https://abs.invalid/book" } });
        fs.writeFileSync(probeFile, PROBE_BODY);
        fs.mkdirSync(path.dirname(ALBUM_COVER), { recursive: true });
        fs.writeFileSync(ALBUM_COVER, ALBUM_COVER_BODY);
    });

    afterAll(async () => {
        await prisma.audiobook.deleteMany({ where: { id: BOOK } });
        fs.rmSync(probeFile, { force: true });
        fs.rmSync(MUSIC, { recursive: true, force: true });
    });

    it("refuses an id that escapes the music root, and does not serve the file", async () => {
        // The file really exists and really is readable by this process.
        expect(fs.existsSync(probeFile)).toBe(true);

        const res = await request(app).get(`/${traversingId()}/cover`);

        // 404 is the route's own "no cover available" answer, reached because
        // the guard refused the path rather than because the file was missing.
        expect(res.status).toBe(404);
        expect(res.text).not.toContain(PROBE_BODY);
    });

    it("does not record an out-of-root path back onto the audiobook row", async () => {
        await request(app).get(`/${traversingId()}/cover`);

        // Nothing was recorded, and the same route does record a cover that is inside the root.
        expect((await prisma.audiobook.findUnique({ where: { id: BOOK } }))?.localCoverPath).toBeNull();
        expect(await prisma.audiobook.count({ where: { localCoverPath: { contains: path.basename(probeFile) } } })).toBe(0);
    });

    it("records a cover found inside the covers folder back onto the audiobook row", async () => {
        const inside = path.join(MUSIC, "cover-cache", "audiobooks", `${BOOK}.jpg`);
        fs.mkdirSync(path.dirname(inside), { recursive: true });
        fs.writeFileSync(inside, "a cover inside the covers folder");

        const res = await request(app).get(`/${BOOK}/cover`);

        expect(res.status).toBe(200);
        expect(res.body.toString()).toBe("a cover inside the covers folder");
        expect((await prisma.audiobook.findUnique({ where: { id: BOOK } }))?.localCoverPath).toBe(inside);
        await prisma.audiobook.update({ where: { id: BOOK }, data: { localCoverPath: null } });
        fs.rmSync(inside);
    });

    it("asks the client to revalidate a stored cover, so a changed cover is sent again and an unchanged one is not", async () => {
        const inside = path.join(MUSIC, "cover-cache", "audiobooks", `${BOOK}.jpg`);
        fs.mkdirSync(path.dirname(inside), { recursive: true });
        fs.writeFileSync(inside, "a cover");

        const first = await request(app).get(`/${BOOK}/cover`);
        expect(first.headers["cache-control"]).toBe("public, no-cache");
        expect(first.headers["cache-control"]).not.toContain("immutable");

        const again = await request(app).get(`/${BOOK}/cover`).set("If-None-Match", first.headers.etag);
        expect(again.status).toBe(304);

        fs.writeFileSync(inside, "a changed cover");
        const changed = await request(app).get(`/${BOOK}/cover`).set("If-None-Match", first.headers.etag);
        expect(changed.status).toBe(200);
        expect(changed.body.toString()).toBe("a changed cover");
        await prisma.audiobook.update({ where: { id: BOOK }, data: { localCoverPath: null } });
        fs.rmSync(inside);
    });

    it("with a version in its address is kept for good, and found without it", async () => {
        const inside = path.join(MUSIC, "cover-cache", "audiobooks", `${BOOK}.jpg`);
        fs.mkdirSync(path.dirname(inside), { recursive: true });
        fs.writeFileSync(inside, "a versioned cover");

        const res = await request(app).get(`/${BOOK}/cover/lq3k9x`);

        expect(res.status).toBe(200);
        expect(res.body.toString()).toBe("a versioned cover");
        expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
        await prisma.audiobook.update({ where: { id: BOOK }, data: { localCoverPath: null } });
        fs.rmSync(inside);
    });

    it("answers the preflight for an address with a version too", async () => {
        const res = await request(app).options(`/${BOOK}/cover/lq3k9x`);
        expect(res.status).toBe(204);
        expect(res.headers["access-control-allow-methods"]).toBe("GET, OPTIONS");
    });

    it("refuses a version that is no plain token", async () => {
        const res = await request(app).get(`/${BOOK}/cover/${encodeURIComponent("../x")}`);
        expect(res.status).toBe(404);
    });

    describe("whose stored file is gone, with Audiobookshelf holding it", () => {
        let fetchSpy: jest.SpyInstance | undefined;
        const absFetch = (reply: Response) => (fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(reply));
        beforeEach(async () => {
            (getSystemSettings as jest.Mock).mockResolvedValue({ audiobookshelfUrl: "http://abs.test:13378", audiobookshelfApiKey: "abs-key" });
            await prisma.audiobook.update({
                where: { id: BOOK },
                data: { coverUrl: "items/li_9/cover", localCoverPath: path.join(MUSIC, "cover-cache", "audiobooks", "gone.jpg") },
            });
        });
        afterEach(async () => {
            fetchSpy?.mockRestore();
            (getSystemSettings as jest.Mock).mockResolvedValue(null);
            await prisma.audiobook.update({ where: { id: BOOK }, data: { coverUrl: null, localCoverPath: null } });
        });

        it("is proxied from there, with its image type", async () => {
            const spy = absFetch(new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }));
            const res = await request(app).get(`/${BOOK}/cover/lq3k9x`);
            expect(res.status).toBe(200);
            expect(res.headers["content-type"]).toBe("image/png");
            expect(String(spy.mock.calls[0][0])).toBe("http://abs.test:13378/api/items/li_9/cover");
        });

        it("is a 404 when what comes back is over the size cap", async () => {
            expectLog("warn");
            absFetch(new Response(new Uint8Array([1]), { headers: { "content-type": "image/png", "content-length": String(20 * 1024 * 1024 + 1) } }));
            expect((await request(app).get(`/${BOOK}/cover`)).status).toBe(404);
        });

        it("is a 404 when what comes back is no image", async () => {
            expectLog("warn");
            absFetch(new Response("<html>", { headers: { "content-type": "text/html" } }));
            expect((await request(app).get(`/${BOOK}/cover`)).status).toBe(404);
        });
    });

    it("answers the route's own 404 when the cover file is gone between the check and the send", async () => {
        const vanished = path.join(MUSIC, "cover-cache", "audiobooks", `${BOOK}.jpg`);
        const real = fs.existsSync;
        const spy = jest.spyOn(fs, "existsSync").mockImplementation((p) => (String(p) === vanished ? true : real(p)));

        const res = await request(app).get(`/${BOOK}/cover`);
        spy.mockRestore();
        await prisma.audiobook.update({ where: { id: BOOK }, data: { localCoverPath: null } });

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Cover not found" });
    });

    it("refuses an id that reaches another folder inside the music root", async () => {
        const id = encodeURIComponent(path.join("..", "..", "Artist", "Album", "cover"));
        const res = await request(app).get(`/${id}/cover`);

        expect(res.status).toBe(404);
        expect(res.text).not.toContain(ALBUM_COVER_BODY);
    });

    it("still answers 404 for an ordinary id with no cover on disk", async () => {
        // The guard must not turn "no cover" into an error.
        const res = await request(app).get("/audiobook-with-no-cover/cover");

        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Cover not found");
    });
});
