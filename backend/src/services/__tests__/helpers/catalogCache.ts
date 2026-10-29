import { redisClient } from "../../../utils/redis";

/** Every chart and show the podcast catalog cached, so a test asks Apple afresh. */
export async function clearCatalogCache() {
    const keys = await redisClient.keys("podcasts:*");
    if (keys.length > 0) await redisClient.del(...keys);
}
