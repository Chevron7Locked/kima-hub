// GET /system-settings answers from the settings read every module shares: a cached read, never a row read of its
// own, and never held up by the admin notices about unreadable credentials. Real database, real token.

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { invalidateSystemSettingsCache, saveSystemSettings } from "../../utils/systemSettings";
import { encrypt } from "../../utils/encryption";
import { notificationService } from "../../services/notificationService";
import systemSettingsRoutes from "../systemSettings";
import { queues } from "../../workers/queues";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { closeQueue } from "../../__tests__/helpers/closeQueue";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";

const ADMIN = "zz-settings-get-admin";

let savedRow: Record<string, unknown> | null;

beforeAll(async () => {
    savedRow = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

afterEach(() => {
    jest.restoreAllMocks();
    invalidateSystemSettingsCache();
});

afterAll(async () => {
    if (savedRow) await prisma.systemSettings.upsert({ where: { id: "default" }, create: savedRow as any, update: savedRow as any });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

const app = () => mountAsServer(express().use(express.json()), "/system-settings", systemSettingsRoutes, "/api/system-settings");
const asAdmin = () => `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;
const get = () => request(app()).get("/system-settings").set("Authorization", asAdmin());

it("a second read is answered from what the first read found, until a save or the cache expires", async () => {
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", transcodeCacheMaxGb: 5 }, update: { transcodeCacheMaxGb: 5 } });
    invalidateSystemSettingsCache();
    expect((await get()).body.transcodeCacheMaxGb).toBe(5);

    await prisma.systemSettings.update({ where: { id: "default" }, data: { transcodeCacheMaxGb: 9 } });
    expect((await get()).body.transcodeCacheMaxGb).toBe(5);

    invalidateSystemSettingsCache();
    expect((await get()).body.transcodeCacheMaxGb).toBe(9);
});

it("answers while the admin notice about an unreadable credential is still being sent", async () => {
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default" },
        update: { fanartApiKey: encrypt(encrypt("a key stored twice")) },
    });
    invalidateSystemSettingsCache();
    const warned = expectLog("warn");
    const finishers: (() => void)[] = [];
    const sending = jest
        .spyOn(notificationService, "notifyAdmins")
        .mockImplementation(() => new Promise<void>((done) => finishers.push(done)) as never);

    const res = await get();

    expect(res.status).toBe(200);
    // The notice did start, and is still unanswered; the reply did not wait for it.
    for (let i = 0; i < 100 && sending.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(sending).toHaveBeenCalledTimes(1);
    expect(warned).toHaveBeenCalled();
    finishers.forEach((done) => done());
    expect(res.body.fanartApiKey).toBeNull();
});

it("sends the settings as the page reads them: values readable, no list of unreadable fields", async () => {
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default" },
        update: { lidarrApiKey: encrypt("the-key") },
    });
    invalidateSystemSettingsCache();

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.lidarrApiKey).toBe("the-key");
    expect(res.body).not.toHaveProperty("unreadableFields");
    expect(res.body).toEqual(expect.objectContaining({ id: "default", musicPath: expect.any(String), musicPathFixedByEnv: expect.any(Boolean) }));
});

it("creates the row of a new server with the schema's defaults", async () => {
    await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("default");
    expect(await prisma.systemSettings.count({ where: { id: "default" } })).toBe(1);
});

describe("public-config", () => {
    const config = () => request(app()).get("/system-settings/public-config").set("Authorization", asAdmin());

    it("answers the public address from the shared settings read, and a save shows at once", async () => {
        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: { id: "default", publicUrl: "https://kima.example" },
            update: { publicUrl: "https://kima.example" },
        });
        invalidateSystemSettingsCache();
        const read = jest.spyOn(prisma.systemSettings, "findUnique");

        expect((await config()).body.publicUrl).toBe("https://kima.example");
        expect((await config()).body.publicUrl).toBe("https://kima.example");
        expect(read).toHaveBeenCalledTimes(1);

        await saveSystemSettings({ publicUrl: "https://other.example" });
        expect((await config()).body.publicUrl).toBe("https://other.example");
    });

    it("answers an empty address on a new server with no settings row", async () => {
        await prisma.systemSettings.deleteMany({ where: { id: "default" } });
        invalidateSystemSettingsCache();

        const res = await config();

        expect(res.status).toBe(200);
        expect(res.body.publicUrl).toBe("");
    });
});
