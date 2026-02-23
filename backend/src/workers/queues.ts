import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { logger } from "../utils/logger";
import { config } from "../config";

function getConnectionOptions(): ConnectionOptions {
    const url = new URL(config.redisUrl);
    return {
        host: url.hostname,
        port: parseInt(url.port, 10) || 6379,
        password: url.password || undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    };
}

const defaultJobOptions = {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5000 },
};

// v2 suffix avoids key conflict with old Bull v4 data still in Redis
export const scanQueue = new Queue("library-scan-v2", {
    connection: getConnectionOptions(),
    defaultJobOptions,
});

export const discoverQueue = new Queue("discover-weekly-v2", {
    connection: getConnectionOptions(),
    defaultJobOptions,
});

export const queues = [scanQueue, discoverQueue];

logger.debug("BullMQ queues initialized (library-scan-v2, discover-weekly-v2)");
