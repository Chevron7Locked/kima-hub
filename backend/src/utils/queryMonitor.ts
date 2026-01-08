import { prisma } from "./db";
import { logger } from "./logger";

const SLOW_QUERY_THRESHOLD_MS = 100; // Log queries that take longer than 100ms

/**
 * Enable slow query monitoring for Prisma
 * Logs queries that exceed the threshold to help identify performance issues
 */
export function enableSlowQueryMonitoring() {
    // @ts-ignore - Prisma's query event type is not fully typed
    prisma.$on("query", async (e: any) => {
        if (e.duration > SLOW_QUERY_THRESHOLD_MS) {
            logger.warn(
                `  Slow query detected (${e.duration}ms):\n` +
                    `   Query: ${e.query}\n` +
                    `   Params: ${e.params}`
            );
        }
    });

    logger.debug(
        `Slow query monitoring enabled (threshold: ${SLOW_QUERY_THRESHOLD_MS}ms)`
    );
}

/**
 * Log query statistics for debugging
 */
export async function logQueryStats() {
    const stats = await (prisma as any).$metrics?.json();
    logger.debug("Database Query Stats:", JSON.stringify(stats, null, 2));
}
