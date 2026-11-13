/**
 * GET /enrichment/status reports `hung: true` when it has been running for over
 * 15 minutes with no activity.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "admin-1", role: "admin" };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: "admin-1", role: "admin" };
        next();
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn(), setex: jest.fn(), del: jest.fn() },
}));

const mockGetState = jest.fn();
const mockDetectHang = jest.fn();
jest.mock("../../services/enrichmentState", () => ({
    enrichmentStateService: {
        getState: mockGetState,
        detectHang: mockDetectHang,
    },
}));

jest.mock("../../workers/unifiedEnrichment", () => ({
    getEnrichmentProgress: jest.fn(),
    runFullEnrichment: jest.fn(),
    triggerEnrichmentNow: jest.fn(),
    startEnrichmentNow: jest.fn(),
    invalidateEnrichmentProgress: jest.fn(),
}));
jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {},
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
    invalidateSystemSettingsCache: jest.fn(),
}));
jest.mock("../../services/rateLimiter", () => ({ rateLimiter: {} }));

import request from "supertest";
import express from "express";
import enrichmentRouter from "../enrichment";

describe("GET /enrichment/status", () => {
    let app: express.Express;

    beforeEach(() => {
        jest.clearAllMocks();
        app = express();
        app.use(express.json());
        app.use("/enrichment", enrichmentRouter);
    });

    it("returns hung=false when state is idle", async () => {
        mockGetState.mockResolvedValue({ status: "idle", currentPhase: null });
        const res = await request(app).get("/enrichment/status");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("idle");
        expect(res.body.hung).toBe(false);
    });

    it("returns hung=true when running but detectHang fires", async () => {
        const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        mockGetState.mockResolvedValue({
            status: "running",
            currentPhase: "audio",
            lastActivity: stale,
        });
        mockDetectHang.mockResolvedValue(true);
        const res = await request(app).get("/enrichment/status");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("running");
        expect(res.body.hung).toBe(true);
    });

    it("returns hung=false when running and detectHang does not fire", async () => {
        mockGetState.mockResolvedValue({
            status: "running",
            currentPhase: "artists",
            lastActivity: new Date().toISOString(),
        });
        mockDetectHang.mockResolvedValue(false);
        const res = await request(app).get("/enrichment/status");
        expect(res.status).toBe(200);
        expect(res.body.hung).toBe(false);
    });

    it("does not call detectHang for a non-running state", async () => {
        mockGetState.mockResolvedValue({ status: "paused", currentPhase: "tracks" });
        const res = await request(app).get("/enrichment/status");
        expect(res.status).toBe(200);
        expect(res.body.hung).toBe(false);
        expect(mockDetectHang).not.toHaveBeenCalled();
    });

    it("returns idle default when no state exists", async () => {
        mockGetState.mockResolvedValue(null);
        const res = await request(app).get("/enrichment/status");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("idle");
        expect(res.body.hung).toBe(false);
    });
});