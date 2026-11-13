/**
 * POST /system-settings sets up Lidarr's webhook only when Lidarr's on-switch, address or key changed, and with what
 * is now saved (so a changed key reaches the address already stored). Real router and database; the call to Lidarr
 * is stood in for.
 */
const mockConfigure = jest.fn();
jest.mock("../../services/lidarrWebhookSetup", () => ({ configureLidarrWebhook: (...a: unknown[]) => mockConfigure(...a) }));
jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import systemSettingsRoutes from "../systemSettings";
import { queues } from "../../workers/queues";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { closeQueue } from "../../__tests__/helpers/closeQueue";

const ADMIN = "zz-settings-webhook-admin";
const URL_A = "http://lidarr-a.test:8686";
const URL_B = "http://lidarr-b.test:8686";
const app = express().use(express.json()).use("/system-settings", systemSettingsRoutes);
const asAdmin = () => `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;
const save = (body: Record<string, unknown>) => request(app).post("/system-settings").set("Authorization", asAdmin()).send(body).expect(200);

let before: Record<string, unknown> | null;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

beforeEach(async () => {
    // Set up as a finished install would be: Lidarr on, with its address and key.
    await save({ lidarrEnabled: true, lidarrUrl: URL_A, lidarrApiKey: "key-a", transcodeCacheMaxGb: 10 });
    mockConfigure.mockReset();
    invalidateSystemSettingsCache();
});

afterAll(async () => {
    if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: before as any });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

it("an unrelated setting leaves the webhook alone", async () => {
    await save({ transcodeCacheMaxGb: 20 });

    expect(mockConfigure).not.toHaveBeenCalled();
});

it("Lidarr's settings sent back as they were leave the webhook alone", async () => {
    await save({ lidarrEnabled: true, lidarrUrl: URL_A, lidarrApiKey: "key-a" });

    expect(mockConfigure).not.toHaveBeenCalled();
});

it("a changed address sets the webhook up with the saved key", async () => {
    await save({ lidarrUrl: URL_B });

    expect(mockConfigure).toHaveBeenCalledTimes(1);
    expect(mockConfigure).toHaveBeenCalledWith(URL_B, "key-a");
});

it("a changed key sets the webhook up at the saved address", async () => {
    await save({ lidarrApiKey: "key-b" });

    expect(mockConfigure).toHaveBeenCalledWith(URL_A, "key-b");
});

it("turning Lidarr back on sets the webhook up, and turning it off does not", async () => {
    await save({ lidarrEnabled: false });
    expect(mockConfigure).not.toHaveBeenCalled();

    await save({ lidarrEnabled: true });
    expect(mockConfigure).toHaveBeenCalledWith(URL_A, "key-a");
});

it("a failed webhook setup does not fail the save", async () => {
    mockConfigure.mockRejectedValueOnce(new Error("lidarr is down"));

    await save({ lidarrUrl: URL_B });

    expect((await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).lidarrUrl).toBe(URL_B);
});
