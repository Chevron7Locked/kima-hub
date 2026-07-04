/**
 * Enrichment Failure Service
 *
 * Tracks and manages failures during artist/track/audio enrichment.
 * Provides visibility into what failed and allows selective retry.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";

interface EnrichmentFailure {
    id: string;
    entityType: "artist" | "track" | "audio" | "vibe" | "podcast" | "scan";
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

interface RecordFailureInput {
    entityType: "artist" | "track" | "audio" | "vibe" | "podcast" | "scan";
    entityId: string;
    entityName?: string;
    errorMessage: string;
    errorCode?: string;
    metadata?: any;
}

interface GetFailuresOptions {
    entityType?: "artist" | "track" | "audio" | "vibe" | "podcast" | "scan";
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

        const serializedMeta = metadata
            ? JSON.parse(JSON.stringify(metadata))
            : null;

        return await prisma.enrichmentFailure.upsert({
            where: {
                entityType_entityId: { entityType, entityId },
            },
            create: {
                entityType,
                entityId,
                entityName,
                errorMessage,
                errorCode,
                retryCount: 1,
                maxRetries: 3,
                metadata: serializedMeta,
            },
            update: {
                errorMessage,
                errorCode,
                retryCount: { increment: 1 },
                lastFailedAt: new Date(),
                resolved: false,
                resolvedAt: null,
                skipped: false,
                skippedAt: null,
                metadata: metadata
                    ? serializedMeta
                    : undefined,
            },
        }) as EnrichmentFailure;
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
    async clearAllFailures(entityType?: "artist" | "track" | "audio" | "vibe" | "podcast" | "scan"): Promise<number> {
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

        // Group ids by entity type so existence can be checked with one findMany per
        // type instead of a findUnique per failure.
        const idsByType = new Map<string, Set<string>>();
        for (const failure of failures) {
            if (!idsByType.has(failure.entityType)) {
                idsByType.set(failure.entityType, new Set());
            }
            idsByType.get(failure.entityType)!.add(failure.entityId);
        }

        const existingArtistIds = idsByType.has("artist")
            ? new Set(
                  (
                      await prisma.artist.findMany({
                          where: { id: { in: [...idsByType.get("artist")!] } },
                          select: { id: true },
                      })
                  ).map((a) => a.id)
              )
            : new Set<string>();

        // track/audio/vibe/scan failures all reference a Track id
        const trackFailureIds = new Set<string>([
            ...(idsByType.get("track") ?? []),
            ...(idsByType.get("audio") ?? []),
            ...(idsByType.get("vibe") ?? []),
            ...(idsByType.get("scan") ?? []),
        ]);
        const existingTrackIds =
            trackFailureIds.size > 0
                ? new Set(
                      (
                          await prisma.track.findMany({
                              where: { id: { in: [...trackFailureIds] } },
                              select: { id: true },
                          })
                      ).map((t) => t.id)
                  )
                : new Set<string>();

        const existingPodcastIds = idsByType.has("podcast")
            ? new Set(
                  (
                      await prisma.podcast.findMany({
                          where: { id: { in: [...idsByType.get("podcast")!] } },
                          select: { id: true },
                      })
                  ).map((p) => p.id)
              )
            : new Set<string>();

        const toResolve: string[] = [];

        for (const failure of failures) {
            let exists: boolean;

            if (failure.entityType === "artist") {
                exists = existingArtistIds.has(failure.entityId);
            } else if (
                failure.entityType === "track" ||
                failure.entityType === "audio" ||
                failure.entityType === "vibe" ||
                failure.entityType === "scan"
            ) {
                exists = existingTrackIds.has(failure.entityId);
            } else if (failure.entityType === "podcast") {
                exists = existingPodcastIds.has(failure.entityId);
            } else {
                // Unknown entity type — treat as existing to avoid silent deletion
                exists = true;
            }

            if (!exists) {
                toResolve.push(failure.id);
            }
        }

        // Resolve failures for entities that subsequently succeeded on retry
        const staleSucceeded = await prisma.$queryRaw<{ id: string }[]>`
            SELECT ef.id FROM "EnrichmentFailure" ef
            JOIN "Track" t ON ef."entityId" = t.id
            WHERE ef.resolved = false AND ef.skipped = false
            AND (
                (ef."entityType" = 'audio' AND t."analysisStatus" = 'completed')
                OR (ef."entityType" = 'vibe' AND t."vibeAnalysisStatus" = 'completed')
            )
        `;
        for (const row of staleSucceeded) {
            toResolve.push(row.id);
        }

        if (toResolve.length > 0) {
            await this.resolveFailures(toResolve);
            logger.debug(
                `[Enrichment Failures] Cleaned up ${toResolve.length} orphaned/stale failures`
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
