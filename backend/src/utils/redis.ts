import { createClient } from "redis";
import { logger } from "./logger";
import { config } from "../config";

const redisClient = createClient({ url: config.redisUrl });

// Handle Redis errors gracefully
redisClient.on("error", (err) => {
    logger.error("  Redis error:", err.message);
    // Don't crash the app - Redis is optional for caching
});

redisClient.on("disconnect", () => {
    logger.debug("  Redis disconnected - caching disabled");
});

redisClient.on("reconnecting", () => {
    logger.debug(" Redis reconnecting...");
});

redisClient.on("ready", () => {
    logger.debug("Redis ready");
});

// Connect immediately on module load
redisClient.connect().catch((error) => {
    logger.error("  Redis connection failed:", error.message);
    logger.debug(" Continuing without Redis caching...");
});

export { redisClient };
