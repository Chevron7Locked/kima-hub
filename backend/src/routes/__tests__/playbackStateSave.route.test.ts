/**
 * POST /api/playback-state: a save the database refuses answers 500 with a
 * generic body, never the driver's message. Real database. The refusal comes
 * from a user id with no row, which breaks the playback state's foreign key.
 */

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-user"] };
        next();
    },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import playbackStateRouter from "../playbackState";

const PREFIX = "playback-state-save-test";

const app = express();
app.use(express.json());
app.use("/api/playback-state", playbackStateRouter);

async function cleanup() {
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
}

beforeAll(cleanup);
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});
beforeEach(() => jest.clearAllMocks());

describe("POST /api/playback-state", () => {
    it("saves the state for a real user", async () => {
        const user = await prisma.user.create({
            data: { username: `${PREFIX}-ok`, passwordHash: "x", role: "user" },
        });

        const res = await request(app)
            .post("/api/playback-state")
            .set("x-user", user.id)
            .send({ playbackType: "track" });

        expect(res.status).toBe(200);
        const saved = await prisma.playbackState.findUnique({ where: { userId: user.id } });
        expect(saved?.playbackType).toBe("track");
    });

    it("keeps a queued song's edited title, so another device shows the edit too", async () => {
        const user = await prisma.user.create({
            data: { username: `${PREFIX}-title`, passwordHash: "x", role: "user" },
        });
        const queue = [
            { id: "t1", title: "file title", displayTitle: "edited title", duration: 200 },
            { id: "t2", title: "no edit", duration: 100 },
        ];

        await request(app).post("/api/playback-state").set("x-user", user.id).send({ playbackType: "track", queue }).expect(200);

        const saved = await prisma.playbackState.findUnique({ where: { userId: user.id } });
        expect((saved?.queue as Array<{ title: string; displayTitle: string | null }>).map((q) => [q.title, q.displayTitle])).toEqual([
            ["file title", "edited title"],
            ["no edit", null],
        ]);
    });

    it("answers 500 with only the generic message when the database refuses the save", async () => {
        const res = await request(app)
            .post("/api/playback-state")
            .set("x-user", "cplaybackstatenosuchuser0001")
            .send({ playbackType: "track" });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Failed to save playback state" });
        expect(logger.error).toHaveBeenCalledWith(
            "Save playback state error:",
            expect.any(Error),
        );
    });
});

describe("GET /api/playback-state/limit", () => {
    it("answers a newly saved limit at once, not one the server read earlier", async () => {
        const before = await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { maxQueueLength: true } });
        try {
            await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", maxQueueLength: 10000 }, update: { maxQueueLength: 10000 } });
            expect((await request(app).get("/api/playback-state/limit").set("x-user", "anyone")).body.maxQueueLength).toBe(10000);

            await prisma.systemSettings.update({ where: { id: "default" }, data: { maxQueueLength: 2500 } });
            expect((await request(app).get("/api/playback-state/limit").set("x-user", "anyone")).body.maxQueueLength).toBe(2500);
        } finally {
            await prisma.systemSettings.update({ where: { id: "default" }, data: { maxQueueLength: before?.maxQueueLength ?? 10000 } });
        }
    });
});
