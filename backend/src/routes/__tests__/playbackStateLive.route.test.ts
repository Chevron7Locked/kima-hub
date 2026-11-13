/**
 * POST /api/playback-state/live: the web player's reports for the public live
 * trip. Only the public user's player is heard; everyone else gets 404.
 * Real router, real liveListening and real database: the public user is found
 * by username, and a report shows in the live state.
 */
jest.mock("../../config", () => ({
    config: { publicVibe: { token: "t".repeat(32), username: "live_report_pub" } },
}));
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-user"] ?? "live_report_pub" };
        next();
    },
}));
// liveListening stays real. isPublicListener is only wrapped so a test can make it fail: the real one
// caches the public user's id after the first lookup, so a failing database read cannot reach it twice.
jest.mock("../../services/liveListening", () => {
    const actual = jest.requireActual("../../services/liveListening");
    return { ...actual, isPublicListener: jest.fn(actual.isPublicListener) };
});

import express from "express";
import request from "supertest";
import playbackStateRouter from "../playbackState";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { getLiveState, isPublicListener, setLiveHidden } from "../../services/liveListening";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";

const PUBLIC = "live_report_pub";

const app = express();
app.use(express.json());
mountAsServer(app, "/api/playback-state", playbackStateRouter, "/api/playback-state");

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: PUBLIC } });
    await prisma.user.create({ data: { id: PUBLIC, username: PUBLIC, passwordHash: "x" } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: PUBLIC } });
});

const BODY = {
    status: "paused",
    trackId: "ctrackaaaaaaaaaaaaaaaaaa1",
    position: 1234.6,
    duration: 180000,
    queue: [{ trackId: "ctrackbbbbbbbbbbbbbbbbbb1", duration: 200000 }, { trackId: 5 }],
};

// Nothing has been reported until a test sends a report: a stopped state has no track.
beforeEach(() => {
    setLiveHidden(true);
    setLiveHidden(false);
});

describe("POST /api/playback-state/live", () => {
    it("passes the public user's report on, keeping only well-formed queue entries", async () => {
        const res = await request(app).post("/api/playback-state/live").send(BODY);
        expect(res.status).toBe(200);
        // Paused, so the position is not advanced by the clock.
        expect(getLiveState()).toMatchObject({
            status: "paused",
            trackId: BODY.trackId,
            position: 1235,
            duration: 180000,
            queue: [{ trackId: "ctrackbbbbbbbbbbbbbbbbbb1", duration: 200000 }],
        });
    });

    it("answers 404 to any other user", async () => {
        const res = await request(app).post("/api/playback-state/live").set("x-user", "someone").send(BODY);
        expect(res.status).toBe(404);
        expect(getLiveState().trackId).toBeNull();
    });

    it("a failed lookup is a 500, never the 404 that would silence the player", async () => {
        expectLog("error");
        (isPublicListener as jest.Mock).mockRejectedValueOnce(new Error("connection terminated"));
        const res = await request(app).post("/api/playback-state/live").send(BODY);
        expect(res.status).toBe(500);
        expect(getLiveState().trackId).toBeNull();
    });

    it("answers 404 when the public routes are off", async () => {
        const original = config.publicVibe;
        (config as any).publicVibe = null;
        try {
            const res = await request(app).post("/api/playback-state/live").send(BODY);
            expect(res.status).toBe(404);
            expect(getLiveState().trackId).toBeNull();
        } finally {
            (config as any).publicVibe = original;
        }
    });

    it.each([
        ["an unknown status", { ...BODY, status: "buffering" }],
        ["no track", { ...BODY, trackId: "" }],
        ["a negative position", { ...BODY, position: -1 }],
        ["no duration", { ...BODY, duration: undefined }],
    ])("refuses %s", async (_label, body) => {
        const res = await request(app).post("/api/playback-state/live").send(body);
        expect(res.status).toBe(400);
        expect(getLiveState().trackId).toBeNull();
    });
});
