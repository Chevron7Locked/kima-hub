/**
 * The admin switch for running audio analysis and sound vectors side by side: off by default, saved on the
 * settings row, refused without a boolean. Real router and database.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
// The engine itself is not under test, and loading it pulls in every worker.
jest.mock("../../workers/unifiedEnrichment", () => ({
    triggerEnrichmentNow: jest.fn(),
    startEnrichmentNow: jest.fn(),
    recordStageSuccess: jest.fn(),
    recordStageFailure: jest.fn(),
}));

import express from "express";
import request from "supertest";
import analysisRoutes from "../analysis";
import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const app = express();
app.use(express.json());
app.use("/analysis", analysisRoutes);

afterEach(async () => {
    await prisma.systemSettings.updateMany({ where: { id: "default" }, data: { analysisAndVectorsTogether: false } });
    invalidateSystemSettingsCache();
});

afterAll(async () => {
    await closeEngineConnections();
});

it("is off until an admin turns it on, and saves each change", async () => {
    expect((await request(app).get("/analysis/together")).body).toEqual({ together: false });

    const on = await request(app).put("/analysis/together").send({ together: true });
    expect(on.status).toBe(200);
    expect((await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).analysisAndVectorsTogether).toBe(true);
    expect((await request(app).get("/analysis/together")).body).toEqual({ together: true });

    await request(app).put("/analysis/together").send({ together: false });
    expect((await request(app).get("/analysis/together")).body).toEqual({ together: false });
});

it("refuses a value that is not true or false", async () => {
    expect((await request(app).put("/analysis/together").send({ together: "yes" })).status).toBe(400);
    expect((await request(app).put("/analysis/together").send({})).status).toBe(400);
});
