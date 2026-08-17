/**
 * GET /audiobooks/:id/cover -- the unauthenticated file read.
 *
 * The route built `${req.params.id}.jpg` onto the music root and sendFile'd the
 * result. Express decodes %2F in a route param AFTER matching, so an id of
 * "..%2F..%2F..%2Fetc%2Fx" is real traversal by the time the handler sees it.
 * This route carries no auth -- auth in audiobooks.ts is applied per-route and
 * this is not one of them, and nothing authenticates ahead of the
 * /api/audiobooks mount -- so it was an unauthenticated read of any .jpg the
 * process could reach.
 *
 * This test writes a real file outside the music root and asks for it through
 * the route. No filesystem mocking: the point is whether the process will
 * actually hand over a file it should not, so the file is really there.
 */

jest.mock("../../utils/db", () => ({
    prisma: {
        audiobook: {
            findUnique: jest.fn().mockResolvedValue(null),
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

jest.mock("../../services/notificationService", () => ({
    notificationService: { notifySystem: jest.fn() },
}));

jest.mock("../../config", () => ({
    config: { music: { musicPath: "/music" } },
}));

import express from "express";
import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import audiobookRoutes from "../../routes/audiobooks";
import { prisma } from "../../utils/db";

// Where the unguarded join would have landed: the route appends ".jpg" itself.
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
    const relative = path.relative("/music/cover-cache/audiobooks", withoutExt);
    return encodeURIComponent(relative);
}

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/", audiobookRoutes);
    return app;
}

describe("GET /audiobooks/:id/cover", () => {
    let app: express.Application;

    beforeAll(() => {
        app = makeApp();
        fs.writeFileSync(probeFile, PROBE_BODY);
    });

    afterAll(() => {
        fs.rmSync(probeFile, { force: true });
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.audiobook.findUnique as jest.Mock).mockResolvedValue(null);
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
        // The unguarded version wrote whatever it resolved into
        // localCoverPath, which would have persisted the escape.
        await request(app).get(`/${traversingId()}/cover`);

        expect(prisma.audiobook.update).not.toHaveBeenCalled();
    });

    it("still answers 404 for an ordinary id with no cover on disk", async () => {
        // The guard must not turn "no cover" into an error.
        const res = await request(app).get("/audiobook-with-no-cover/cover");

        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Cover not found");
    });
});
