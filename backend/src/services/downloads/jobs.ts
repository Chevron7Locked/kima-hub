/**
 * A download job's status, through five moves: start, complete, fail, cancel, retry.
 *
 * Each move runs in one statement and only from a state it can leave, so a job two
 * paths reach is settled once and told once: start and complete leave pending or
 * processing, fail and cancel the same, retry leaves failed or exhausted. Each
 * merges its metadata into what the row holds (a null value clears a field), so a
 * webhook that wrote in between keeps what it wrote. The moves that end a job tell
 * the user through the notification policy, and the Discover batch and the Spotify
 * import the job belongs to; retry tells nobody, because nothing has finished.
 *
 * Lidarr and slskd are not talked to here: that stays with the download manager.
 * The move returns the jobs it settled, with the metadata as it now is, so a caller
 * can see which of its jobs it was that settled.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { yieldToEventLoop } from "../../utils/async";
import { eventBus } from "../eventBus";
import { notificationService } from "../notificationService";
import { notificationPolicyService } from "../notificationPolicyService";

/** What a caller holds of a job it wants to move: only the id is read. */
export type JobRef = { id: string };

/** A job a move settled, as the move left it. */
export type SettledJob = {
    id: string;
    userId: string;
    subject: string;
    discoveryBatchId: string | null;
    status: string;
    error: string | null;
    metadata: Prisma.JsonValue;
};

export type Start = {
    correlationId: string;
    lidarrAlbumId: number | null;
    /** The download the job takes over, when it joins one already running. */
    lidarrRef?: string | null;
    artistMbid?: string | null;
    metadata?: Record<string, unknown>;
};

const ACTIVE = ["pending", "processing"];
const FAILED = ["failed", "exhausted"];

/** The metadata column with `patch` merged in: a null value clears its field, an undefined one is ignored. */
function mergedMetadata(patch: Record<string, unknown>, extra: Prisma.Sql = Prisma.empty): Prisma.Sql {
    const nulls = Object.keys(patch).filter((k) => patch[k] === null);
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined));
    return Prisma.sql`((CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END) - ${nulls}::text[]) || ${JSON.stringify(set)}::jsonb${extra}`;
}

/** Merges fields into a job's metadata in the database. A null value clears the field. */
export async function mergeMetadata(id: string, patch: Record<string, unknown>): Promise<void> {
    await prisma.$executeRaw`UPDATE "DownloadJob" SET metadata = ${mergedMetadata(patch)} WHERE id = ${id}`;
}

/** Moves the jobs that are in one of the `from` states, in one statement, and returns the ones it moved. */
async function settle(
    jobs: JobRef[],
    from: string[],
    columns: Prisma.Sql,
    patch: Record<string, unknown>
): Promise<SettledJob[]> {
    const ids = [...new Set(jobs.map((j) => j.id))];
    if (ids.length === 0) return [];
    return prisma.$queryRaw<SettledJob[]>`
        UPDATE "DownloadJob"
        SET ${columns}, metadata = ${mergedMetadata(patch)}
        WHERE id = ANY(${ids}::text[]) AND status = ANY(${from}::text[])
        RETURNING id, "userId", subject, "discoveryBatchId", status, error, metadata
    `;
}

/**
 * The job starts: it was pending or already running, and now holds an album in
 * Lidarr. A job counts as a library download unless it already says otherwise.
 * Returns false when the job was not in a state to start.
 */
export async function start(id: string, started: Start): Promise<boolean> {
    const now = new Date();
    const patch = { ...started.metadata, startedAt: now.toISOString() };
    const count = await prisma.$executeRaw`
        UPDATE "DownloadJob"
        SET "correlationId" = ${started.correlationId}::text,
            status = 'processing',
            "startedAt" = ${now},
            "lidarrAlbumId" = ${started.lidarrAlbumId}::int,
            "lidarrRef" = coalesce(${started.lidarrRef ?? null}::text, "lidarrRef"),
            "artistMbid" = coalesce(${started.artistMbid ?? null}::text, "artistMbid"),
            attempts = 1,
            metadata = ${mergedMetadata(
                patch,
                Prisma.sql` || jsonb_build_object('downloadType', coalesce(nullif(metadata->>'downloadType', ''), 'library'))`
            )}
        WHERE id = ${id} AND status = ANY(${ACTIVE}::text[])
    `;
    return count > 0;
}

/**
 * The jobs complete. A job another path already settled is left alone, so nobody is
 * told twice. `extra` joins the jobs' metadata.
 */
export async function complete(jobs: JobRef[], extra: Record<string, unknown> = {}): Promise<SettledJob[]> {
    const completedAt = new Date();
    const settled = await settle(
        jobs,
        ACTIVE,
        Prisma.sql`status = 'completed', error = NULL, "completedAt" = ${completedAt}`,
        { ...extra, parked: null, completedAt: completedAt.toISOString() }
    );
    await tell(settled, "complete");
    return settled;
}

/**
 * The jobs fail with `error`. A job another path already settled is left alone.
 * `patch` joins the jobs' metadata; its statusText replaces the default, which is the error.
 */
export async function fail(jobs: JobRef[], error: string, patch: Record<string, unknown> = {}): Promise<SettledJob[]> {
    const settled = await settle(
        jobs,
        ACTIVE,
        Prisma.sql`status = 'failed', error = ${error}, "completedAt" = now()`,
        { statusText: error, ...patch, failedAt: new Date().toISOString() }
    );
    await tell(settled, "failed", error);
    return settled;
}

/**
 * The user (or a cleanup on their behalf) stops the jobs. They end as failed with
 * the reason, marked cancelled in their metadata. The user is not told: the
 * notification policy keeps quiet for a cancel, as it asked for it. The caller does
 * the Lidarr side (the download manager's cancelJobs).
 */
export async function cancel(jobs: JobRef[], reason = "Cancelled by user"): Promise<SettledJob[]> {
    const settled = await settle(
        jobs,
        ACTIVE,
        Prisma.sql`status = 'failed', error = ${reason}, "completedAt" = now()`,
        { statusText: "Cancelled", cancelled: true, failedAt: new Date().toISOString() }
    );
    await tell(settled, "cancel", reason);
    return settled;
}

/**
 * A failed job goes back to pending to be run again. Its metadata stays, less the
 * marks of its failure, so its next outcome tells the user afresh. Starting it again
 * is the caller's: the download manager's startDownload, or a Soulseek search.
 */
export async function retry(jobs: JobRef[], patch: Record<string, unknown> = {}): Promise<SettledJob[]> {
    return settle(
        jobs,
        FAILED,
        Prisma.sql`status = 'pending', error = NULL, "completedAt" = NULL`,
        { statusText: "Retrying", ...patch, notificationSent: null, failedAt: null, cancelled: null, parked: null }
    );
}

type Outcome = "complete" | "failed" | "cancel";

/** Tells the user of each settled job, then each batch and import that owns any of them, once. */
async function tell(settled: SettledJob[], outcome: Outcome, error?: string): Promise<void> {
    const batches = new Set<string>();
    const imports = new Set<string>();
    for (const job of settled) {
        eventBus.emit(
            outcome === "complete"
                ? { type: "download:complete", userId: job.userId, payload: { jobId: job.id, subject: job.subject } }
                : { type: "download:failed", userId: job.userId, payload: { jobId: job.id, subject: job.subject, error } }
        );
        await tellUser(job, outcome, error);
        if (job.discoveryBatchId) batches.add(job.discoveryBatchId);
        const importId = (job.metadata as any)?.spotifyImportJobId;
        if (importId) imports.add(importId);
        if (outcome === "complete") await yieldToEventLoop();
    }

    if (batches.size > 0) {
        const { discoverWeeklyService } = await import("../discoverWeekly");
        for (const batchId of batches) {
            try {
                await discoverWeeklyService.checkBatchCompletion(batchId);
            } catch (batchError) {
                logger.error(`Failed to tell batch ${batchId} of a settled download:`, batchError);
            }
        }
    }
    if (imports.size > 0) {
        const { spotifyImportService } = await import("../spotifyImport");
        for (const importId of imports) {
            try {
                await spotifyImportService.checkImportCompletion(importId);
            } catch (importError) {
                logger.error(`Failed to tell import ${importId} of a settled download:`, importError);
            }
        }
    }
}

/** One tray row per album, when the notification policy says the user needs it. */
async function tellUser(job: SettledJob, outcome: Outcome, error?: string): Promise<void> {
    try {
        const decision = await notificationPolicyService.evaluateNotification(job.id, outcome);
        if (!decision.shouldNotify) {
            logger.debug(`   Suppressing ${outcome} notification: ${decision.reason}`);
            return;
        }
        if (outcome === "complete") {
            await notificationService.notifyDownloadComplete(
                job.userId,
                job.subject,
                undefined,
                (job.metadata as any)?.artistId
            );
        } else {
            await notificationService.notifyDownloadFailed(job.userId, job.subject, error);
        }
        await mergeMetadata(job.id, { notificationSent: true });
    } catch (notifError) {
        logger.error(`Failed to evaluate/send ${outcome} notification:`, notifError);
    }
}
