import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { enrichSimilarArtist } from "./artistEnrichment";

let isEnriching = false;
let enrichmentInterval: NodeJS.Timeout | null = null;

// Configuration for enrichment worker
const ENRICHMENT_BATCH_SIZE = 10; // Process 10 artists at a time (reduced from 50)
const ENRICHMENT_INTERVAL_MS = 30 * 1000; // Run every 30 seconds (increased from 5s)

/**
 * Background worker that continuously enriches pending artists
 * Throttled to reduce API load and prevent rate limiting
 */
export async function startEnrichmentWorker() {
    logger.debug("Starting enrichment worker...");
    logger.debug(`   - Concurrent artists: ${ENRICHMENT_BATCH_SIZE}`);
    logger.debug(`   - Check interval: ${ENRICHMENT_INTERVAL_MS / 1000} seconds`);

    // Run immediately on start
    await enrichNextBatch();

    // Then run at configured interval
    enrichmentInterval = setInterval(async () => {
        await enrichNextBatch();
    }, ENRICHMENT_INTERVAL_MS);
}

/**
 * Stop the enrichment worker
 */
export function stopEnrichmentWorker() {
    if (enrichmentInterval) {
        clearInterval(enrichmentInterval);
        enrichmentInterval = null;
        logger.debug(" Enrichment worker stopped");
    }
}

/**
 * Process the next batch of pending artists (throttled)
 */
async function enrichNextBatch() {
    // Skip if already enriching
    if (isEnriching) {
        return;
    }

    try {
        isEnriching = true;

        // Find the next batch of pending or failed artists that have ANY albums
        // (owned OR discovery)
        const artists = await prisma.artist.findMany({
            where: {
                OR: [
                    { enrichmentStatus: "pending" },
                    { enrichmentStatus: "failed" },
                ],
                // Enrich artists that have any albums in the database
                albums: {
                    some: {},
                },
            },
            orderBy: { name: "asc" },
            take: ENRICHMENT_BATCH_SIZE,
        });

        if (artists.length === 0) {
            // No more artists to enrich
            return;
        }

        logger.debug(
            `\n[Enrichment Worker] Processing batch of ${artists.length} artists...`
        );

        // Enrich all artists concurrently
        await Promise.allSettled(
            artists.map(async (artist) => {
                try {
                    logger.debug(` Starting: ${artist.name}`);
                    await enrichSimilarArtist(artist);
                    logger.debug(`   Completed: ${artist.name}`);
                } catch (error) {
                    logger.error(`    Failed: ${artist.name}`, error);
                }
            })
        );

        // Log progress
        const progress = await getEnrichmentProgress();
        logger.debug(
            `\n[Enrichment Progress] ${progress.completed}/${progress.total} (${progress.progress}%)`
        );
        logger.debug(
            `   Pending: ${progress.pending} | Failed: ${progress.failed}\n`
        );
    } catch (error) {
        logger.error(` [Enrichment Worker] Batch error:`, error);
    } finally {
        isEnriching = false;
    }
}

/**
 * Get enrichment progress statistics
 */
export async function getEnrichmentProgress() {
    const statusCounts = await prisma.artist.groupBy({
        by: ["enrichmentStatus"],
        _count: true,
    });

    const total = statusCounts.reduce((sum, s) => sum + s._count, 0);
    const completed =
        statusCounts.find((s) => s.enrichmentStatus === "completed")?._count ||
        0;
    const failed =
        statusCounts.find((s) => s.enrichmentStatus === "failed")?._count || 0;
    const enriching =
        statusCounts.find((s) => s.enrichmentStatus === "enriching")?._count ||
        0;
    const pending =
        statusCounts.find((s) => s.enrichmentStatus === "pending")?._count || 0;

    const progress = total > 0 ? ((completed + failed) / total) * 100 : 0;

    return {
        total,
        completed,
        failed,
        enriching,
        pending,
        progress: Math.round(progress * 10) / 10,
        isComplete: pending === 0 && enriching === 0,
    };
}
