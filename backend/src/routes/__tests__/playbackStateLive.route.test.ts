/**
 * POST /api/playback-state/live: the web player's reports for the public live
 * trip. Only the public user's player is heard; everyone else gets 404.
 */
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../utils/db", () => ({ prisma: {}, Prisma: {} }));
jest.mock("../../config", () => require("./helpers/publicListener").publicVibeConfigMock());
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-user"] ?? "public-user" };
        next();
    },
}));
// isPublicListener is faked in helpers/publicListener; the real check is tested in liveListening.test.ts.
jest.mock("../../services/liveListening", () => ({
    isPublicListener: jest.fn(require("./helpers/publicListener").fakeIsPublicListener),
    reportLive: jest.fn(),
}));

import express from "express";
import request from "supertest";
import playbackStateRouter from "../playbackState";
import { config } from "../../config";
import { isPublicListener, reportLive } from "../../services/liveListening";

const app = express();
app.use(express.json());
app.use("/api/playback-state", playbackStateRouter);

const BODY = {
    status: "playing",
    trackId: "ctrackaaaaaaaaaaaaaaaaaa1",
    position: 1234.6,
    duration: 180000,
    queue: [{ trackId: "ctrackbbbbbbbbbbbbbbbbbb1", duration: 200000 }, { trackId: 5 }],
};

beforeEach(() => jest.clearAllMocks());

describe("POST /api/playback-state/live", () => {
    it("passes the public user's report on, keeping only well-formed queue entries", async () => {
        const res = await request(app).post("/api/playback-state/live").send(BODY);
        expect(res.status).toBe(200);
        expect(reportLive).toHaveBeenCalledWith({
            status: "playing",
            trackId: BODY.trackId,
            position: 1235,
            duration: 180000,
            queue: [{ trackId: "ctrackbbbbbbbbbbbbbbbbbb1", duration: 200000 }],
        });
    });

    it("answers 404 to any other user", async () => {
        const res = await request(app).post("/api/playback-state/live").set("x-user", "someone").send(BODY);
        expect(res.status).toBe(404);
        expect(reportLive).not.toHaveBeenCalled();
    });

    it("a failed lookup is a 500, never the 404 that would silence the player", async () => {
        (isPublicListener as jest.Mock).mockRejectedValueOnce(new Error("connection terminated"));
        const res = await request(app).post("/api/playback-state/live").send(BODY);
        expect(res.status).toBe(500);
        expect(reportLive).not.toHaveBeenCalled();
    });

    it("answers 404 when the public routes are off", async () => {
        const original = config.publicVibe;
        (config as any).publicVibe = null;
        const res = await request(app).post("/api/playback-state/live").send(BODY);
        (config as any).publicVibe = original;
        expect(res.status).toBe(404);
    });

    it.each([
        ["an unknown status", { ...BODY, status: "buffering" }],
        ["no track", { ...BODY, trackId: "" }],
        ["a negative position", { ...BODY, position: -1 }],
        ["no duration", { ...BODY, duration: undefined }],
    ])("refuses %s", async (_label, body) => {
        const res = await request(app).post("/api/playback-state/live").send(body);
        expect(res.status).toBe(400);
        expect(reportLive).not.toHaveBeenCalled();
    });
});
