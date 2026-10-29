/**
 * An acoustidApiKey saved through POST /system-settings comes back from GET as
 * the plaintext, through the real encryption. Prisma is mocked.
 */

jest.mock("../../utils/db", () => ({
    prisma: {
        systemSettings: {
            findUnique: jest.fn(),
            create: jest.fn(),
            upsert: jest.fn(),
        },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

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
import { config } from "../../config";

afterAll(async () => {
    // The router reaches jobs/queueCleaner, which enqueues through the real
    // BullMQ queues, and its imports open the shared Redis client. Left open,
    // Jest finishes the suite and outlives the process on those sockets.
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

const app = express();
app.use(express.json());
app.use("/system-settings", systemSettingsRouter);

// A baseline settings row as GET would find it (no acoustid key yet).
const baseRow: Record<string, unknown> = {
    id: "default",
    lidarrEnabled: true,
    lidarrUrl: "http://localhost:8686",
    fanartEnabled: false,
    audiobookshelfEnabled: false,
    audiobookshelfUrl: "http://localhost:13378",
    musicPath: config.music.musicPath,
    autoSync: true,
    transcodeCacheMaxGb: 10,
    maxQueueLength: 10000,
    soulseekConcurrentDownloads: 4,
    acoustidApiKey: null,
};

describe("acoustidApiKey round-trip", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.systemSettings.findUnique as jest.Mock).mockResolvedValue({ ...baseRow });
    });

    it("POST stores the key encrypted; GET returns the stored plaintext", async () => {
        // capture what POST actually persists
        let stored: Record<string, unknown> = { ...baseRow };
        (prisma.systemSettings.upsert as jest.Mock).mockImplementation(async ({ create, update }) => {
            // prisma upsert carries the payload in create/update, not a top-level data key
            stored = { ...stored, ...(update ?? create) };
            return stored;
        });
        // GET then reads the same row back
        (prisma.systemSettings.findUnique as jest.Mock).mockImplementation(async () => stored);

        const post = await request(app)
            .post("/system-settings")
            .send({ ...baseRow, acoustidApiKey: "acoustid-test-key-1234" });
        expect(post.status).toBe(200);

        // the stored value must NOT be plaintext
        expect(stored.acoustidApiKey).not.toBe("acoustid-test-key-1234");
        expect(stored.acoustidApiKey).toBeTruthy();

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
