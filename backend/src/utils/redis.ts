import Redis from "ioredis";
import { logger } from "./logger";
import { config } from "../config";

const redisClient = new Redis(config.redisUrl, {
    enableReadyCheck: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 100, 3000),
});

redisClient.on("error", (err: Error) => {
    logger.error("  Redis error:", err.message);
});

redisClient.on("close", () => {
    logger.debug("  Redis disconnected - caching disabled");
});

redisClient.on("reconnecting", () => {
    logger.debug(" Redis reconnecting...");
});

redisClient.on("ready", () => {
    logger.debug("Redis ready");
});

export { redisClient };
