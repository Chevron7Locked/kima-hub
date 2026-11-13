/**
 * A test file's own afterAll can still use Redis: the shared client reaper closes Redis clients only after every afterAll
 * of the file, as it does Prisma clients (test-environment.cjs).
 */
import { redisClient, waitForRedisReady } from "../utils/redis";

const KEY = "zz-redis-open-in-afterall";

beforeAll(() => waitForRedisReady());

afterAll(async () => {
    await redisClient.set(KEY, "1");
    await redisClient.del(KEY);
});

it("leaves Redis usable for the file's own afterAll", async () => {
    expect(await redisClient.ping()).toBe("PONG");
});
