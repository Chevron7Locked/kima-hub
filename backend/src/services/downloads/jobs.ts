/**
 * A download job's status, through ten moves: create, start, grab, hold, resume, complete, fail, cancel, retry, park.
 * No other code writes a job's status.
 *
 * Each move runs in one statement and only from a state it can leave, so a job two
 * paths reach is settled once and told once: start and complete leave pending or
 * processing, fail and cancel the same, retry leaves failed or exhausted. Each
 * merges its metadata into what the row holds (a null value clears a field), so a
 * webhook that wrote in between keeps what it wrote. The moves that end a job tell
 * the user through the notification policy, and the Discover batch and the Spotify
 * import the job belongs to; retry tells nobody, because nothing has finished. Park keeps a job
 * running while Lidarr holds its download for a person, and tells the user once. A job's attempt
 * count is kept through a retry: start sets it to 1 only for a job that has none. Create opens a job
 * (pending, or processing for a download already under way), in the caller's transaction when it has
 * one. Grab gives the jobs waiting for an album the Lidarr download that took it, hold puts a job back
 * to pending while Lidarr is away, and resume claims a held job for its next start.
 *
 * A move answers once the rows and the user's notice are written. The Discover batch's
 * and the import's completion checks run after it, detached (a batch check can wait
 * 60 s for Lidarr), one at a time per batch and per import, with a failure logged.
 * `whenIdle` waits for them, and for any move still writing or telling, for tests and shutdown. `withoutFailureMarks` is the
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

/** Every status a download job can have. */
export const JOB_STATUSES: readonly string[] = ["pending", "processing", "completed", "failed", "exhausted"];

const ACTIVE = ["pending", "processing"];
const FAILED = ["failed", "exhausted"];

/** Whether a settled job ended because the user stopped it, not because the download failed. */
export function isCancelled(job: { metadata: Prisma.JsonValue }): boolean {
    const metadata = job.metadata;
    return !!metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.cancelled === true;
}

export type CreateInput = {
    userId: string;
    subject: string;
    type: string;
    targetMbid?: string | null;
    artistMbid?: string | null;
    discoveryBatchId?: string | null;
    /** Pending waits to be started. Processing is for a download already under way: attempt 1, started now. */
    status?: "pending" | "processing";
    metadata?: Prisma.InputJsonObject;
};

/** Opens a job. Pass the transaction's client to open it inside one. */
export function create(input: CreateInput, db: Pick<Prisma.TransactionClient, "downloadJob"> = prisma) {
    const { status = "pending", ...fields } = input;
    return db.downloadJob.create({
        data: { ...fields, status, ...(status === "processing" ? { attempts: 1, startedAt: new Date() } : {}) },
    });
}

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
    patch: Record<string, unknown>,
    also: Prisma.Sql = Prisma.empty
): Promise<SettledJob[]> {
    const ids = [...new Set(jobs.map((j) => j.id))];
    if (ids.length === 0) return [];
    return prisma.$queryRaw<SettledJob[]>`
        UPDATE "DownloadJob"
        SET ${columns}, metadata = ${mergedMetadata(patch)}
        WHERE id = ANY(${ids}::text[]) AND status = ANY(${from}::text[]) ${also}
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
export function park(jobs: JobRef[], reason: string): Promise<SettledJob[]> {
    return moving(async () => {
        const why = reason.trim() || "Lidarr is holding it";
        // A job is parked when it has the field, whatever its text says.
        const parked = await settle(
            jobs,
            ["processing"],
            Prisma.sql`status = status`,
            { parked: why, statusText: `Waiting in Lidarr: ${why}` },
            Prisma.sql`AND NOT (coalesce(metadata, '{}'::jsonb) ? 'parked')`
        );
        for (const job of parked) await tellUser(job, "parked", why);
        return parked;
    });
}

/**
 * Lidarr is down or unhealthy: the jobs wait as pending until the health monitor resumes them. `patch` joins their
 * metadata. A job already settled is left alone. Nobody is told: nothing has happened to the download.
 */
export async function hold(jobs: JobRef[], patch: Record<string, unknown> = {}): Promise<SettledJob[]> {
    return settle(jobs, ACTIVE, Prisma.sql`status = 'pending'`, {
        statusText: "Waiting for Lidarr",
        ...patch,
        waitingForLidarr: true,
    });
}

/**
 * A held job is claimed for its next start: it stops being held and records when it began waiting to run. A job
 * two paths resume is claimed by one, and one that is not held is left alone.
 */
export async function resume(jobs: JobRef[]): Promise<SettledJob[]> {
    return settle(
        jobs,
        ["pending"],
        Prisma.sql`status = status`,
        { waitingForLidarr: null, pendingSince: new Date().toISOString() },
        Prisma.sql`AND metadata->>'waitingForLidarr' = 'true'`
    );
}

/**
 * Lidarr grabbed a release: the jobs still waiting for its album take the download. A job that is settled, or that
 * already has a download, is left alone, so two grabs of one album do not both claim it. A job waiting for missing
 * tracks follows the new download instead (its park and status text go), and a bundle, once seen, stays on record.
 */
export async function grab(
    jobs: JobRef[],
    grabbed: { downloadId: string; lidarrAlbumId: number; albumMbid: string; bundle: boolean }
): Promise<SettledJob[]> {
    const { downloadId, lidarrAlbumId, albumMbid, bundle } = grabbed;
    return settle(
        jobs,
        ACTIVE,
        Prisma.sql`status = 'processing',
            "lidarrRef" = ${downloadId}::text,
            "lidarrAlbumId" = coalesce(${lidarrAlbumId || null}::int, "lidarrAlbumId"),
            "targetMbid" = coalesce(nullif("targetMbid", ''), nullif(${albumMbid}::text, ''), "targetMbid")`,
        {
            parked: null,
            statusText: null,
            downloadId,
            lidarrMbid: albumMbid,
            grabbedAt: new Date().toISOString(),
            grabbedAsBundle: bundle,
            ...(bundle ? { hadBundle: true } : {}),
        },
        Prisma.sql`AND "lidarrRef" IS NULL`
    );
}

/**
 * The jobs complete. A job another path already settled is left alone, so nobody is
 * told twice. `extra` joins the jobs' metadata.
 */
export function complete(jobs: JobRef[], extra: Record<string, unknown> = {}): Promise<SettledJob[]> {
    return moving(async () => {
        const completedAt = new Date();
        const settled = await settle(
            jobs,
            ACTIVE,
            Prisma.sql`status = 'completed', error = NULL, "completedAt" = ${completedAt}`,
            { ...extra, parked: null, completedAt: completedAt.toISOString() }
        );
        await tell(settled, "complete");
        return settled;
    });
}

/**
 * The jobs fail with `error`. A job another path already settled is left alone.
 * `patch` joins the jobs' metadata; its statusText replaces the default, which is the error.
 */
export function fail(jobs: JobRef[], error: string, patch: Record<string, unknown> = {}): Promise<SettledJob[]> {
    return moving(async () => {
        const settled = await settle(
            jobs,
            ACTIVE,
            Prisma.sql`status = 'failed', error = ${error}, "completedAt" = now()`,
            { statusText: error, ...patch, failedAt: new Date().toISOString() }
        );
        await tell(settled, "failed", error);
        return settled;
    });
}

/**
 * The user (or a cleanup on their behalf) stops the jobs. They end as failed with
 * the reason, marked cancelled in their metadata. The user is not told: the
 * notification policy keeps quiet for a cancel, as it asked for it. The caller does
 * the Lidarr side (the download manager's cancelJobs).
 */
export function cancel(jobs: JobRef[], reason = "Cancelled by user"): Promise<SettledJob[]> {
    return moving(async () => {
        const settled = await settle(
            jobs,
            ACTIVE,
            Prisma.sql`status = 'failed', error = ${reason}, "completedAt" = now()`,
            { statusText: "Cancelled", cancelled: true, failedAt: new Date().toISOString() }
        );
        await tell(settled, "cancel", reason);
        return settled;
    });
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
 * Runs a move that ends or parks jobs and holds it in `checking` until it answers, so `whenIdle` also waits for a
 * move that has written its rows but not yet told anyone. The batch and import checks it starts join `checking`
 * before it answers, so the set is never empty between the move and its checks.
 */
async function moving<T>(move: () => Promise<T>): Promise<T> {
    const run = move();
    const held = run.then(() => undefined, () => undefined);
    checking.add(held);
    void held.finally(() => checking.delete(held));
    return run;
}

/**
 * Resolves when every move and every batch and import check it started has ended, or after `timeoutMs` when one is
 * given. For tests, for shutdown (before the database closes), and for a route that removes the rows a check reads: a check
 * reads its jobs as it starts, so a short wait lets it see them while one that goes on to wait for Lidarr does not
 * hold the route.
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
