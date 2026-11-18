import { Queue } from "bullmq";
import { logger } from "../utils/logger";
import { queueConnection } from "./queueConnection";

const defaultJobOptions = {
    removeOnComplete: 100,
    removeOnFail: 50,
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5000 },
};

// v2 suffix avoids key conflict with old Bull v4 data still in Redis
export const scanQueue = new Queue("library-scan-v2", {
    connection: queueConnection(),
    defaultJobOptions,
});

export const discoverQueue = new Queue("discover-weekly-v2", {
    connection: queueConnection(),
    defaultJobOptions,
});

export const importQueue = new Queue("playlist-import", {
    connection: queueConnection(),
    defaultJobOptions: {
        ...defaultJobOptions,
        attempts: 1, // Import jobs should not auto-retry (downloads are not idempotent)
        removeOnComplete: { count: 50, age: 86400 },
        removeOnFail: { count: 50, age: 86400 },
    },
});

// Discover's artists in Lidarr, removed after a clear. Its own queue, so a slow Lidarr holds up neither a clear's answer,
// nor scans, nor the weekly jobs. One try: the next clear runs it again.
export const discoverArtistsQueue = new Queue("discover-lidarr-artists", {
    connection: queueConnection(),
    defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

export const queues = [scanQueue, discoverQueue, importQueue, discoverArtistsQueue];

logger.debug("BullMQ queues initialized (library-scan-v2, discover-weekly-v2, playlist-import, discover-lidarr-artists)");
