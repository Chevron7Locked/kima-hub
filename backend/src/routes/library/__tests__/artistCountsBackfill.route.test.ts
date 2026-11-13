// An admin's recount ask is never dropped: asked while a recount runs, it still reaches the recount (which goes over
// the artists once more when it finishes), and the reply says it is queued. The recount module is the seam here; its
// own run-once-more rule is tested with it.
jest.mock("../../../middleware/auth", () => ({
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../../utils/redis", () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), setex: jest.fn(), del: jest.fn(), disconnect: jest.fn() },
}));

const mockRunning = jest.fn();
const mockBackfill = jest.fn();
jest.mock("../../../services/artistCountsService", () => ({
    ...jest.requireActual("../../../services/artistCountsService"),
    isBackfillInProgress: () => mockRunning(),
    backfillAllArtistCounts: (...a: unknown[]) => mockBackfill(...a),
}));

import express from "express";
import request from "supertest";
import artistsRouter from "../artists";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const app = express().use(express.json()).use("/library", artistsRouter);

beforeEach(() => {
    mockRunning.mockReset();
    mockBackfill.mockReset().mockResolvedValue({ processed: 0, errors: 0 });
});

afterAll(async () => {
    await closeEngineConnections();
});

it("starts a recount when none is running", async () => {
    mockRunning.mockReturnValue(false);
    const res = await request(app).post("/library/artist-counts/backfill");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Backfill started", status: "processing" });
    expect(mockBackfill).toHaveBeenCalledTimes(1);
});

it("asks for another pass when a recount is already running, and says it is queued", async () => {
    mockRunning.mockReturnValue(true);
    const res = await request(app).post("/library/artist-counts/backfill");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "Backfill queued: it runs once more when the current one finishes", status: "queued" });
    expect(mockBackfill).toHaveBeenCalledTimes(1);
});
