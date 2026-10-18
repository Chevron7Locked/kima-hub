/**
 * Podcast search on the discover search answers from Apple's search (a recorded reply) and asks Apple through
 * Kima's Apple queue at the front, like a show page, so searching counts against Apple's limit like everything
 * else. Real router and Redis.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: "u_searchpod", username: "t" }; next(); },
}));

import express from "express";
import request from "supertest";
import searchRoutes from "../search";
import { INTERACTIVE_PRIORITY, rateLimiter } from "../../services/rateLimiter";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { loadRecording, startReplayServer, type ReplayServer } from "../../__tests__/helpers/replayServer";

const app = express();
app.use(express.json());
app.use("/search", searchRoutes);
let replay: ReplayServer;

beforeAll(async () => {
    replay = await startReplayServer(loadRecording("apple", "search"));
    process.env.ITUNES_BASE_URL = replay.url;
    await waitForRedisReady();
});

beforeEach(async () => {
    const keys = await redisClient.keys("search:discover:*");
    if (keys.length > 0) await redisClient.del(...keys);
    replay.asked.length = 0;
});

afterAll(async () => {
    delete process.env.ITUNES_BASE_URL;
    await replay.close();
});

it("answers Apple's shows for the term, asked through the Apple queue ahead of background work", async () => {
    const queued = jest.spyOn(rateLimiter, "execute");
    const res = await request(app).get("/search/discover?q=dungeons&type=podcasts&limit=5");
    expect(res.status).toBe(200);
    expect(replay.asked).toEqual(["/search?term=dungeons&media=podcast&entity=podcast&limit=5"]);
    expect(queued).toHaveBeenCalledWith("itunes", expect.any(Function), expect.objectContaining({ priority: INTERACTIVE_PRIORITY, skipRetry: true }));
    queued.mockRestore();
    const dnd = res.body.results.find((r: any) => r.name === "Dungeons and Daddies");
    expect(dnd).toMatchObject({ type: "podcast", id: 1450241676, trackCount: 211, artist: expect.any(String) });
    expect(dnd.categoryIds.length).toBeGreaterThan(0);
    expect(res.body.results.filter((r: any) => r.type === "podcast")).toHaveLength(5);
});

it("answers an empty podcast section, and caches nothing, when Apple fails", async () => {
    process.env.ITUNES_BASE_URL = "http://127.0.0.1:9";
    const res = await request(app).get("/search/discover?q=dungeons&type=podcasts&limit=5");
    process.env.ITUNES_BASE_URL = replay.url;
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(await redisClient.keys("search:discover:*")).toEqual([]);
});

it("still answers within its old 5 s when Kima's Apple queue is holding requests back", async () => {
    // Apple has been refusing requests, so the queue is waiting out its circuit breaker (up to a minute).
    const circuit = (rateLimiter as any).circuitBreakers.get("itunes");
    Object.assign(circuit, { isOpen: true, openedAt: Date.now(), resetAfterMs: 60_000 });
    const started = Date.now();
    try {
        const res = await request(app).get("/search/discover?q=dungeons&type=podcasts&limit=5");
        expect(res.status).toBe(200);
        expect(res.body.results).toEqual([]);
    } finally {
        Object.assign(circuit, { isOpen: false, consecutiveFailures: 0, resetAfterMs: 30_000 });
    }
    expect(Date.now() - started).toBeLessThan(7_000);
    expect(replay.asked).toEqual([]);
    expect(await redisClient.keys("search:discover:*")).toEqual([]);
}, 15_000);

