/**
 * The station session's order kept in Redis (stationOrder.ts), on in-memory pools: later refills read their page
 * without reading the pool, pages across the stored chunks, the end of a pass, and what happens without Redis.
 */
import { redisClient, waitForRedisReady } from "../../../utils/redis";
import { stationPage, type StationSong } from "../stationOrder";

const pool = (n: number, perArtist = 3): StationSong[] =>
    Array.from({ length: n }, (_, i) => ({ id: `s${String(i).padStart(5, "0")}`, artistId: `a${Math.floor(i / perArtist)}` }));

async function forget() {
    await waitForRedisReady();
    const keys = await redisClient.keys("station:*");
    if (keys.length > 0) await redisClient.del(...keys);
}

/** Every page of `limit` from `offset` until `count` songs. */
async function listen(station: string, read: () => Promise<StationSong[] | null>, seed: string, offset: number, count: number, limit = 100) {
    const heard: string[] = [];
    let at = offset;
    while (heard.length < count) {
        const page = await stationPage(station, read, { limit, seed, offset: at });
        if (page.trackIds.length === 0) throw new Error(`empty page at ${at}`);
        heard.push(...page.trackIds);
        at = page.next;
    }
    return heard;
}

beforeEach(forget);

describe("stationPage", () => {
    it("reads the pool once per pass, then pages from Redis, across its stored chunks", async () => {
        const songs = pool(2_500);
        let reads = 0;
        const read = async () => {
            reads++;
            return songs;
        };
        const whole = (await stationPage("t", read, { limit: 100, seed: "x", offset: 0 })).trackIds;
        expect(reads).toBe(1);
        const all = await listen("t", read, "x", 0, 2_500, 70);
        expect(reads).toBe(1);
        expect(all.slice(0, 100)).toEqual(whole);
        expect(new Set(all)).toEqual(new Set(songs.map((s) => s.id)));
        expect(all).toHaveLength(2_500);
        // A page across the 1,000-id boundary of two stored chunks.
        const across = await stationPage("t", read, { limit: 100, seed: "x", offset: 950 });
        expect(across.trackIds).toEqual(all.slice(950, 1050));
        expect(reads).toBe(1);
    });

    it("stops a page at the end of a pass and starts the pool over at the next, reading it again", async () => {
        const songs = pool(250);
        let reads = 0;
        const read = async () => {
            reads++;
            return songs;
        };
        const last = await stationPage("t", read, { limit: 100, seed: "x", offset: 200 });
        expect(last.trackIds).toHaveLength(50);
        expect(last.next).toBe(250);
        const next = await stationPage("t", read, { limit: 100, seed: "x", offset: 250 });
        expect(next.trackIds).toHaveLength(100);
        expect(next.next).toBe(350);
        expect(reads).toBe(2);
        // Asking from before the kept pass starts at it.
        expect((await stationPage("t", read, { limit: 10, seed: "x", offset: 100 })).trackIds).toEqual(next.trackIds.slice(0, 10));
    });

    it("has nothing for an empty pool or none yet, and ends a session whose pool emptied", async () => {
        expect(await stationPage("t", async () => null, { limit: 10, seed: "x", offset: 0 })).toEqual({ trackIds: [], next: 0 });
        expect(await stationPage("t", async () => [], { limit: 10 })).toEqual({ trackIds: [], next: 0 });
        await stationPage("t", async () => pool(5), { limit: 10, seed: "y", offset: 0 });
        expect(await stationPage("t", async () => [], { limit: 10, seed: "y", offset: 5 })).toEqual({ trackIds: [], next: 5 });
    });

    it("keeps no session without a seed", async () => {
        const page = await stationPage("t", async () => pool(300), { limit: 100 });
        expect(page.trackIds).toHaveLength(100);
        expect(await redisClient.keys("station:*")).toEqual([]);
    });

    it("serves from the pool when Redis fails, the same order for the same seed while the pool is unchanged", async () => {
        const songs = pool(400);
        const read = async () => songs;
        const whole = await listen("t", read, "x", 0, 400);
        await forget();
        const failures = [
            jest.spyOn(redisClient, "multi").mockImplementation(() => {
                throw new Error("connection lost");
            }),
            jest.spyOn(redisClient, "lrange").mockRejectedValue(new Error("connection lost")),
        ];
        try {
            expect(await listen("t", read, "x", 150, 100)).toEqual(whole.slice(150, 250));
        } finally {
            failures.forEach((spy) => spy.mockRestore());
        }
    });

    it("expires a session a day after its last refill", async () => {
        await stationPage("t", async () => pool(50), { limit: 10, seed: "x", offset: 0 });
        const ttl = await redisClient.ttl("station:t:x:ids");
        expect(ttl).toBeGreaterThan(24 * 3600 - 60);
        expect(ttl).toBeLessThanOrEqual(24 * 3600);
        expect(await redisClient.ttl("station:t:x")).toBeGreaterThan(24 * 3600 - 60);
    });
});
