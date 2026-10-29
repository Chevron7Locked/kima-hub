import { redisClient, waitForRedisReady } from "../../../../utils/redis";

/** Every station session's order kept in Redis, so a test's seeds start afresh on its own library. */
export async function forgetStationSessions() {
    await waitForRedisReady();
    const keys = await redisClient.keys("station*");
    if (keys.length > 0) await redisClient.del(...keys);
}
