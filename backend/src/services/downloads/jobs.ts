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
 * `whenIdle` waits for them, and for any move that tells (park, complete, fail, cancel) still writing or
 * telling, for tests and shutdown. `withoutFailureMarks` is the metadata of a job with what a failure left
 * on it removed, for a retry or a re-queue.
 *
 * Around the moves: `findActive` is the one dedupe lookup, asking what the active-job unique indexes enforce (person,
 * kind, album or song id and Discover batch, a dismissed job included; albums and pending-song retries have one each);
 * `createOnce` opens a job unless that lookup finds one running; `retryOnce` clears a failed job and makes its replacement
 * in one transaction, or answers the job already running, or that another retry was here first; `dismiss` and `dismissAllSettled` take settled jobs off the
 * list and leave running ones.
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
/** A settled job has left pending and processing: completed or failed. */
const SETTLED = ["completed", ...FAILED];

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

/** What the active-album index calls one album: the same person, kind of job, album and Discover batch (none for a library job). */
export type ActiveKey = {
    userId: string;
    type: string;
    targetMbid: string;
    discoveryBatchId?: string | null;
};

type JobDb = Pick<Prisma.TransactionClient, "downloadJob">;

/**
 * The pending or running job an active-job unique index (album or track) would collide with, or null. It asks the
 * index's own question: a dismissed job still counts (the index ignores `cleared`), and a library job, a Discover
 * batch's job and a track job of one album id are different jobs. Every dedupe before a create asks this.
 */
export function findActive(key: ActiveKey, db: JobDb = prisma) {
    return db.downloadJob.findFirst({
        where: {
            userId: key.userId,
            type: key.type,
            targetMbid: key.targetMbid,
            discoveryBatchId: key.discoveryBatchId ?? null,
            status: { in: ACTIVE },
        },
        orderBy: { createdAt: "asc" },
    });
}

/** What `createOnce` did: opened the job, or found the one already running for its album or song. */
export type CreateOnceOutcome =
    | { created: Awaited<ReturnType<typeof create>> }
    | { running: NonNullable<Awaited<ReturnType<typeof findActive>>> };

/**
 * Opens a job for an album or song unless one is already pending or running for it (the person, kind, id and Discover
 * batch `findActive` asks about), and answers that one instead. Two calls at once make one job: the loser's insert meets
 * the active-job unique index (albums and songs each have one) and it answers the winner. Needs a `targetMbid`.
 */
export async function createOnce(input: CreateInput & { targetMbid: string }): Promise<CreateOnceOutcome> {
    const key = { userId: input.userId, type: input.type, targetMbid: input.targetMbid, discoveryBatchId: input.discoveryBatchId };
    const running = await findActive(key);
    if (running) return { running };
    try {
        return { created: await create(input) };
    } catch (error: any) {
        if (error?.code !== "P2002") throw error;
        const winner = await findActive(key);
        // A conflict on another unique key, or a winner that has ended already: not this module's to answer.
        if (!winner) throw error;
        return { running: winner };
    }
}

/** Whether a dismiss took the job off the list, found it still running, or found no such job of the person's. */
export type DismissResult = "dismissed" | "running" | "missing";

/**
 * Takes a settled job (completed or failed) off the person's list. A job still pending or processing stays: it is
 * someone's download, and dismissing it would hide it while it works. Not a status move: `cleared` is only a
 * flag on the list.
 */
export async function dismiss(userId: string, id: string): Promise<DismissResult> {
    const settled = { where: { id, userId, status: { in: SETTLED } }, data: { cleared: true } };
    if ((await prisma.downloadJob.updateMany(settled)).count > 0) return "dismissed";
    const stays = await prisma.downloadJob.findFirst({ where: { id, userId }, select: { status: true } });
    if (!stays) return "missing";
    if (ACTIVE.includes(stays.status)) return "running";
    // It settled between the two reads.
    await prisma.downloadJob.updateMany(settled);
    return "dismissed";
}

/** Takes every settled job off the person's list and leaves the running ones. Returns how many it took. */
export async function dismissAllSettled(userId: string): Promise<number> {
    const { count } = await prisma.downloadJob.updateMany({
        where: { userId, status: { in: SETTLED }, cleared: false },
        data: { cleared: true },
    });
    return count;
}

/**
 * What a retry made: the job already downloading the album, `alreadyRetried` when another retry cleared the failed job
 * first and nothing is running now (the caller has nothing to start and nothing to report as started), or the replacement.
 */
export type RetryOutcome<T> =
    | { running: NonNullable<Awaited<ReturnType<typeof findActive>>> }
    | { alreadyRetried: true }
    | { replacement: T };

/**
 * Retries a failed download once. In one transaction the failed job leaves the list (the first retry to clear it wins),
 * and then either the replacement is made or nothing is. `sameAlbum` names what the replacement would be (its kind of
 * job and album id), or null when it has no album id to collide on; the failed job's person and Discover batch complete
 * the key, so the lookup is the index's own. A failed job is cleared whenever a job for its album is running, so an answer
 * of "already running" leaves no stale entry behind. A retry that loses the claim and finds nothing running answers
 * `alreadyRetried`: the job was dismissed or already retried, and its replacement has ended. `createReplacement` makes the
 * replacement in the same transaction, and should copy the failed job's `discoveryBatchId`, so the user sees the failed
 * job or its replacement, never neither. When the insert meets the album's one active job (another retry, of another
 * failed job, committed first), the transaction rolls back whole, the running job is read again and answered, and nothing
 * is created a second time.
 */
export async function retryOnce<T>(
    failedJob: { id: string; userId: string; discoveryBatchId: string | null },
    sameAlbum: { type: string; targetMbid: string } | null,
    createReplacement: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<RetryOutcome<T>> {
    const key = sameAlbum && { userId: failedJob.userId, discoveryBatchId: failedJob.discoveryBatchId, ...sameAlbum };
    try {
        return await prisma.$transaction(async (tx): Promise<RetryOutcome<T>> => {
            // The claim comes before anything is created: a second retry waits here for the first to commit, then finds the job cleared.
            const claimed = await tx.downloadJob.updateMany({ where: { id: failedJob.id, cleared: false }, data: { cleared: true } });
            const running = key ? await findActive(key, tx) : null;
            if (running) return { running };
            if (claimed.count === 0) return { alreadyRetried: true };
            return { replacement: await createReplacement(tx) };
        });
    } catch (error: any) {
        // The insert met the one active job an album may have. Its transaction rolled back whole, so the failed job is
        // not yet cleared: clear it only when the job that won is still running.
        if (error?.code !== "P2002" || !key) throw error;
        return prisma.$transaction(async (tx): Promise<RetryOutcome<T>> => {
            const running = await findActive(key, tx);
            if (!running) {
                // Either the winner has ended since, or the conflict was another unique key: the log says which.
                logger.warn(`[Retry] The replacement for job ${failedJob.id} conflicted and no job of the album is running:`, error?.message);
                return { alreadyRetried: true };
            }
            await tx.downloadJob.updateMany({ where: { id: failedJob.id, cleared: false }, data: { cleared: true } });
            return { running };
        });
    }
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

/**
 * The moves that tell and the batch and import checks they started, still running. A move that tells must run
 * inside `moving`, or `whenIdle` cannot see it.
 */
const inFlight = new Set<Promise<void>>();

/**
 * Runs a move that ends or parks jobs and holds it in `inFlight` until it answers, so `whenIdle` also waits for a
 * move that has written its rows but not yet told anyone. The batch and import checks it starts join `inFlight`
 * before it answers, so the set is never empty between the move and its checks.
 */
async function moving<T>(move: () => Promise<T>): Promise<T> {
    const run = move();
    const held = run.then(() => undefined, () => undefined);
    inFlight.add(held);
    void held.finally(() => inFlight.delete(held));
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
        while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
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
    inFlight.add(run);
    void run.finally(() => inFlight.delete(run));
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
