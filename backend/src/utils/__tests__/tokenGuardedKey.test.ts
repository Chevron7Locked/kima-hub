/** A key held by a token is changed only by that token, against the real Redis. */
import { redisClient, waitForRedisReady } from "../redis";
import { closeClient } from "../closeRedisClient";
import { deleteIfToken, pexpireIfToken } from "../tokenGuardedKey";

const KEY = "test:token-guarded-key";

beforeAll(() => waitForRedisReady());
beforeEach(() => redisClient.del(KEY));
afterAll(async () => {
    await redisClient.del(KEY);
    await closeClient(redisClient);
});

describe("deleteIfToken", () => {
    it("deletes the key held by its token and says so", async () => {
        await redisClient.set(KEY, "mine");

        expect(await deleteIfToken(redisClient, KEY, "mine")).toBe(true);
        expect(await redisClient.exists(KEY)).toBe(0);
    });

    it("leaves a key another token holds, and one that is not there", async () => {
        await redisClient.set(KEY, "theirs");

        expect(await deleteIfToken(redisClient, KEY, "mine")).toBe(false);
        expect(await redisClient.get(KEY)).toBe("theirs");

        await redisClient.del(KEY);
        expect(await deleteIfToken(redisClient, KEY, "mine")).toBe(false);
    });
});

describe("pexpireIfToken", () => {
    it("sets the life of the key held by its token and says so", async () => {
        await redisClient.set(KEY, "mine", "PX", 500);

        expect(await pexpireIfToken(redisClient, KEY, "mine", 60_000)).toBe(true);
        expect(await redisClient.pttl(KEY)).toBeGreaterThan(50_000);
    });

    it("leaves the life of a key another token holds, and does not make a key that is not there", async () => {
        await redisClient.set(KEY, "theirs", "PX", 5_000);

        expect(await pexpireIfToken(redisClient, KEY, "mine", 60_000)).toBe(false);
        expect(await redisClient.pttl(KEY)).toBeLessThanOrEqual(5_000);

        await redisClient.del(KEY);
        expect(await pexpireIfToken(redisClient, KEY, "mine", 60_000)).toBe(false);
        expect(await redisClient.exists(KEY)).toBe(0);
    });
});
