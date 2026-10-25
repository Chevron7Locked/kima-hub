/**
 * Every route that builds the user's mixes (GET /mixes, POST /mixes/refresh, GET /mixes/:id, POST /mixes/:id/save)
 * hands the app's time zone (?tz=) to the mix generator, so Late Night and Midnight Drive read "after dark" in the
 * listener's own zone, and the cached list is reused only for the zone it was built for. The generator is replaced;
 * the routes, their queries and the cache logic are real. The zone check is replaced by one that names the server's
 * zone "Server/Zone" and treats "Bad/Zone" as unknown.
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
jest.mock("../../services/mixes/nightPlays", () => ({
    nightZone: async (requested?: string) => (requested && requested !== "Bad/Zone" ? requested : "Server/Zone"),
}));
jest.mock("../../services/mixes", () => ({
    programmaticPlaylistService: { generateAllMixes: jest.fn(async () => []) },
}));

import express from "express";
import request from "supertest";
import mixRoutes from "../mixes";
import { programmaticPlaylistService } from "../../services/mixes";
import { prisma } from "../../utils/db";

const generate = programmaticPlaylistService.generateAllMixes as jest.Mock;
const MIX = { id: "m1", name: "Mix One", trackIds: [] as string[] };

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
    generate.mockReset();
    generate.mockImplementation(async () => [MIX]);
    jest.restoreAllMocks();
});

describe("the time zone on the mixes routes", () => {
    it("GET /mixes passes ?tz= to the generator as the fourth argument", async () => {
        await request(app()).get("/mixes").query({ tz: "Asia/Tokyo" }).expect(200);
        expect(generate).toHaveBeenCalledTimes(1);
        expect(generate.mock.calls[0][0]).toBe("tz_user");
        expect(generate.mock.calls[0][3]).toBe("Asia/Tokyo");
    });

    it("GET /mixes without a zone passes the server's own", async () => {
        await request(app()).get("/mixes").expect(200);
        expect(generate.mock.calls[0][3]).toBe("Server/Zone");
    });

    it("POST /mixes/refresh passes ?tz= too", async () => {
        await request(app()).post("/mixes/refresh").query({ tz: "America/New_York" }).expect(200);
        expect(generate).toHaveBeenCalledTimes(1);
        expect(generate.mock.calls[0][3]).toBe("America/New_York");
    });

    it("GET /mixes/:id passes ?tz= too, not the server's zone", async () => {
        jest.spyOn(prisma.track, "findMany").mockResolvedValue([]);
        await request(app()).get("/mixes/m1").query({ tz: "Asia/Tokyo" }).expect(200);
        expect(generate.mock.calls[0][3]).toBe("Asia/Tokyo");
    });

    it("POST /mixes/:id/save passes ?tz= too", async () => {
        jest.spyOn(prisma.playlist, "findFirst").mockResolvedValue({ id: "p0", name: "Mix One" } as any);
        await request(app()).post("/mixes/m1/save").query({ tz: "Asia/Tokyo" }).expect(409);
        expect(generate.mock.calls[0][3]).toBe("Asia/Tokyo");
    });
});

describe("the cached mixes and the zone they were built for", () => {
    it("are served again for the same zone", async () => {
        await request(app()).get("/mixes").query({ tz: "Asia/Tokyo" }).expect(200);
        await request(app()).get("/mixes").query({ tz: "Asia/Tokyo" }).expect(200);
        expect(generate).toHaveBeenCalledTimes(1);
    });

    it("are rebuilt when another zone is asked for, and the next request for that zone is served from the new entry", async () => {
        await request(app()).get("/mixes").query({ tz: "Asia/Tokyo" }).expect(200);
        await request(app()).get("/mixes").query({ tz: "America/New_York" }).expect(200);
        expect(generate).toHaveBeenCalledTimes(2);
        expect(generate.mock.calls[1][3]).toBe("America/New_York");
        await request(app()).get("/mixes").query({ tz: "America/New_York" }).expect(200);
        expect(generate).toHaveBeenCalledTimes(2);
    });

    it("are rebuilt for a request with no zone after one built for a zone, and a request naming an unknown zone is treated as no zone", async () => {
        await request(app()).get("/mixes").query({ tz: "Asia/Tokyo" }).expect(200);
        await request(app()).get("/mixes").expect(200);
        expect(generate).toHaveBeenCalledTimes(2);
        await request(app()).get("/mixes").query({ tz: "Bad/Zone" }).expect(200);
        expect(generate).toHaveBeenCalledTimes(2);
    });

    it("from before the zone was stored (a plain list) are still served", async () => {
        store.set("mixes:tz_user", JSON.stringify([{ id: "old", name: "Old", trackIds: [] }]));
        const res = await request(app()).get("/mixes").query({ tz: "Asia/Tokyo" }).expect(200);
        expect(generate).not.toHaveBeenCalled();
        expect(res.body.map((m: any) => m.id)).toEqual(["old"]);
    });

    it("keep the key the enrichment re-run and the releases step clear", async () => {
        await request(app()).get("/mixes").query({ tz: "Asia/Tokyo" }).expect(200);
        expect([...store.keys()]).toEqual(["mixes:tz_user"]);
    });
});
