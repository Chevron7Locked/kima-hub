/**
 * Enrichment failures for the settings screen, with selective retry. Per-track
 * stage failures are read from TrackStage and mapped onto the EnrichmentFailure
 * shape; the EnrichmentFailure table holds only entities without stage records
 * (artists, podcasts). Failures are resolved rather than deleted;
 * cleanupOldResolved purges rows that have stayed resolved.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { STAGE_RETRY_CAP } from "../workers/stageRetry";

/**
 * The track stages whose failures the failures API serves, and the
 * EnrichmentFailure entityType each maps to — the vocabulary the frontend
 * already knows (recording→"track", analysis→"audio", embedding→"vibe",
 * fingerprint→"scan").
 */
const ENTITY_TYPE_BY_STAGE: Record<string, "track" | "audio" | "vibe" | "scan"> = {
    recording: "track",
    analysis: "audio",
    embedding: "vibe",
    fingerprint: "scan",
};
const STAGES_BY_ENTITY_TYPE: Record<string, string[]> = Object.entries(
    ENTITY_TYPE_BY_STAGE,
).reduce<Record<string, string[]>>((acc, [stage, entityType]) => {
    (acc[entityType] ??= []).push(stage);
    return acc;
}, {});

/** True for the failure entityTypes that are backed by TrackStage rows. */
function isTrackStageEntityType(
    entityType: string | undefined,
): boolean {
    return (
        entityType === "track" ||
        entityType === "audio" ||
        entityType === "vibe" ||
        entityType === "scan"
    );
}

/** A TrackStage row joined with its track title, as the reads fetch it. */
interface StageFailureRow {
    id: string;
    trackId: string;
    stage: string;
    status: string;
    source: string | null;
    attempt: number;
    failures: number;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    evidence: unknown;
    startedAt: Date | null;
    finishedAt: Date | null;
    decidedAt: Date | null;
    track: { title: string | null };
}

/**
 * Map a TrackStage row onto the EnrichmentFailure response shape. The
 * mapping is the contract: the settings UI renders these fields unchanged.
 */
function mapStageFailure(row: StageFailureRow): EnrichmentFailure {
    const blocked = row.status === "blocked";
    const lastFailedAt = row.finishedAt ?? row.startedAt ?? new Date(0);
    return {
        id: row.id,
        entityType: ENTITY_TYPE_BY_STAGE[row.stage] ?? "track",
        entityId: row.trackId,
        entityName: row.track?.title ?? row.trackId,
        errorMessage: row.lastErrorMessage,
        errorCode: row.lastErrorCode,
        retryCount: row.failures,
        maxRetries: STAGE_RETRY_CAP,
        firstFailedAt: row.startedAt ?? lastFailedAt,
        lastFailedAt,
        // "skipped" (a human parked the question) is the stage record's blocked state.
        skipped: blocked,
        skippedAt: blocked ? row.decidedAt ?? null : null,
        // A failed stage record is, by definition, unresolved; answered
        // records are never surfaced at all.
        resolved: false,
        resolvedAt: null,
        metadata: {
            stage: row.stage,
            source: row.source,
            evidence: row.evidence ?? null,
        },
    };
}

/**
 * A missing file is not a failure: the scan closes its records as FILE_MISSING and
 * reopens them when the file returns, and progress counts them as waiting.
 */
const NOT_FILE_MISSING = { OR: [{ failureClass: null }, { failureClass: { not: "FILE_MISSING" } }] };

/** A stage record of a library song: Discover songs are never enriched, so their old failures are not listed. */
const LIBRARY_SONG_STAGE = { track: { album: { location: "LIBRARY" as const } } };

/** The TrackStage `where` for the failure list: open failures only. */
function stageFailureWhere(stages: string[], includeSkipped: boolean): any {
    const where: any = { stage: { in: stages }, status: "failed", ...NOT_FILE_MISSING, ...LIBRARY_SONG_STAGE };
    if (includeSkipped) {
        // Blocked rows are the parked ones; only list them when asked for.
        where.status = { in: ["failed", "blocked"] };
    }
    return where;
}

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
     * Failures with filtering and pagination. Track-stage types read TrackStage,
     * artist and podcast read the ledger, an unfiltered call unions both.
     * `includeResolved` affects only the ledger; an answered stage record is never a failure.
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

        const readStages =
            entityType === undefined || isTrackStageEntityType(entityType);
        const stages = readStages
            ? entityType === undefined
                ? Object.keys(ENTITY_TYPE_BY_STAGE)
                : STAGES_BY_ENTITY_TYPE[entityType as string] ?? []
            : [];
        const ledgerTypes =
            entityType === undefined
                ? ["artist", "podcast"]
                : entityType === "artist" || entityType === "podcast"
                ? [entityType]
                : [];

        const ledgerWhere = {
            entityType: { in: ledgerTypes },
            ...(includeSkipped ? {} : { skipped: false }),
            ...(includeResolved ? {} : { resolved: false }),
        };

        const [stageRows, ledgerRows, stageTotal, ledgerTotal] = await Promise.all([
            readStages
                ? prisma.trackStage.findMany({
                      where: stageFailureWhere(stages, includeSkipped),
                      include: { track: { select: { title: true } } },
                      orderBy: { finishedAt: "desc" },
                      take: limit + offset,
                  })
                : Promise.resolve([] as unknown as (StageFailureRow & { track: { title: string | null } })[]),
            ledgerTypes.length > 0
                ? prisma.enrichmentFailure.findMany({
                      where: ledgerWhere,
                      orderBy: { lastFailedAt: "desc" },
                      take: limit + offset,
                  })
                : Promise.resolve([] as unknown as EnrichmentFailure[]),
            readStages
                ? prisma.trackStage.count({ where: stageFailureWhere(stages, includeSkipped) })
                : Promise.resolve(0),
            ledgerTypes.length > 0
                ? prisma.enrichmentFailure.count({ where: ledgerWhere })
                : Promise.resolve(0),
        ]);

        const merged = [
            ...(stageRows as unknown as StageFailureRow[]).map(mapStageFailure),
            ...(ledgerRows as unknown as EnrichmentFailure[]),
        ].sort(
            (a, b) => new Date(b.lastFailedAt).getTime() - new Date(a.lastFailedAt).getTime(),
        );

        return { failures: merged.slice(offset, offset + limit), total: stageTotal + ledgerTotal };
    }

    /**
     * Get failure counts by type.
     *
     * Track-stage buckets (track/audio/vibe/scan) count open TrackStage
     * failures; artist/podcast count open EnrichmentFailure rows.
     */
    async getFailureCounts(): Promise<{
        artist: number;
        track: number;
        audio: number;
        vibe: number;
        scan: number;
        podcast: number;
        total: number;
    }> {
        const [artistCount, podcastCount, recordingCount, analysisCount, embeddingCount, fingerprintCount] =
            await Promise.all([
                prisma.enrichmentFailure.count({
                    where: {
                        entityType: "artist",
                        resolved: false,
                        skipped: false,
                    },
                }),
                prisma.enrichmentFailure.count({
                    where: {
                        entityType: "podcast",
                        resolved: false,
                        skipped: false,
                    },
                }),
                prisma.trackStage.count({
                    where: { stage: "recording", status: "failed", ...NOT_FILE_MISSING, ...LIBRARY_SONG_STAGE },
                }),
                prisma.trackStage.count({
                    where: { stage: "analysis", status: "failed", ...NOT_FILE_MISSING, ...LIBRARY_SONG_STAGE },
                }),
                prisma.trackStage.count({
                    where: { stage: "embedding", status: "failed", ...NOT_FILE_MISSING, ...LIBRARY_SONG_STAGE },
                }),
                prisma.trackStage.count({
                    where: { stage: "fingerprint", status: "failed", ...NOT_FILE_MISSING, ...LIBRARY_SONG_STAGE },
                }),
            ]);

        return {
            artist: artistCount,
            track: recordingCount,
            audio: analysisCount,
            vibe: embeddingCount,
            scan: fingerprintCount,
            podcast: podcastCount,
            total:
                artistCount +
                recordingCount +
                analysisCount +
                embeddingCount +
                fingerprintCount +
                podcastCount,
        };
    }

    /**
     * Get a single failure by ID. TrackStage-backed entries carry their
     * stage-record id; ledger entries their EnrichmentFailure id — try the
     * stage record first, then the ledger.
     */
    async getFailure(id: string): Promise<EnrichmentFailure | null> {
        const stage = await prisma.trackStage.findFirst({
            where: { id, stage: { in: Object.keys(ENTITY_TYPE_BY_STAGE) } },
            include: { track: { select: { title: true } } },
        });
        if (stage) {
            return mapStageFailure(stage as unknown as StageFailureRow);
        }
        return await prisma.enrichmentFailure.findUnique({
            where: { id },
        }) as unknown as EnrichmentFailure | null;
    }

    /**
     * Split a list of failure ids into stage-record ids (TrackStage-backed
     * entries) and ledger ids (EnrichmentFailure rows), so the mutations
     * below can serve both kinds with the same route contract.
     */
    private async splitIds(ids: string[]): Promise<{
        stageIds: string[];
        ledgerIds: string[];
    }> {
        if (ids.length === 0) return { stageIds: [], ledgerIds: [] };
        const rows = await prisma.trackStage.findMany({
            where: { id: { in: ids } },
            select: { id: true },
        });
        const stageIdSet = new Set(rows.map((r) => r.id));
        return {
            stageIds: ids.filter((id) => stageIdSet.has(id)),
            ledgerIds: ids.filter((id) => !stageIdSet.has(id)),
        };
    }

    /**
     * Mark failures resolved. Ledger rows: only unresolved ones, so resolvedAt is
     * never rewritten. Stage records are parked `blocked`, a human decision, so
     * they stop surfacing and are never re-asked behind the operator's back.
     */
    async resolveFailures(ids: string[]): Promise<number> {
        const { stageIds, ledgerIds } = await this.splitIds(ids);

        let stageCount = 0;
        if (stageIds.length > 0) {
            const result = await prisma.trackStage.updateMany({
                where: { id: { in: stageIds }, status: { in: ["failed", "pending", "working"] } },
                data: {
                    status: "blocked",
                    retryable: false,
                    nextRetryAt: null,
                    decidedAt: new Date(),
                    decidedBy: "resolved-via-failures-api",
                },
            });
            stageCount = result.count;
        }

        let ledgerCount = 0;
        if (ledgerIds.length > 0) {
            const result = await prisma.enrichmentFailure.updateMany({
                where: { id: { in: ledgerIds }, resolved: false },
                data: {
                    resolved: true,
                    resolvedAt: new Date(),
                },
            });
            ledgerCount = result.count;
        }

        return stageCount + ledgerCount;
    }

    /**
     * Reset retry count for failures (prepare for retry).
     *
     * A stage record's retry budget is its `failures`; the ledger row's is
     * `retryCount`.
     */
    async resetRetryCount(ids: string[]): Promise<number> {
        const { stageIds, ledgerIds } = await this.splitIds(ids);

        let stageCount = 0;
        if (stageIds.length > 0) {
            const result = await prisma.trackStage.updateMany({
                where: { id: { in: stageIds } },
                data: { failures: 0 },
            });
            stageCount = result.count;
        }

        let ledgerCount = 0;
        if (ledgerIds.length > 0) {
            const result = await prisma.enrichmentFailure.updateMany({
                where: { id: { in: ledgerIds } },
                data: {
                    retryCount: 0,
                },
            });
            ledgerCount = result.count;
        }

        return stageCount + ledgerCount;
    }

    /**
     * Reopen TrackStage-backed failures (pending, retries restored, error cleared) so
     * the next cycle asks again. Ledger ids are ignored; the /retry route resets artists.
     */
    async retryStageFailures(ids: string[]): Promise<number> {
        const { stageIds } = await this.splitIds(ids);
        if (stageIds.length === 0) return 0;
        const result = await prisma.trackStage.updateMany({
            // A file that is gone stays closed until a scan finds it again.
            where: { id: { in: stageIds }, status: { in: ["failed", "blocked"] }, track: { missingSince: null } },
            data: {
                status: "pending",
                failures: 0,
                lastErrorCode: null,
                lastErrorMessage: null,
                failureClass: null,
                retryable: true,
                nextRetryAt: null,
                startedAt: null,
                finishedAt: null,
                decidedAt: null,
                decidedBy: null,
            },
        });
        return result.count;
    }

    /**
     * Resolve all unresolved failures, optionally by type, without deleting any:
     * stage records are parked `blocked`, ledger rows are resolved once and keep
     * any human disposition.
     */
    async resolveAllFailures(entityType?: "artist" | "track" | "audio" | "vibe" | "podcast" | "scan"): Promise<number> {
        let total = 0;

        if (entityType === undefined || isTrackStageEntityType(entityType)) {
            const stages =
                entityType === undefined
                    ? Object.keys(ENTITY_TYPE_BY_STAGE)
                    : STAGES_BY_ENTITY_TYPE[entityType as string] ?? [];
            const result = await prisma.trackStage.updateMany({
                // The failures the list shows: a Discover song's old record stays as it is, so a like still enriches it.
                where: { stage: { in: stages }, status: "failed", ...NOT_FILE_MISSING, ...LIBRARY_SONG_STAGE },
                data: {
                    status: "blocked",
                    retryable: false,
                    nextRetryAt: null,
                    decidedAt: new Date(),
                    decidedBy: "resolved-all-via-failures-api",
                },
            });
            total += result.count;
        }

        const ledgerTypes =
            entityType === undefined
                ? ["artist", "podcast"]
                : entityType === "artist" || entityType === "podcast"
                ? [entityType]
                : [];

        if (ledgerTypes.length > 0) {
            const result = await prisma.enrichmentFailure.updateMany({
                where: {
                    entityType: { in: ledgerTypes },
                    resolved: false,
                    skipped: false,
                },
                data: {
                    resolved: true,
                    resolvedAt: new Date(),
                },
            });
            total += result.count;
        }

        logger.info(`Resolved ${total} enrichment failures${entityType ? ` of type ${entityType}` : ""}`);

        return total;
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
     * Which failures still have their subject: the artist, the track (for track, audio, vibe and scan failures) or the
     * podcast. One query per kind. An unknown kind counts as existing, so nothing is resolved by mistake.
     */
    async subjectsThatExist(
        failures: Array<{ entityType: string; entityId: string }>,
    ): Promise<(failure: { entityType: string; entityId: string }) => boolean> {
        const idsOf = (isKind: (entityType: string) => boolean) => [
            ...new Set(failures.filter((f) => isKind(f.entityType)).map((f) => f.entityId)),
        ];
        const found = async (ids: string[], find: (ids: string[]) => Promise<Array<{ id: string }>>) =>
            new Set(ids.length > 0 ? (await find(ids)).map((r) => r.id) : []);

        const [artists, tracks, podcasts] = await Promise.all([
            found(idsOf((t) => t === "artist"), (ids) => prisma.artist.findMany({ where: { id: { in: ids } }, select: { id: true } })),
            found(idsOf(isTrackStageEntityType), (ids) => prisma.track.findMany({ where: { id: { in: ids } }, select: { id: true } })),
            found(idsOf((t) => t === "podcast"), (ids) => prisma.podcast.findMany({ where: { id: { in: ids } }, select: { id: true } })),
        ]);

        return (failure) => {
            if (failure.entityType === "artist") return artists.has(failure.entityId);
            if (isTrackStageEntityType(failure.entityType)) return tracks.has(failure.entityId);
            if (failure.entityType === "podcast") return podcasts.has(failure.entityId);
            return true;
        };
    }

    /** Resolve failure records whose track, artist or podcast no longer exists. */
    async cleanupOrphanedFailures(): Promise<{
        cleaned: number;
        checked: number;
    }> {
        // Get all unresolved failures
        const failures = await prisma.enrichmentFailure.findMany({
            where: { resolved: false, skipped: false },
            select: { id: true, entityType: true, entityId: true },
        });

        const exists = await this.subjectsThatExist(failures);
        const toResolve: string[] = [];

        for (const failure of failures) {
            if (!exists(failure)) {
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
     * Resolve an entity's leftover failure rows after it enriched
     * successfully.
     */
    async resolveByEntity(entityType: "vibe" | "audio" | "artist" | "podcast", entityId: string): Promise<boolean> {
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
