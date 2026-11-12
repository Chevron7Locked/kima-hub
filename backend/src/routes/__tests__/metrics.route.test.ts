// The metrics page shows the whole server's activity, so only admins read it. On the real
// database with real tokens.

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { createApiKey } from "../../services/users/apiKeyStore";
import metricsRoutes from "../metrics";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-metrics-admin";
const USER = `${P}-member`;
const ADMIN = `${P}-admin`;

const app = () => express().use("/api/metrics", metricsRoutes);
const as = (id: string, role: "user" | "admin") =>
    `Bearer ${generateToken({ id, username: id, role, tokenVersion: 0 })}`;

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { userId: { in: [USER, ADMIN] } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER, ADMIN] } } });
    await closeEngineConnections();
});

describe("metrics are admin-only", () => {
    it("an admin gets the metrics", async () => {
        const res = await request(app()).get("/api/metrics").set("Authorization", as(ADMIN, "admin"));
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/^text\/plain/);
        expect(res.text).toContain("# HELP");
    });

    it("a member is forbidden", async () => {
        const res = await request(app()).get("/api/metrics").set("Authorization", as(USER, "user"));
        expect(res.status).toBe(403);
        expect(res.text).not.toContain("# HELP");
    });

    it("a scraper with an admin's app key gets the metrics, one with a member's is forbidden", async () => {
        const adminKey = (await createApiKey(ADMIN, "scraper")).key;
        const memberKey = (await createApiKey(USER, "scraper")).key;
        expect((await request(app()).get("/api/metrics").set("X-API-Key", adminKey)).status).toBe(200);
        expect((await request(app()).get("/api/metrics").set("X-API-Key", memberKey)).status).toBe(403);
    });

    it("no session is unauthorised", async () => {
        const res = await request(app()).get("/api/metrics");
        expect(res.status).toBe(401);
    });
});
