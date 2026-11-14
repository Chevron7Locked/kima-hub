/**
 * Dismissing downloads from the activity list: only a settled job (completed or failed) can be dismissed, singly or in
 * bulk. A pending or processing job answers 409 and is left untouched; a bulk clear leaves running jobs alone.
 * Real database and router.
 */

jest.mock("../../middleware/auth", () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "ndc_user", role: "user" };
        next();
    },
}));

import express from "express";
import request from "supertest";
import notificationRoutes from "../notifications";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { mountAsServer } from "./helpers/serverMount";

const USER = "ndc_user";
const app = mountAsServer(express().use(express.json()), "/notifications", notificationRoutes, "/api/notifications");

const job = (status: string, targetMbid: string) =>
    prisma.downloadJob.create({
        data: { userId: USER, subject: "Low - Things We Lost in the Fire", type: "album", status, targetMbid, metadata: {} },
    });
const cleared = async (id: string) => (await prisma.downloadJob.findUniqueOrThrow({ where: { id } })).cleared;

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterEach(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

describe("POST /notifications/downloads/:id/clear", () => {
    it.each(["completed", "failed", "exhausted"])("dismisses a %s download", async (status) => {
        const j = await job(status, "rg-1");

        await request(app).post(`/notifications/downloads/${j.id}/clear`).expect(200, { success: true });

        expect(await cleared(j.id)).toBe(true);
    });

    it.each(["pending", "processing"])("answers 409 for a %s download and leaves it on the list", async (status) => {
        const j = await job(status, "rg-1");

        await request(app).post(`/notifications/downloads/${j.id}/clear`).expect(409);

        expect(await cleared(j.id)).toBe(false);
    });

    it("answers success for a download that is not there, as before", async () => {
        await request(app).post("/notifications/downloads/ndc_nothing/clear").expect(200, { success: true });
    });
});

describe("POST /notifications/downloads/clear-all", () => {
    it("dismisses the settled downloads and leaves the running ones", async () => {
        const done = await job("completed", "rg-1");
        const failed = await job("failed", "rg-2");
        const running = await job("processing", "rg-3");
        const pending = await job("pending", "rg-4");

        await request(app).post("/notifications/downloads/clear-all").expect(200, { success: true });

        expect(await cleared(done.id)).toBe(true);
        expect(await cleared(failed.id)).toBe(true);
        expect(await cleared(running.id)).toBe(false);
        expect(await cleared(pending.id)).toBe(false);
    });
});
