/**
 * A download job's status, through six moves: start, complete, fail, cancel, retry, park.
 *
 * Each move runs in one statement and only from a state it can leave, so a job two
 * paths reach is settled once and told once: start and complete leave pending or
 * processing, fail and cancel the same, retry leaves failed or exhausted. Each
 * merges its metadata into what the row holds (a null value clears a field), so a
 * webhook that wrote in between keeps what it wrote. The moves that end a job tell
 * the user through the notification policy, and the Discover batch and the Spotify
 * import the job belongs to; retry tells nobody, because nothing has finished. Park keeps a job
 * running while Lidarr holds its download for a person, and tells the user once. A job's attempt
 * count is kept through a retry: start sets it to 1 only for a job that has none.
 *
 * A move answers once the rows and the user's notice are written. The Discover batch's
 * and the import's completion checks run after it, detached (a batch check can wait
 * 60 s for Lidarr), one at a time per batch and per import, with a failure logged.
 * `whenIdle` waits for them, for tests and shutdown. `withoutFailureMarks` is the
 * metadata of a job with what a failure left on it removed, for a retry or a re-queue.
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

/** A job a move settled (or parked), as the move left it. */
export type SettledJob = {
    id: string;
    userId: string;
    subject: string;
    discoveryBatchId: string | null;
    status: string;
    error: string | null;
    metadata: Prisma.JsonValue;
};

export type StartInput = {
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
export async function start(id: string, started: StartInput):Promise<boolean> {
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
            attempts = greatest(attempts, 1),
            metadata = ${mergedMetadata(
                patch,
                Prisma.sql` || jsonb_build_object('downloadType', coalesce(nullif(metadata->>'downloadType', ''), 'library'))`
            )}
        WHERE id = ${id} AND status = ANY(${ACTIVE}::text[])
    `;
    return count > 0;
}

/**
 * Lidarr parked the jobs' download for a person (tracks missing, or an import it only half did): the jobs stay
 * running and wait. A job parks once, however many paths reach it, and tells the user once, through the notification
 * policy, when it first waits. Returns the jobs it parked.
 */
export async function park(jobs: JobRef[], reason: string): Promise<SettledJob[]> {
    const ids = [...new Set(jobs.map((j) => j.id))];
    if (ids.length === 0) return [];
    const parked = await prisma.$queryRaw<SettledJob[]>`
        UPDATE "DownloadJob"
        SET metadata = ${mergedMetadata({ parked: reason, statusText: `Waiting in Lidarr: ${reason}` })}
        WHERE id = ANY(${ids}::text[]) AND status = 'processing' AND nullif(metadata->>'parked', '') IS NULL
        RETURNING id, "userId", subject, "discoveryBatchId", status, error, metadata
    `;
    for (const job of parked) await tellUser(job, "parked", reason);
    return parked;
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
        {
            statusText: "Retrying",
            ...patch,
            ...Object.fromEntries(FAILURE_MARKS.filter((mark) => mark !== "statusText").map((mark) => [mark, null])),
        }
    );
}

/** The metadata fields a failure leaves on a job. A retry clears them, so the next outcome tells the user afresh. */
export const FAILURE_MARKS = ["notificationSent", "failedAt", "cancelled", "parked", "statusText"] as const;

/** A failed job's metadata without the marks of its failure: what a retry or a copy of the job starts from. */
export function withoutFailureMarks(metadata: unknown): Record<string, unknown> {
    const kept: Record<string, unknown> =
        metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
    for (const mark of FAILURE_MARKS) delete kept[mark];
    return kept;
}

type Outcome = "complete" | "failed" | "cancel" | "parked";

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

    if (batches.size > 0 || imports.size > 0) tellBatchesAndImports(batches, imports);
}

/** The batch and import checks still running after the moves that started them answered. */
const checking = new Set<Promise<void>>();

/**
 * Resolves when every batch and import check a move started has ended, or after `timeoutMs` when one is given. For
 * tests, and for a route that removes the rows a check reads: a check reads its jobs as it starts, so a short wait
 * lets it see them while one that goes on to wait for Lidarr does not hold the route.
 */
export async function whenIdle(timeoutMs?: number): Promise<void> {
    const idle = (async () => {
        while (checking.size > 0) await Promise.allSettled([...checking]);
    })();
    if (timeoutMs === undefined) return idle;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([idle, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
}

/**
 * Starts the batch and import completion checks and returns. A check can run a scan and wait on a queue for a minute,
 * which a user cancelling a download must not wait for. A check that throws is logged: the job has settled already.
 */
function tellBatchesAndImports(batches: Set<string>, imports: Set<string>): void {
    const tasks: Promise<void>[] = [];
    for (const batchId of batches) {
        tasks.push(
            inLane(`batch:${batchId}`, async () => {
                try {
                    const { discoverWeeklyService } = await import("../discoverWeekly");
                    await discoverWeeklyService.checkBatchCompletion(batchId);
                } catch (batchError) {
                    logger.error(`Failed to tell batch ${batchId} of a settled download:`, batchError);
                }
            })
        );
    }
    for (const importId of imports) {
        tasks.push(
            inLane(`import:${importId}`, async () => {
                try {
                    const { spotifyImportService } = await import("../spotifyImport");
                    await spotifyImportService.checkImportCompletion(importId);
                } catch (importError) {
                    logger.error(`Failed to tell import ${importId} of a settled download:`, importError);
                }
            })
        );
    }
    const run = Promise.all(tasks).then(() => undefined);
    checking.add(run);
    void run.finally(() => checking.delete(run));
}

/** The latest check queued for each batch or import. */
const lanes = new Map<string, Promise<void>>();

/**
 * Runs checks of one batch or import one after another: jobs settle together, and two checks of one batch at once
 * would both move it on. A task must not throw.
 */
function inLane(key: string, task: () => Promise<void>): Promise<void> {
    const next = (lanes.get(key) ?? Promise.resolve()).then(task);
    lanes.set(key, next);
    void next.finally(() => {
        if (lanes.get(key) === next) lanes.delete(key);
    });
    return next;
}

/**
 * One tray row per album, when the notification policy says the user needs it. A complete or failed job claims
 * `notificationSent` first, in one conditional write, and tells only if it won, so two settlers that both passed the
 * policy tell once. A claim whose tray row could not be made is given back. A parked job's claim is its parking.
 */
async function tellUser(job: SettledJob, outcome: Outcome, error?: string): Promise<void> {
    let claimed = false;
    try {
        const decision = await notificationPolicyService.evaluateNotification(job.id, outcome);
        if (!decision.shouldNotify) {
            logger.debug(`   Suppressing ${outcome} notification: ${decision.reason}`);
            return;
        }
        if (outcome === "parked") {
            await notificationService.notifyDownloadWaiting(job.userId, job.subject, error ?? "");
            return;
        }
        claimed = await claimNotification(job.id);
        if (!claimed) {
            logger.debug(`   Another settler already told the user of job ${job.id}`);
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
    } catch (notifError) {
        logger.error(`Failed to evaluate/send ${outcome} notification:`, notifError);
        if (claimed) await mergeMetadata(job.id, { notificationSent: null }).catch(() => undefined);
    }
}

/** Marks the job as told, if no one has. True for the one caller that did. */
async function claimNotification(id: string): Promise<boolean> {
    const won = await prisma.$queryRaw<{ id: string }[]>`
        UPDATE "DownloadJob"
        SET metadata = ${mergedMetadata({ notificationSent: true })}
        WHERE id = ${id} AND coalesce(metadata->>'notificationSent', '') <> 'true'
        RETURNING id
    `;
    return won.length > 0;
}
