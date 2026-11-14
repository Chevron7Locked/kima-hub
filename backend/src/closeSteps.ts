/**
 * What the server closes on shutdown, in order, once the listener has stopped and the drain is done (see ./shutdown).
 * Here, apart from index.ts, so a test can run the real list: each resource must close once, and the ones other code
 * shares (`enrichmentStateService`) close in this list and nowhere else.
 */

import { redisClient } from "./utils/redis";
import { prisma } from "./utils/db";
import { logger } from "./utils/logger";
import { enrichmentStateService } from "./services/enrichmentState";

export const closeSteps: Array<() => Promise<void>> = [
    // Workers (intervals, crons, queues)
    async () => {
        const { shutdownWorkers } = await import("./workers");
        await shutdownWorkers();
    },
    async () => {
        logger.debug("Disconnecting Soulseek...");
        const { soulseekService } = await import("./services/soulseek");
        soulseekService.disconnect();
    },
    // The one place `enrichmentStateService` closes (shutdownWorkers leaves it alone).
    async () => {
        logger.debug("Disconnecting enrichmentStateService...");
        await enrichmentStateService.disconnect();
    },
    async () => {
        logger.debug("Closing Redis connection...");
        await redisClient.quit();
    },
    async () => {
        logger.debug("Closing database connection...");
        await prisma.$disconnect();
    },
];
