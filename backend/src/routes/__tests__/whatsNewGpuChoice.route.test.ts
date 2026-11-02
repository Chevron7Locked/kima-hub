/**
 * The release window's GPU choice: admin only, applied through the Settings
 * service before it is recorded, and dismissing never changes the toggle. Real
 * database; auth, Redis and the GPU service are stubbed.
 */

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = {
            id: req.headers["x-test-user"],
            username: "t",
            role: req.headers["x-test-role"] === "admin" ? "admin" : "user",
        };
        next();
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: { del: jest.fn().mockResolvedValue(1), publish: jest.fn().mockResolvedValue(1) },
}));

jest.mock("../../services/gpuRuntime", () => ({
    setGpuToggles: jest.fn().mockResolvedValue({ enabled: true }),
    gpuSupported: () => true,
}));

import express from "express";
import request from "supertest";
import whatsNewRoutes from "../whatsNew";
import { prisma } from "../../utils/db";
import { GPU_CHOICE_KEY } from "../../services/releases/catalog";
import { setGpuToggles } from "../../services/gpuRuntime";

const PREFIX = "whatsnew-gpu-test";

const setGpuMock = setGpuToggles as jest.Mock;

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/whats-new", whatsNewRoutes);
    return app;
}

async function makeUser(role: "user" | "admin") {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return prisma.user.create({
        data: { username: `${PREFIX}-${tag}`, passwordHash: "x", role },
    });
}

async function cleanup() {
    const users = await prisma.user.findMany({
        where: { username: { startsWith: PREFIX } },
        select: { id: true },
    });
    const ids = users.map((u) => u.id);
    await prisma.releaseChoice.deleteMany({ where: { userId: { in: ids } } });
    await prisma.releaseAcknowledgement.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(() => jest.clearAllMocks());
afterAll(cleanup);

describe("POST /whats-new/:version/choice — the GPU key", () => {
    it("applies the toggle for an admin and records the decision", async () => {
        const user = await makeUser("admin");
        const res = await request(makeApp())
            .post("/whats-new/1.11.0/choice")
            .set("x-test-user", user.id)
            .set("x-test-role", "admin")
            .send({ key: GPU_CHOICE_KEY, enabled: true });

        expect(res.status).toBe(200);
        expect(setGpuMock).toHaveBeenCalledWith({ soundVectors: true });
        const row = await prisma.releaseChoice.findUnique({
            where: { userId_key: { userId: user.id, key: GPU_CHOICE_KEY } },
        });
        expect(row?.enabled).toBe(true);
        expect(row?.decidedBy).toBe("EXPLICIT");
    });

    it("refuses a non-admin: no toggle write, no recorded choice", async () => {
        const user = await makeUser("user");
        const res = await request(makeApp())
            .post("/whats-new/1.11.0/choice")
            .set("x-test-user", user.id)
            .send({ key: GPU_CHOICE_KEY, enabled: true });

        expect(res.status).toBe(403);
        expect(setGpuMock).not.toHaveBeenCalled();
        const row = await prisma.releaseChoice.findUnique({
            where: { userId_key: { userId: user.id, key: GPU_CHOICE_KEY } },
        });
        expect(row).toBeNull();
    });

    it("says no honestly: disabled applies the off path", async () => {
        const user = await makeUser("admin");
        const res = await request(makeApp())
            .post("/whats-new/1.11.0/choice")
            .set("x-test-user", user.id)
            .set("x-test-role", "admin")
            .send({ key: GPU_CHOICE_KEY, enabled: false });

        expect(res.status).toBe(200);
        expect(setGpuMock).toHaveBeenCalledWith({ soundVectors: false });
    });
});

describe("POST /whats-new/1.11.0/dismiss", () => {
    it("settles the GPU choice at its default without touching the toggle", async () => {
        const user = await makeUser("admin");
        const res = await request(makeApp())
            .post("/whats-new/1.11.0/dismiss")
            .set("x-test-user", user.id)
            .set("x-test-role", "admin")
            .send({});

        expect(res.status).toBe(200);
        expect(setGpuMock).not.toHaveBeenCalled();
        const row = await prisma.releaseChoice.findUnique({
            where: { userId_key: { userId: user.id, key: GPU_CHOICE_KEY } },
        });
        expect(row?.enabled).toBe(false);
        expect(row?.decidedBy).toBe("DISMISSED");
    });
});

describe("GET /whats-new/pending — audience filtering", () => {
    it("shows the GPU question to admins and hides it from everyone else", async () => {
        const admin = await makeUser("admin");
        const plain = await makeUser("user");

        // 1.11's question is read on the changelog: the window shows only the newest release.
        const asAdmin = await request(makeApp())
            .get("/whats-new/changelog")
            .set("x-test-user", admin.id)
            .set("x-test-role", "admin");
        const adminRelease = asAdmin.body.releases.find((r: any) => r.version === "1.11.0");
        expect(adminRelease.items.some((i: any) => i.key === GPU_CHOICE_KEY)).toBe(true);

        const asPlain = await request(makeApp())
            .get("/whats-new/changelog")
            .set("x-test-user", plain.id);
        const plainRelease = asPlain.body.releases.find((r: any) => r.version === "1.11.0");
        expect(plainRelease.items.some((i: any) => i.key === GPU_CHOICE_KEY)).toBe(false);
    });
});
