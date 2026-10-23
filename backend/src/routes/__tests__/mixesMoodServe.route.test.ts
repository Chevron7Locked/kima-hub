/**
 * GET /mixes/mood/buckets/:mood draws from the mood page's recipe, stores the
 * ids it served on the caller's UserMoodMix and excludes them from the next
 * serving. On the synthetic library with learned moods.
 */

const store = new Map<string, string>();
jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        setex: jest.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); return "OK"; }),
        del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
        multi: jest.fn(() => {
            const ops: Array<() => void> = [];
            const chain = {
                setex: (k: string, _ttl: number, v: string) => { ops.push(() => store.set(k, v)); return chain; },
                del: (k: string) => { ops.push(() => store.delete(k)); return chain; },
                sadd: () => chain,
                expire: () => chain,
                exec: async () => { ops.forEach((op) => op()); return []; },
            };
            return chain;
        }),
    },
}));

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import mixRoutes from "../mixes";
import { prisma } from "../../utils/db";
import { buildMoodState } from "../../services/moods/state";
import { pickRecipeStation } from "../../services/mixes/recipes";
import {
    removeSyntheticLibrary,
    seedSyntheticLibrary,
    seedSyntheticMoods,
} from "../../__tests__/fixtures/syntheticLibrary";

jest.setTimeout(300_000);

const PREFIX = "mmsr_";
const USER_ID = "mmsr_user";

/** Every member of the Calm page's recipe; 15 served + 3 saved + 15 fresh needs well over 33. */
let calm: string[] = [];
const trackId = (i: number) => calm[i];

function makeApp() {
    const app = express();
    app.use(express.json());
    // The route reads req.user directly rather than going through middleware.
    app.use((req: any, _res, next) => {
        req.user = { id: USER_ID, username: "mmsr-tester", role: "user" };
        next();
    });
    app.use("/mixes", mixRoutes);
    return app;
}

async function servedTrackIds(): Promise<string[]> {
    const row = await prisma.userMoodMix.findUnique({ where: { userId: USER_ID } });
    return row?.servedTrackIds ?? [];
}

describe("GET /mixes/mood/buckets/:mood remembers what it served (database)", () => {
    let app: express.Application;

    beforeAll(async () => {
        await seedSyntheticLibrary(PREFIX);
        await seedSyntheticMoods(PREFIX);
        await prisma.$transaction((tx) => buildMoodState(tx));
        calm = await pickRecipeStation("calm", { limit: 100_000 });
        expect(calm.length).toBeGreaterThan(60);
        await prisma.user.create({
            data: { id: USER_ID, username: "mmsr-tester", passwordHash: "x" },
        });
        // A mix the user already saved, before any serving is recorded.
        await prisma.userMoodMix.create({
            data: {
                userId: USER_ID,
                mood: "chill",
                trackIds: [trackId(0), trackId(1), trackId(2)],
                coverUrls: [],
                generatedAt: new Date(),
            },
        });
        app = makeApp();
    });

    afterAll(async () => {
        await prisma.userMoodMix.deleteMany({ where: { userId: { startsWith: "mmsr_" } } });
        await removeSyntheticLibrary(PREFIX);
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
        await prisma.$disconnect();
    });

    it("records the exact ids it served on the user's mix", async () => {
        const res = await request(app).get("/mixes/mood/buckets/chill");

        expect(res.status).toBe(200);
        expect(res.body.trackIds).toHaveLength(15);
        expect(res.body.trackIds.filter((id: string) => !calm.includes(id))).toEqual([]);
        expect(await servedTrackIds()).toEqual(res.body.trackIds);
    });

    it("answers 'not enough tracks' rather than an error when the library cannot rank the page's recipe", async () => {
        const { happy_sd } = await prisma.moodState.findUniqueOrThrow({ where: { id: "default" } });
        await prisma.moodState.update({ where: { id: "default" }, data: { happy_sd: 0 } });
        try {
            const res = await request(app).get("/mixes/mood/buckets/happy");
            expect(res.status).toBe(400);
            expect(res.body.error).toBe("Not enough tracks for mood: happy");
        } finally {
            await prisma.moodState.update({ where: { id: "default" }, data: { happy_sd } });
        }
    });

    it("does not repeat remembered ids on the next serving", async () => {
        const first = await servedTrackIds();
        const saved = [trackId(0), trackId(1), trackId(2)];

        const res = await request(app).get("/mixes/mood/buckets/chill");

        expect(res.status).toBe(200);
        expect(res.body.trackIds).toHaveLength(15);
        const given = new Set([...saved, ...first]);
        for (const id of res.body.trackIds) {
            expect(given.has(id)).toBe(false);
        }
    });
});
