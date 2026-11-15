/**
 * Pause, resume and stop hand the engine's state to the admin who asked. When the state cannot be read or written
 * that is the server's fault, not the caller's: a 500 with the plain answer, never a 400.
 */
jest.mock("../../workers/unifiedEnrichment", () => ({
    startEnrichmentNow: jest.fn(),
    invalidateEnrichmentProgress: jest.fn(),
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import enrichmentRouter from "../enrichment";
import { enrichmentStateService } from "../../services/enrichmentState";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";

const ADMIN = "enrich_control_admin";
const bearer = `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;

const app = express();
app.use(express.json());
mountAsServer(app, "/enrichment", enrichmentRouter, "/api/enrichment");

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await closeEngineConnections();
});

afterEach(() => jest.restoreAllMocks());

describe("the engine controls when the state cannot be read or written", () => {
    it.each([
        ["pause", "pause"],
        ["resume", "resume"],
        ["stop", "stop"],
    ] as const)("answers a failed %s with 500 and the plain answer", async (path, method) => {
        expectLog("error");
        jest.spyOn(enrichmentStateService, method).mockRejectedValue(new Error("redis went away"));

        const res = await request(app).post(`/enrichment/${path}`).set("Authorization", bearer);

        expect([res.status, res.body]).toEqual([500, { error: "Internal server error" }]);
    });
});
