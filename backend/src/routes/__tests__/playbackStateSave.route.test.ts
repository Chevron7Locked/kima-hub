/**
 * POST /api/playback-state: a save the database refuses answers 500 with a
 * generic body, never the driver's message. Real database. The refusal comes
 * from a user id with no row, which breaks the playback state's foreign key.
 */

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-user"] };
        next();
    },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import playbackStateRouter from "../playbackState";
import { mountAsServer } from "./helpers/serverMount";

const PREFIX = "playback-state-save-test";

const app = express();
app.use(express.json());
mountAsServer(app, "/api/playback-state", playbackStateRouter, "/api/playback-state");

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
        const logged = expectLog("error");
        const res = await request(app)
            .post("/api/playback-state")
            .set("x-user", "cplaybackstatenosuchuser0001")
            .send({ playbackType: "track" });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Failed to save playback state" });
        expect(logged).toHaveBeenCalledWith(
            "Save playback state error:",
            expect.any(Error),
        );
    });
});

describe("POST /api/playback-state: where the queue came from", () => {
    const queue = [{ id: "t1", title: "one", duration: 100 }, { id: "t2", title: "two", duration: 100 }];
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);
    const storedSource = async (userId: string) =>
        ((await prisma.playbackState.findUnique({ where: { userId } })) as { queueSource?: string | null } | null)?.queueSource;

    it("keeps the source saved with a queue, and answers it", async () => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-src`, passwordHash: "x", role: "user" } });
        const res = await save(user.id, { playbackType: "track", queue, queueSource: "album:a-1" }).expect(200);
        expect(res.body.queueSource).toBe("album:a-1");
        expect(await storedSource(user.id)).toBe("album:a-1");
    });

    it("clears the source when a queue is saved without one, as an older client or the iOS app does", async () => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-src-clear`, passwordHash: "x", role: "user" } });
        await save(user.id, { playbackType: "track", queue, queueSource: "playlist:p-1" }).expect(200);
        await save(user.id, { playbackType: "track", queue }).expect(200);
        expect(await storedSource(user.id)).toBeNull();
    });

    it("leaves the source alone on a save that sends no queue", async () => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-src-partial`, passwordHash: "x", role: "user" } });
        await save(user.id, { playbackType: "track", queue, queueSource: "mix:m-1" }).expect(200);
        await save(user.id, { playbackType: "track", isShuffle: true, currentIndex: 1 }).expect(200);
        expect(await storedSource(user.id)).toBe("mix:m-1");
    });

    it("drops a source that is not a short string, and one saved with an empty queue", async () => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-src-bad`, passwordHash: "x", role: "user" } });
        await save(user.id, { playbackType: "track", queue, queueSource: { x: 1 } }).expect(200);
        expect(await storedSource(user.id)).toBeNull();
        await save(user.id, { playbackType: "track", queue, queueSource: "x".repeat(500) }).expect(200);
        expect(await storedSource(user.id)).toBeNull();
        await save(user.id, { playbackType: "track", queue: [], queueSource: "album:a-1" }).expect(200);
        expect(await storedSource(user.id)).toBeNull();
    });
});

describe("POST /api/playback-state: where the player is in the queue", () => {
    const queue = [{ id: "t1", title: "one", duration: 100 }, { id: "t2", title: "two", duration: 100 }, { id: "t3", title: "three", duration: 100 }];
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);
    const storedIndex = async (userId: string) => (await prisma.playbackState.findUnique({ where: { userId } }))?.currentIndex;
    const newUser = (name: string) => prisma.user.create({ data: { username: `${PREFIX}-${name}`, passwordHash: "x", role: "user" } });

    it("stores an index past the end of the saved queue as its last song when the save sends no queue", async () => {
        const user = await newUser("idx-past");
        await save(user.id, { playbackType: "track", queue }).expect(200);
        const res = await save(user.id, { playbackType: "track", currentIndex: 40 }).expect(200);
        expect(res.body.currentIndex).toBe(2);
        expect(await storedIndex(user.id)).toBe(2);
    });

    it("keeps an index inside the saved queue, and clamps a negative or fractional one", async () => {
        const user = await newUser("idx-in");
        await save(user.id, { playbackType: "track", queue }).expect(200);
        await save(user.id, { playbackType: "track", currentIndex: 1 }).expect(200);
        expect(await storedIndex(user.id)).toBe(1);
        await save(user.id, { playbackType: "track", currentIndex: -5 }).expect(200);
        expect(await storedIndex(user.id)).toBe(0);
        await save(user.id, { playbackType: "track", currentIndex: 1.7 }).expect(200);
        expect(await storedIndex(user.id)).toBe(1);
    });

    it("stores 0 when there is no saved queue to point into, for a first save as for a later one", async () => {
        const first = await newUser("idx-first");
        await save(first.id, { playbackType: "track", currentIndex: 7 }).expect(200);
        expect(await storedIndex(first.id)).toBe(0);

        const emptied = await newUser("idx-empty");
        await save(emptied.id, { playbackType: "track", queue }).expect(200);
        await save(emptied.id, { playbackType: "track", queue: [] }).expect(200);
        await save(emptied.id, { playbackType: "track", currentIndex: 3 }).expect(200);
        expect(await storedIndex(emptied.id)).toBe(0);
    });

    it("clamps an index sent with a queue to that queue, as before", async () => {
        const user = await newUser("idx-with");
        await save(user.id, { playbackType: "track", queue, currentIndex: 9 }).expect(200);
        expect(await storedIndex(user.id)).toBe(2);
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
