/**
 * GET /mixes and POST /mixes/refresh hand the app's time zone (?tz=) to the mix generator, so Late Night and Midnight
 * Drive read "after dark" in the listener's own zone. The generator is replaced; the route and its query are real.
 */
const store = new Map<string, string>();
jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        setex: jest.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); return "OK"; }),
        del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
    },
}));
jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../services/mixes", () => ({
    programmaticPlaylistService: { generateAllMixes: jest.fn(async () => []) },
}));

import express from "express";
import request from "supertest";
import mixRoutes from "../mixes";
import { programmaticPlaylistService } from "../../services/mixes";

const generate = programmaticPlaylistService.generateAllMixes as jest.Mock;

function app() {
    const a = express();
    a.use(express.json());
    a.use((req: any, _res, next) => {
        req.user = { id: "tz_user", username: "tz", role: "user" };
        next();
    });
    a.use("/mixes", mixRoutes);
    return a;
}

beforeEach(() => {
    store.clear();
    generate.mockClear();
});

describe("the time zone on the mixes routes", () => {
    it("GET /mixes passes ?tz= to the generator as the fourth argument", async () => {
        await request(app()).get("/mixes").query({ tz: "Asia/Tokyo" }).expect(200);
        expect(generate).toHaveBeenCalledTimes(1);
        expect(generate.mock.calls[0][0]).toBe("tz_user");
        expect(generate.mock.calls[0][3]).toBe("Asia/Tokyo");
    });

    it("GET /mixes without a zone passes none, so the server's own is used", async () => {
        await request(app()).get("/mixes").expect(200);
        expect(generate.mock.calls[0][3]).toBeUndefined();
    });

    it("POST /mixes/refresh passes ?tz= too", async () => {
        await request(app()).post("/mixes/refresh").query({ tz: "America/New_York" }).expect(200);
        expect(generate).toHaveBeenCalledTimes(1);
        expect(generate.mock.calls[0][3]).toBe("America/New_York");
    });
});
