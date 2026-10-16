/**
 * POST /enrichment/rerun takes one of the five steps, hands it to rerunEnrichment, and starts the
 * engine. Anything else is a 400, and a member is refused by the real admin check: only the re-run
 * itself and the engine are stood in for.
 */
jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockRerun = jest.fn();
jest.mock("../../services/enrichmentRestart", () => ({
    wipeEnrichment: jest.fn(),
    rerunEnrichment: mockRerun,
}));

const mockStartEnrichmentNow = jest.fn();
const mockInvalidateEnrichmentProgress = jest.fn();
jest.mock("../../workers/unifiedEnrichment", () => ({
    startEnrichmentNow: mockStartEnrichmentNow,
    invalidateEnrichmentProgress: mockInvalidateEnrichmentProgress,
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import enrichmentRouter from "../enrichment";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const MEMBER = "rerun_route_member";
const ADMIN = "rerun_route_admin";
const as = (id: string, role: "user" | "admin") => `Bearer ${generateToken({ id, username: id, role, tokenVersion: 0 })}`;

const app = express();
app.use(express.json());
app.use("/enrichment", enrichmentRouter);
const rerun = (step: unknown, who: string = ADMIN, role: "user" | "admin" = "admin") =>
    request(app).post("/enrichment/rerun").set("Authorization", as(who, role)).send({ step });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [MEMBER, ADMIN] } } });
    await prisma.user.create({ data: { id: MEMBER, username: MEMBER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [MEMBER, ADMIN] } } });
    await closeEngineConnections();
});

beforeEach(() => {
    jest.clearAllMocks();
    mockRerun.mockResolvedValue({ artists: 1, tracks: 2, vectors: 3 });
    mockStartEnrichmentNow.mockResolvedValue(undefined);
});

describe("POST /enrichment/rerun", () => {
    it("re-runs from a valid step and starts the engine", async () => {
        const res = await rerun("similarity");
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ artists: 1, tracks: 2, vectors: 3, message: "Re-running from similarity" });
        expect(mockRerun).toHaveBeenCalledWith("similarity");
        expect(mockInvalidateEnrichmentProgress).toHaveBeenCalledTimes(1);
        expect(mockStartEnrichmentNow).toHaveBeenCalledTimes(1);
    });

    it.each(["everything", "", null, 5, "toString", "constructor"])("rejects an unknown step %p", async (step) => {
        const res = await rerun(step);
        expect(res.status).toBe(400);
        expect(mockRerun).not.toHaveBeenCalled();
        expect(mockStartEnrichmentNow).not.toHaveBeenCalled();
    });

    it("reports a failed re-run as a 500 and starts nothing", async () => {
        mockRerun.mockRejectedValue(new Error("db gone"));
        const res = await rerun("artists");
        expect(res.status).toBe(500);
        expect(mockInvalidateEnrichmentProgress).not.toHaveBeenCalled();
        expect(mockStartEnrichmentNow).not.toHaveBeenCalled();
    });

    it("refuses a member, re-running nothing", async () => {
        const res = await rerun("similarity", MEMBER, "user");
        expect(res.status).toBe(403);
        expect(mockRerun).not.toHaveBeenCalled();
        expect(mockStartEnrichmentNow).not.toHaveBeenCalled();
    });

    it("needs a signed-in user", async () => {
        expect((await request(app).post("/enrichment/rerun").send({ step: "similarity" })).status).toBe(401);
        expect(mockRerun).not.toHaveBeenCalled();
    });
});
