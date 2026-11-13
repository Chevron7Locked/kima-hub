/**
 * PUT /enrichment/concurrency saves the setting through the settings save (so whoever reads it is told), clamps it
 * to 1-5, and sets the rate limiter's multiplier. Real router and database; the engine and the limiter are stood in for.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../workers/unifiedEnrichment", () => ({
    getEnrichmentProgress: jest.fn(),
    triggerEnrichmentNow: jest.fn(),
    startEnrichmentNow: jest.fn(),
    invalidateEnrichmentProgress: jest.fn(),
    retryFailedAndBlocked: jest.fn(),
    redecideEverything: jest.fn(),
}));
const mockMultiplier = jest.fn();
jest.mock("../../services/rateLimiter", () => ({ rateLimiter: { updateConcurrencyMultiplier: (...a: unknown[]) => mockMultiplier(...a) } }));

import express from "express";
import request from "supertest";
import enrichmentRouter from "../enrichment";
import { prisma } from "../../utils/db";
import { getSystemSettings, invalidateSystemSettingsCache, onSystemSettingsChange } from "../../utils/systemSettings";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const app = express().use(express.json()).use("/enrichment", enrichmentRouter);
let before: { enrichmentConcurrency: number } | null;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { enrichmentConcurrency: true } });
});

beforeEach(async () => {
    mockMultiplier.mockClear();
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", enrichmentConcurrency: 1 }, update: { enrichmentConcurrency: 1 } });
    invalidateSystemSettingsCache();
});

afterAll(async () => {
    if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: before });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
    await closeEngineConnections();
    await prisma.$disconnect();
});

it("saves the clamped value, answers it and sets the limiter", async () => {
    const res = await request(app).put("/enrichment/concurrency").send({ concurrency: 9 }).expect(200);

    expect(res.body).toEqual({ concurrency: 5 });
    expect((await getSystemSettings())?.enrichmentConcurrency).toBe(5);
    expect(mockMultiplier).toHaveBeenCalledWith(5);
});

it("tells whoever reads the setting that it changed", async () => {
    const heard = jest.fn();
    const signOff = onSystemSettingsChange(["enrichmentConcurrency"], heard);
    try {
        await request(app).put("/enrichment/concurrency").send({ concurrency: 3 }).expect(200);
        expect(heard).toHaveBeenCalledWith(["enrichmentConcurrency"]);
    } finally {
        signOff();
    }
});

it("refuses a missing or non-numeric value and saves nothing", async () => {
    await request(app).put("/enrichment/concurrency").send({}).expect(400);
    await request(app).put("/enrichment/concurrency").send({ concurrency: "3" }).expect(400);
    expect((await getSystemSettings())?.enrichmentConcurrency).toBe(1);
    expect(mockMultiplier).not.toHaveBeenCalled();
});
