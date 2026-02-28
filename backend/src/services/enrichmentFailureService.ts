/**
 * Enrichment Failure Service
 *
 * Tracks and manages failures during artist/track/audio enrichment.
 * Provides visibility into what failed and allows selective retry.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";

export interface EnrichmentFailure {
    id: string;
    entityType: "artist" | "track" | "audio" | "vibe" | "podcast";
    entityId: string;
    entityName: string | null;
    errorMessage: string | null;
    errorCode: string | null;
    retryCount: number;
    maxRetries: number;
    firstFailedAt: Date;
    lastFailedAt: Date;
    skipped: boolean;
    skippedAt: Date | null;
    resolved: boolean;
    resolvedAt: Date | null;
    metadata: any;
}

export interface RecordFailureInput {
    entityType: "artist" | "track" | "audio" | "vibe" | "podcast";
    entityId: string;
    entityName?: string;
    errorMessage: string;
    errorCode?: string;
    metadata?: any;
}

export interface GetFailuresOptions {
    entityType?: "artist" | "track" | "audio" | "vibe" | "podcast";
    includeSkipped?: boolean;
    includeResolved?: boolean;
    limit?: number;
    offset?: number;
}

class EnrichmentFailureService {
    /**
     * Record a failure (or increment retry count if already exists)
     */
    async recordFailure(input: RecordFailureInput): Promise<EnrichmentFailure> {
        const {
            entityType,
            entityId,
            entityName,
            errorMessage,
            errorCode,
            metadata,
        } = input;

        // Try to find existing failure
        const existing = await prisma.enrichmentFailure.findUnique({
            where: {
                entityType_entityId: {
                    entityType,
                    entityId,
                },
            },
        });

        if (existing) {
            // Update existing failure - cap retry count at maxRetries to prevent unbounded increment
            const newRetryCount = Math.min(
                existing.retryCount + 1,
                existing.maxRetries
            );

            return await prisma.enrichmentFailure.update({
                where: { id: existing.id },
                data: {
                    errorMessage,
                    errorCode,
                    retryCount: newRetryCount,
                    lastFailedAt: new Date(),
                    metadata: metadata
                        ? JSON.parse(JSON.stringify(metadata))
                        : existing.metadata,
                },
            }) as EnrichmentFailure;
        } else {
            // Create new failure
            return await prisma.enrichmentFailure.create({
                data: {
                    entityType,
                    entityId,
                    entityName,
                    errorMessage,
                    errorCode,
                    retryCount: 1,
                    maxRetries: 3,
                    metadata: metadata
                        ? JSON.parse(JSON.stringify(metadata))
                        : null,
                },
            }) as EnrichmentFailure;
        }
    }

    /**
     * Get failures with filtering and pagination
     */
    async getFailures(options: GetFailuresOptions = {}): Promise<{
        failures: EnrichmentFailure[];
        total: number;
    }> {
        const {
            entityType,
            includeSkipped = false,
            includeResolved = false,
            limit = 100,
            offset = 0,
        } = options;

        const where: any = {};

        if (entityType) {
            where.entityType = entityType;
        }

        if (!includeSkipped) {
            where.skipped = false;
        }

        if (!includeResolved) {
            where.resolved = false;
        }

        const [failures, total] = await Promise.all([
            prisma.enrichmentFailure.findMany({
                where,
                orderBy: { lastFailedAt: "desc" },
                take: limit,
                skip: offset,
            }),
            prisma.enrichmentFailure.count({ where }),
        ]);

        return { failures: failures as unknown as EnrichmentFailure[], total };
    }

    /**
     * Get failure counts by type
     */
    async getFailureCounts(): Promise<{
        artist: number;
        track: number;
        audio: number;
        vibe: number;
        podcast: number;
        total: number;
    }> {
        const [artistCount, trackCount, audioCount, vibeCount, podcastCount] = await Promise.all([
            prisma.enrichmentFailure.count({
                where: {
                    entityType: "artist",
                    resolved: false,
                    skipped: false,
                },
            }),
            prisma.enrichmentFailure.count({
                where: { entityType: "track", resolved: false, skipped: false },
            }),
            prisma.enrichmentFailure.count({
                where: { entityType: "audio", resolved: false, skipped: false },
            }),
            prisma.enrichmentFailure.count({
                where: { entityType: "vibe", resolved: false, skipped: false },
            }),
            prisma.enrichmentFailure.count({
                where: { entityType: "podcast", resolved: false, skipped: false },
            }),
        ]);

        return {
            artist: artistCount,
            track: trackCount,
            audio: audioCount,
            vibe: vibeCount,
            podcast: podcastCount,
            total: artistCount + trackCount + audioCount + vibeCount + podcastCount,
        };
    }

    /**
     * Get a single failure by ID
     */
    async getFailure(id: string): Promise<EnrichmentFailure | null> {
        return await prisma.enrichmentFailure.findUnique({
            where: { id },
        }) as unknown as EnrichmentFailure | null;
    }

    /**
     * Mark failures as skipped (won't be retried automatically)
     */
    async skipFailures(ids: string[]): Promise<number> {
        const result = await prisma.enrichmentFailure.updateMany({
            where: { id: { in: ids } },
            data: {
                skipped: true,
                skippedAt: new Date(),
            },
        });

        return result.count;
    }

    /**
     * Mark failures as resolved (manually fixed)
     */
    async resolveFailures(ids: string[]): Promise<number> {
        const result = await prisma.enrichmentFailure.updateMany({
            where: { id: { in: ids } },
            data: {
                resolved: true,
                resolvedAt: new Date(),
            },
        });

        return result.count;
    }

    /**
     * Reset retry count for failures (prepare for retry)
     */
    async resetRetryCount(ids: string[]): Promise<number> {
        const result = await prisma.enrichmentFailure.updateMany({
            where: { id: { in: ids } },
            data: {
                retryCount: 0,
            },
        });

        return result.count;
    }

    /**
     * Delete failures (cleanup resolved/old failures)
     */
    async deleteFailures(ids: string[]): Promise<number> {
        const result = await prisma.enrichmentFailure.deleteMany({
            where: { id: { in: ids } },
        });

        return result.count;
    }

    /**
     * Clear all unresolved failures (optionally filtered by type)
     */
    async clearAllFailures(entityType?: "artist" | "track" | "audio" | "vibe" | "podcast"): Promise<number> {
        const where: any = {
            resolved: false,
            skipped: false,
        };

        if (entityType) {
            where.entityType = entityType;
        }

        const result = await prisma.enrichmentFailure.deleteMany({ where });

        logger.info(`Cleared ${result.count} enrichment failures${entityType ? ` of type ${entityType}` : ""}`);

        return result.count;
    }

    /**
     * Cleanup old resolved failures (older than specified days)
     */
    async cleanupOldResolved(olderThanDays: number = 30): Promise<number> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

        const result = await prisma.enrichmentFailure.deleteMany({
            where: {
                resolved: true,
                resolvedAt: {
                    lt: cutoffDate,
                },
            },
        });

        logger.debug(
            `[Enrichment Failures] Cleaned up ${result.count} old resolved failures`
        );
        return result.count;
    }

    /**
     * Check if an entity has failed too many times
     */
    async hasExceededRetries(
        entityType: string,
        entityId: string
    ): Promise<boolean> {
        const failure = await prisma.enrichmentFailure.findUnique({
            where: {
                entityType_entityId: {
                    entityType: entityType as any,
                    entityId,
                },
            },
        });

        if (!failure) return false;
        return failure.retryCount >= failure.maxRetries;
    }

    /**
     * Clear failure record (reset for fresh retry)
     */
    async clearFailure(entityType: string, entityId: string): Promise<void> {
        await prisma.enrichmentFailure.deleteMany({
            where: {
                entityType: entityType as any,
                entityId,
            },
        });
    }

    /**
     * Clean up failures for entities that no longer exist in the database.
     * This resolves orphaned failure records where the track/artist was deleted.
     */
    async cleanupOrphanedFailures(): Promise<{
        cleaned: number;
        checked: number;
    }> {
        // Get all unresolved failures
        const failures = await prisma.enrichmentFailure.findMany({
            where: { resolved: false, skipped: false },
            select: { id: true, entityType: true, entityId: true },
        });

        const toResolve: string[] = [];

        for (const failure of failures) {
            let exists = false;

            if (failure.entityType === "artist") {
                const artist = await prisma.artist.findUnique({
                    where: { id: failure.entityId },
                    select: { id: true },
                });
                exists = !!artist;
            } else if (
                failure.entityType === "track" ||
                failure.entityType === "audio"
            ) {
                const track = await prisma.track.findUnique({
                    where: { id: failure.entityId },
                    select: { id: true },
                });
                exists = !!track;
            } else if (failure.entityType === "podcast") {
                const podcast = await prisma.podcast.findUnique({
                    where: { id: failure.entityId },
                    select: { id: true },
                });
                exists = !!podcast;
            } else {
                // Unknown entity type — treat as existing to avoid silent deletion
                exists = true;
            }

            if (!exists) {
                toResolve.push(failure.id);
            }
        }

        if (toResolve.length > 0) {
            await this.resolveFailures(toResolve);
            logger.debug(
                `[Enrichment Failures] Cleaned up ${toResolve.length} orphaned failures`
            );
        }

        return { cleaned: toResolve.length, checked: failures.length };
    }

     /**
      * Resolve failure records for an entity (track/artist) that succeeded.
      * Used when a track's vibe embedding succeeds after previous failures.
      */
     async resolveByEntity(entityType: "vibe" | "audio", entityId: string): Promise<boolean> {
         const result = await prisma.enrichmentFailure.updateMany({
             where: {
                 entityType,
                 entityId,
                 resolved: false,
             },
             data: {
                 resolved: true,
                 resolvedAt: new Date(),
             },
         });

         if (result.count > 0) {
             logger.debug(
                 `[Enrichment Failures] Resolved ${result.count} failures for ${entityType}:${entityId}`
             );
         }

         return result.count > 0;
     }

}

// Singleton instance
export const enrichmentFailureService = new EnrichmentFailureService();
