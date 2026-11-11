/**
 * The analyzers' report secret is made at random per server and kept in Redis, so no install runs with a
 * value anyone knows: fixed values and the environment variable open nothing. Real Redis.
 */
import { redisClient, waitForRedisReady } from "../redis";
import { INTERNAL_SECRET_KEY, internalSecret, isInternalSecret } from "../internalSecret";
import { setEnv } from "../../__tests__/helpers/env";

describe("internal secret", () => {
    beforeAll(waitForRedisReady);
    beforeEach(async () => {
        await redisClient.del(INTERNAL_SECRET_KEY);
    });
    afterAll(async () => {
        await redisClient.del(INTERNAL_SECRET_KEY);
    });

    it("is made once at random and kept", async () => {
        const first = await internalSecret();
        expect(first).toMatch(/^[0-9a-f]{64}$/);
        expect(await internalSecret()).toBe(first);
        expect(await redisClient.get(INTERNAL_SECRET_KEY)).toBe(first);
    });

    it("lets only this server's secret through", async () => {
        const secret = await internalSecret();
        const restoreEnv = setEnv({ INTERNAL_API_SECRET: "kima-internal-aio" });
        try {
            expect(await isInternalSecret(secret)).toBe(true);
            for (const wrong of ["kima-internal-aio", "kima-internal-secret-change-me", "", undefined, secret.slice(1)]) {
                expect(await isInternalSecret(wrong)).toBe(false);
            }
        } finally {
            restoreEnv();
        }
    });

    it("keeps a secret the analyzer made first", async () => {
        await redisClient.set(INTERNAL_SECRET_KEY, "made-by-the-analyzer");
        expect(await internalSecret()).toBe("made-by-the-analyzer");
    });

    it("makes a new one when Redis lost it, and the old one stops working", async () => {
        const old = await internalSecret();
        await redisClient.del(INTERNAL_SECRET_KEY);
        expect(await isInternalSecret(old)).toBe(false);
        expect(await internalSecret()).not.toBe(old);
    });
});
