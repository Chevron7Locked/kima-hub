/**
 * POST /notifications records an outcome the browser saw in the caller's own tray.
 * A repeat of the same title replaces its row, only the newest 50 titles are kept,
 * and the key cannot reach server alerts.
 */

jest.mock("../../middleware/auth", () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "ncr_user", role: "user" };
        next();
    },
}));

import express from "express";
import request from "supertest";
import notificationRoutes from "../notifications";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "ncr_user";

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/notifications", notificationRoutes);
    return app;
}

const rows = () =>
    prisma.notification.findMany({
        where: { userId: USER },
        select: { id: true, type: true, title: true, message: true, groupKey: true, read: true, metadata: true },
    });

async function wipe(): Promise<void> {
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeAll(async () => {
    await wipe();
    await prisma.user.create({
        data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 },
    });
});

afterEach(async () => {
    await prisma.notification.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await wipe();
    await closeEngineConnections();
});

describe("POST /notifications", () => {
    it("records the outcome for the caller under a client key", async () => {
        const res = await request(makeApp())
            .post("/notifications")
            .send({ type: "error", title: "Failed to move track", message: "Network error", href: "/playlist/p1" });

        expect(res.status).toBe(201);
        const [row] = await rows();
        expect(row).toMatchObject({
            type: "error",
            title: "Failed to move track",
            message: "Network error",
            groupKey: "client:Failed to move track",
            read: false,
            metadata: { href: "/playlist/p1" },
        });
    });

    it("keeps one row when the same failure repeats", async () => {
        const app = makeApp();
        for (let i = 0; i < 4; i++) {
            await request(app).post("/notifications").send({ type: "error", title: "Failed to move track" });
        }
        await request(app).post("/notifications").send({ type: "error", title: "Failed to move track", message: "Timed out" });

        const all = await rows();
        expect(all).toHaveLength(1);
        expect(all[0].message).toBe("Timed out");
    });

    it("brings a dismissed failure back when it happens again", async () => {
        const app = makeApp();
        await request(app).post("/notifications").send({ type: "error", title: "Failed to move track" });
        await prisma.notification.updateMany({ where: { userId: USER }, data: { read: true, cleared: true } });
        await request(app).post("/notifications").send({ type: "error", title: "Failed to move track" });

        const [row] = await prisma.notification.findMany({ where: { userId: USER } });
        expect(row).toMatchObject({ read: false, cleared: false });
    });

    it("keeps only the newest 50 titles without touching server alerts", async () => {
        await prisma.notification.create({
            data: { userId: USER, type: "system", title: "Server", groupKey: "lidarr:down", createdAt: new Date(0) },
        });
        const base = Date.now() - 60 * 60 * 1000;
        await prisma.notification.createMany({
            data: Array.from({ length: 50 }, (_, i) => ({
                userId: USER, type: "error", title: `Old ${i}`, groupKey: `client:Old ${i}`, createdAt: new Date(base + i * 1000),
            })),
        });

        await request(makeApp()).post("/notifications").send({ type: "error", title: "Newest" });

        const all = await rows();
        expect(all).toHaveLength(51);
        expect(all.map((r) => r.title)).toEqual(expect.arrayContaining(["Newest", "Server", "Old 49"]));
        expect(all.map((r) => r.title)).not.toContain("Old 0");
    });

    it("rejects types, links and sizes the browser may not set", async () => {
        const app = makeApp();
        const bad = [
            { type: "download_complete", title: "x" },
            { type: "error", title: "" },
            { type: "error", title: "x".repeat(121) },
            { type: "error", title: "x", href: "https://evil.example" },
            { type: "error", title: "x", href: "//evil.example" },
            { type: "error", title: "x", href: "/\\evil.example" },
        ];
        for (const body of bad) {
            const res = await request(app).post("/notifications").send(body);
            expect(res.status).toBe(400);
        }
        expect(await rows()).toHaveLength(0);
    });
});
