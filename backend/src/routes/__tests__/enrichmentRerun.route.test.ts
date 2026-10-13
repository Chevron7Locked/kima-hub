/**
 * POST /enrichment/rerun takes one of the five steps, hands it to
 * rerunEnrichment, and starts the engine. Anything else is a 400, and it is
 * admin-only like every lever that redoes the library.
 */
jest.mock("../../middleware/auth", () => {
    const inject = (role: string) => (req: any, _res: any, next: any) => {
        req.user = { id: `${role}-1`, role };
        next();
    };
    return {
        requireAuth: inject("admin"),
        requireAdmin: (req: any, res: any, next: any) => {
            if (req.user?.role !== "admin") {
                res.status(403).json({ error: "Admin access required" });
                return;
            }
            next();
        },
    };
});

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn(), setex: jest.fn(), del: jest.fn() },
}));

const mockRerun = jest.fn();
jest.mock("../../services/enrichmentRestart", () => ({
    wipeEnrichment: jest.fn(),
    rerunEnrichment: mockRerun,
}));

jest.mock("../../workers/unifiedEnrichment", () => ({
    startEnrichmentNow: jest.fn(),
    invalidateEnrichmentProgress: jest.fn(),
}));

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {},
}));

jest.mock("../../services/enrichmentState", () => ({
    enrichmentStateService: {},
}));

import express from "express";
import request from "supertest";
import enrichmentRouter from "../enrichment";

const app = express();
app.use(express.json());
app.use("/enrichment", enrichmentRouter);

beforeEach(() => {
    jest.clearAllMocks();
    mockRerun.mockResolvedValue({ artists: 1, tracks: 2, vectors: 3 });
});

describe("POST /enrichment/rerun", () => {
    it("re-runs from a valid step and starts the engine", async () => {
        const res = await request(app).post("/enrichment/rerun").send({ step: "similarity" });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ artists: 1, tracks: 2, vectors: 3, message: "Re-running from similarity" });
        expect(mockRerun).toHaveBeenCalledWith("similarity");
    });

    it.each(["everything", "", null, 5, "toString", "constructor"])("rejects an unknown step %p", async (step) => {
        const res = await request(app).post("/enrichment/rerun").send({ step });
        expect(res.status).toBe(400);
        expect(mockRerun).not.toHaveBeenCalled();
    });

    it("reports a failed re-run as a 500", async () => {
        mockRerun.mockRejectedValue(new Error("db gone"));
        const res = await request(app).post("/enrichment/rerun").send({ step: "artists" });
        expect(res.status).toBe(500);
    });
});
