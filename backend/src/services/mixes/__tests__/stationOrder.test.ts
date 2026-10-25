/**
 * The station session's order kept in Redis (stationOrder.ts), on in-memory pools: later refills read their page
 * without reading the pool, pages across the stored chunks, the end of a pass, one session per listener and station,
 * pages with nothing playable, and what happens without Redis.
 */
import { redisClient, waitForRedisReady } from "../../../utils/redis";
import { SESSION_TTL_S, stationPage, type StationRequest, type StationSong } from "../stationOrder";

const pool = (n: number, perArtist = 3): StationSong[] =>
    Array.from({ length: n }, (_, i) => ({ id: `s${String(i).padStart(5, "0")}`, artistId: `a${Math.floor(i / perArtist)}` }));

async function forget() {
    await waitForRedisReady();
    const keys = await redisClient.keys("station:*");
    if (keys.length > 0) await redisClient.del(...keys);
}

/** A pool reader that counts its reads. */
function counted(songs: StationSong[]) {
    const reader = { reads: 0, read: async () => (reader.reads++, songs) };
    return reader;
}

/** Every page of `limit` from `offset` until `count` songs. */
async function listen(
    station: string,
    read: () => Promise<StationSong[] | null>,
    seed: string,
    offset: number,
    count: number,
    { limit = 100, listener = "u1", playable }: Partial<StationRequest> = {},
) {
    const heard: string[] = [];
    let at = offset;
    while (heard.length < count) {
        const page = await stationPage(station, read, { limit, seed, offset: at, listener, playable });
        if (page.trackIds.length === 0) throw new Error(`empty page at ${at}`);
        heard.push(...page.trackIds);
        at = page.next!;
    }
    return heard;
}

beforeEach(forget);

describe("stationPage", () => {
    it("reads the pool once per pass, then pages from Redis, across its stored chunks", async () => {
        const songs = pool(2_500);
        const reader = counted(songs);
        const whole = (await stationPage("t", reader.read, { limit: 100, seed: "x", offset: 0, listener: "u1" })).trackIds;
        expect(reader.reads).toBe(1);
        const all = await listen("t", reader.read, "x", 0, 2_500, { limit: 70 });
        expect(reader.reads).toBe(1);
        expect(all.slice(0, 100)).toEqual(whole);
        expect(new Set(all)).toEqual(new Set(songs.map((s) => s.id)));
        expect(all).toHaveLength(2_500);
        // A page across the 1,000-id boundary of two stored chunks.
        const across = await stationPage("t", reader.read, { limit: 100, seed: "x", offset: 950, listener: "u1" });
        expect(across.trackIds).toEqual(all.slice(950, 1050));
        expect(reader.reads).toBe(1);
    });

    it("stops a page at the end of a pass and starts the pool over at the next, reading it again", async () => {
        const reader = counted(pool(250));
        const at = (offset: number, limit = 100) => stationPage("t", reader.read, { limit, seed: "x", offset, listener: "u1" });
        await at(0);
        const last = await at(200);
        expect(last.trackIds).toHaveLength(50);
        expect(last.next).toBe(250);
        const next = await at(250);
        expect(next.trackIds).toHaveLength(100);
        expect(next.next).toBe(350);
        expect(reader.reads).toBe(2);
        // Asking from before the kept pass starts at it.
        expect((await at(100, 10)).trackIds).toEqual(next.trackIds.slice(0, 10));
    });

    it("keeps one session per listener and station: a new start replaces the old one and its ids", async () => {
        const reader = counted(pool(3_000));
        const start = (seed: string, listener: string, station = "t") =>
            stationPage(station, reader.read, { limit: 100, seed, offset: 0, listener });
        await start("first", "u1");
        await start("other", "u2");
        await start("first", "u1", "t2");
        expect((await redisClient.keys("station:*")).sort()).toEqual(
            ["station:t2:u1", "station:t2:u1:ids", "station:t:u1", "station:t:u1:ids", "station:t:u2", "station:t:u2:ids"],
        );
        const sizeBefore = await redisClient.llen("station:t:u1:ids");
        await start("second", "u1");
        expect(await redisClient.hget("station:t:u1", "seed")).toBe("second");
        expect(await redisClient.llen("station:t:u1:ids")).toBe(sizeBefore);
        expect(await redisClient.keys("station:t:u1*")).toHaveLength(2);
    });

    it("serves an older session of the listener (another tab) in its own order without pushing out the newer one", async () => {
        const reader = counted(pool(400));
        const first = await listen("t", reader.read, "old", 0, 200);
        await stationPage("t", reader.read, { limit: 100, seed: "new", offset: 0, listener: "u1" });
        const rest = await listen("t", reader.read, "old", 200, 300);
        expect(await redisClient.hget("station:t:u1", "seed")).toBe("new");
        expect([...first, ...rest]).toEqual(await listen("t2", reader.read, "old", 0, 500));
    });

    it("passes over a page with nothing playable inside the kept order, without reading the pool", async () => {
        const reader = counted(pool(500));
        const all = await listen("t", reader.read, "x", 0, 500);
        expect(reader.reads).toBe(1);
        const gone = new Set(all.slice(100, 300));
        const playable = async (ids: string[]) => new Set(ids.filter((id) => !gone.has(id)));
        const page = await stationPage("t", reader.read, { limit: 100, seed: "x", offset: 100, listener: "u1", playable });
        expect(page.trackIds).toEqual(all.slice(300, 400));
        expect(page.next).toBe(400);
        expect(reader.reads).toBe(1);
        // Part of a page gone: the rest of it comes back.
        const partly = await stationPage("t", reader.read, { limit: 100, seed: "x", offset: 250, listener: "u1", playable });
        expect(partly.trackIds).toEqual(all.slice(300, 350));
        expect(partly.next).toBe(350);
    });

    it("gives up instead of going round again when no song of a new pass can play", async () => {
        const reader = counted(pool(30));
        const nothing = async () => new Set<string>();
        const page = await stationPage("t", reader.read, { limit: 10, seed: "x", offset: 0, listener: "u1", playable: nothing });
        expect(page).toEqual({ trackIds: [], next: 90 });
        expect(reader.reads).toBe(3);
    });

    it("has nothing for an empty pool or none yet, and ends a session whose pool emptied", async () => {
        const request = (seed: string, offset: number) => ({ limit: 10, seed, offset, listener: "u1" });
        expect(await stationPage("t", async () => null, request("x", 0))).toEqual({ trackIds: [], next: 0 });
        expect(await stationPage("t", async () => [], { limit: 10 })).toEqual({ trackIds: [] });
        await stationPage("t", async () => pool(5), request("y", 0));
        expect(await stationPage("t", async () => [], request("y", 5))).toEqual({ trackIds: [], next: 5 });
    });

    it("keeps no session and gives no next without a seed, and keeps none without a listener", async () => {
        const page = await stationPage("t", async () => pool(300), { limit: 100 });
        expect(page.trackIds).toHaveLength(100);
        expect(page.next).toBeUndefined();
        const anonymous = await stationPage("t", async () => pool(300), { limit: 100, seed: "x", offset: 0 });
        expect(anonymous.next).toBe(100);
        expect(await redisClient.keys("station:*")).toEqual([]);
    });

    it("refuses a seed outside letters, digits, - and _", async () => {
        for (const seed of ["abc:ids", "a b", "", "x".repeat(129), "é"]) {
            await expect(stationPage("t", async () => pool(5), { limit: 1, seed, listener: "u1" })).rejects.toThrow(RangeError);
        }
    });

    it("serves from the pool when Redis fails, the same order for the same seed while the pool is unchanged", async () => {
        const reader = counted(pool(400));
        const whole = await listen("t", reader.read, "x", 0, 1_000);
        await forget();
        const failures = [
            jest.spyOn(redisClient, "multi").mockImplementation(() => {
                throw new Error("connection lost");
            }),
            jest.spyOn(redisClient, "lrange").mockRejectedValue(new Error("connection lost")),
        ];
        try {
            expect(await listen("t", reader.read, "x", 150, 100)).toEqual(whole.slice(150, 250));
            // A later pass too: it is replayed after the passes before it.
            expect(await listen("t", reader.read, "x", 850, 100)).toEqual(whole.slice(850, 950));
        } finally {
            failures.forEach((spy) => spy.mockRestore());
        }
    });

    it("forgets a session twelve hours after its last refill", async () => {
        expect(SESSION_TTL_S).toBe(12 * 3600);
        await stationPage("t", async () => pool(50), { limit: 10, seed: "x", offset: 0, listener: "u1" });
        for (const key of ["station:t:u1", "station:t:u1:ids"]) {
            const ttl = await redisClient.ttl(key);
            expect(ttl).toBeGreaterThan(SESSION_TTL_S - 60);
            expect(ttl).toBeLessThanOrEqual(SESSION_TTL_S);
        }
    });
});
