/**
 * GET /api/vibe/map never waits on a computation: it serves the positions the
 * similarity step stored (gzipped when accepted), answers 202 until the first
 * layout exists, or 500 when reading fails.
 */

import express from "express";
import request from "supertest";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "user-1" };
        next();
    },
}));

const mockState = jest.fn();
jest.mock("../../services/vibeMap", () => ({
    getVibeMap: () => mockState(),
}));

import vibeRouter from "../vibe";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { expectLog } from "../../__tests__/helpers/expectedLogs";

afterAll(async () => {
    // The router pulls in services/featureDetection, which opens the shared
    // Redis client at import. Left open, Jest finishes the suite and outlives
    // the process on that socket.
    await closeClient(redisClient);
});

function app() {
    const a = express();
    a.use("/api/vibe", vibeRouter);
    return a;
}

const MAP = {
    tracks: [{ id: "t1", x: 0.1, y: 0.2, z: 0.3, colour: 0.4, title: "One", artist: "A" }],
    trackCount: 1,
    computedAt: "2026-09-23T00:00:00.000Z",
    moodSignature: "m1",
};

describe("GET /api/vibe/map", () => {
    beforeEach(() => mockState.mockReset());

    it("reports a failed read as a 500", async () => {
        expectLog("error");
        mockState.mockRejectedValue(new Error("connection lost"));
        const res = await request(app()).get("/api/vibe/map");
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/Failed to read the vibe map/);
    });

    it("answers 'computing' straight away until the first layout exists", async () => {
        mockState.mockResolvedValue({ status: "computing" });
        const res = await request(app()).get("/api/vibe/map");
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ computing: true });
    });

    it("serves plain JSON to a client that does not accept gzip", async () => {
        mockState.mockResolvedValue({ status: "ready", data: MAP });
        const res = await request(app()).get("/api/vibe/map").set("Accept-Encoding", "identity");
        expect(res.status).toBe(200);
        expect(res.headers["content-encoding"]).toBeUndefined();
        expect(res.body).toEqual(MAP);
    });

    it("serves the map gzipped when the client accepts it", async () => {
        mockState.mockResolvedValue({ status: "ready", data: MAP });
        const res = await request(app()).get("/api/vibe/map").set("Accept-Encoding", "gzip");
        expect(res.status).toBe(200);
        expect(res.headers["content-encoding"]).toBe("gzip");
        // supertest inflates gzip itself; a body that round-trips proves the stream is valid gzip.
        expect(res.body).toEqual(MAP);
    });
});
