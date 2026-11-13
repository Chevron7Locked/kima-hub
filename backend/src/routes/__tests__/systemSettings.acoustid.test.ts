/**
 * An acoustidApiKey saved through POST /system-settings comes back from GET as
 * the plaintext, through the real encryption. Real router, real database.
 */

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "user-1", username: "tester", role: "admin" };
        next();
    },
    requireAdmin: (req: any, _res: any, next: any) => {
        req.user = { id: "user-1", username: "tester", role: "admin" };
        next();
    },
}));

import request from "supertest";
import express from "express";
import systemSettingsRouter from "../systemSettings";
import { prisma } from "../../utils/db";
import { queues } from "../../workers/queues";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { closeQueue } from "../../__tests__/helpers/closeQueue";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { mountAsServer } from "./helpers/serverMount";

afterAll(async () => {
    // The router reaches jobs/queueCleaner, which enqueues through the real
    // BullMQ queues, and its imports open the shared Redis client. Left open,
    // Jest finishes the suite and outlives the process on those sockets.
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

const app = express();
app.use(express.json());
mountAsServer(app, "/system-settings", systemSettingsRouter, "/api/system-settings");

// System settings is one shared row: put the key back as the file found it.
let original: { acoustidApiKey: string | null } | null;
beforeAll(async () => {
    original = await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { acoustidApiKey: true } });
});
afterAll(async () => {
    if (original) await prisma.systemSettings.update({ where: { id: "default" }, data: { acoustidApiKey: original.acoustidApiKey } });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
});

const storedKey = async () => (await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } })).acoustidApiKey;

describe("acoustidApiKey round-trip", () => {
    beforeEach(async () => {
        await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { acoustidApiKey: null } });
        invalidateSystemSettingsCache();
    });

    it("POST stores the key encrypted; GET returns the stored plaintext", async () => {
        const post = await request(app).post("/system-settings").send({ acoustidApiKey: "acoustid-test-key-1234" });
        expect(post.status).toBe(200);

        // the stored value must NOT be plaintext
        const stored = await storedKey();
        expect(stored).toBeTruthy();
        expect(stored).not.toBe("acoustid-test-key-1234");

        const get = await request(app).get("/system-settings");
        expect(get.status).toBe(200);
        expect(get.body.acoustidApiKey).toBe("acoustid-test-key-1234");
    });

    it("GET returns null (not ciphertext, not undefined) when no key is stored", async () => {
        const get = await request(app).get("/system-settings");
        expect(get.status).toBe(200);
        expect(get.body.acoustidApiKey).toBeNull();
    });
});
