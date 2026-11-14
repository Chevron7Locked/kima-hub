/**
 * Stage records: the one module that changes a `TrackStage` row and the `Track` status columns that mirror it.
 *
 * A stage record is one question asked of one song (`recording`, `analysis`, `embedding`, `fingerprint`) and what is
 * known of its answer. The record is the truth. `analysis` and `embedding` also show on the song as status columns
 * (`analysisStatus`, `vibeAnalysisStatus` and their error, retry count and start time); every move below writes the
 * record and those columns in one transaction, so they cannot disagree. Analyzer reports, the enrichment scheduler, the
 * retry and vibe-start routes, restart, the scanner, album identification, the failure view and the missing-file
 * closure all go through here.
 *
 * Moves:
 * - `claim` / `release`: a worker is handed the question for a lease, or hands it back. A claim that was never
 *   delivered leaves the record exactly as it was (status, attempt, redelivery count, claim time, retry time).
 * - `answer` / `absent`: the question is answered (absent: the sources have nothing, which is an answer).
 * - `settleLandedAnswers`: working records whose analyzer saved its answer after the claim are answered, in one
 *   statement guarded on the claim it read, for the analyzers that never write the record themselves.
 * - `fail` / `failOutcome`: an attempt failed, was parked by a rate limit, or can never be answered.
 * - `closeDependents`: a question that needs a closed question's output is closed with it.
 * - `closeForMissingFiles`: the open questions of songs whose file is gone are closed, so nothing waits on them.
 * - `askAgain`: questions are opened again from the start (set-based, any number of songs; it can join the caller's
 *   transaction, so a reset that also clears answers commits as one).
 * - `decide`: a person parks questions as blocked.
 *
 * A song's file reported gone by an analyzer is flagged missing inside `fail`, and only by a report that names its
 * claim: the song is marked, its questions close in one transaction (the song's own, not the library's), and a
 * library scan is asked for. The flag takes the song's records, then its Track row, the order every move uses; a
 * deadlock Postgres still picks it for is retried once.
 *
 * A report that names its claim (the job id) applies only while that claim is the record's open one; a report for a
 * claim that was re-issued is dropped. An answered, closed or blocked record is never reopened by a report.
 *
 * Not here: which question to offer next, the order of stages, and the one-at-a-time rule for MusiCNN and CLAP
 * (the scheduler's `analysisStillRunning`).
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { Prisma } from "@prisma/client";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { isDeadlock } from "../../utils/dbConflict";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { STAGE_RETRY_CAP, computeStageRetryWaitMs } from "../../workers/stageRetry";
import { classifyFailure } from "../enrichmentErrorCodeClassifier";
import { sourcePauseController } from "../sourcePauseController";
import type { Outcome } from "../../utils/outcome";

// ── Vocabulary ───────────────────────────────────────────────────────────

/**
 * The four questions owed per track: which recording it is, its audio analysis, its CLAP embedding, and its local
 * AcoustID fingerprint. Each stage waits only on what PREREQUISITE_STAGE declares for the same track.
 */
export type StageName = "recording" | "analysis" | "embedding" | "fingerprint";

export const STAGE_ORDER: readonly StageName[] = ["recording", "analysis", "embedding", "fingerprint"] as const;

/** The source each stage asks; its records carry it, and a pause on it holds the stage. */
export const STAGE_SOURCE: Record<StageName, string> = {
    recording: "musicbrainz",
    analysis: "analyzer",
    embedding: "clap",
    fingerprint: "fpcalc",
};

/**
 * "output": the dependent stage reads the prerequisite's answer, so only `done` unblocks it.
 * "settled": the question only needs closing: `done`, a permanent failure, or set aside by a
 * person (`blocked`); a retryable failure or an open question does not count.
 */
type StageWaitKind = "output" | "settled";

export interface StagePrerequisite {
    stage: StageName;
    wait: StageWaitKind;
}

/**
 * What each stage actually reads from another stage for the same track. This
 * is the only place stages wait on each other; nothing polls at runtime.
 */
export const PREREQUISITE_STAGE: Record<StageName, StagePrerequisite | null> = {
    // The AcoustID step reads the stored fingerprint. A fingerprint closed as a
    // permanent failure never produces one, so then the step is skipped and the
    // skip is written into this stage's evidence.
    recording: { stage: "fingerprint", wait: "settled" },
    // Reads only the audio file (the Essentia analyzer decodes it itself).
    analysis: null,
    // CLAP reads the audio file, not the analysis's data. The wait is the one-at-a-time rule
    // (analysisStillRunning) plus this record's lifecycle: a closed analysis closes this record
    // too, and a later answer reopens it.
    embedding: { stage: "analysis", wait: "output" },
    // Reads only the audio file (fpcalc on the local binary).
    fingerprint: null,
};

/** How long a claim holds a record before the attempt is presumed dead. */
export const STAGE_CLAIM_LEASE_MS = 15 * 60 * 1000;

/** Lease re-offers do not consume attempts; this many close the record so a poison file cannot loop forever. */
export const STAGE_REDELIVERY_CAP = 3;

/** Admin notices for sources some question has waited on for 24 h are grouped under this prefix. */
export const WAITING_KEY_PREFIX = "enrichment-waiting:";

/** A scan was asked for while one ran: the scan that ran started before the flag, so another follows it (workers/index.ts). */
export const SCAN_AGAIN_KEY = "scan:again-after-vanished-file";

/**
 * The columns a record takes when its question is asked again from the start: owed now, no failures counted, no
 * claim, no error kept. Private to this module: `askAgain` and the answer's reopening of a dependent use it.
 */
const ASKED_AGAIN_SQL = `status = 'pending', failures = 0, redelivered = 0, retryable = true,
    "nextRetryAt" = NULL, "startedAt" = NULL, "finishedAt" = NULL,
    "lastErrorCode" = NULL, "lastErrorMessage" = NULL, "failureClass" = NULL`;

/** What the analyzers and fpcalc say when a track's file is not on disk. */
const FILE_GONE = /^File not found\b|ENOENT|No such file or directory/i;

// ── Deadlocks ────────────────────────────────────────────────────────────

/**
 * Runs a move's own transaction, and once more when Postgres picked it as a deadlock victim: the other transaction
 * has finished by then and the rolled-back move left nothing behind. Any other failure, and a second deadlock, throw.
 * A move that joins its caller's transaction does not use this: the caller owns the retry.
 */
async function retryOnDeadlock<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (err) {
        if (!isDeadlock(err)) throw err;
        logger.warn(`[Enrichment] ${what} lost a transaction conflict (deadlock); trying once more`);
        return run();
    }
}

// ── Claim ids ────────────────────────────────────────────────────────────

/** The attempt a report answers, read from the per-attempt job id `<key>-<attempt>-r<redelivered>`. */
export function claimOf(jobId: string | undefined): { attempt: number; redelivered: number } | null {
    const match = jobId ? /-(\d+)-r(\d+)$/.exec(jobId) : null;
    return match ? { attempt: Number(match[1]), redelivered: Number(match[2]) } : null;
}

/**
 * Whether an analyzer's report names the claim it answers. A report that names none is logged and ignored by its
 * caller: the analyzers run outside this process and only the claim says whose attempt they answer.
 */
export function reportNamesClaim(trackId: string, stage: StageName, jobId: string | undefined): boolean {
    if (claimOf(jobId)) return true;
    logger.warn(`[Enrichment] ${stage}: ignored a report for ${trackId} that names no claim (${jobId ?? "no job id"})`);
    return false;
}

/**
 * Whether a job's claim is still the record's open one. A job whose claim was re-issued (a lease re-offer, a wipe, a
 * restart) does no work: its answer would be dropped as stale, and the asking costs the sources' rate limits. A job
 * with no claim in its id is always current.
 */
export async function claimIsCurrent(trackId: string, stage: StageName, jobId: string | undefined): Promise<boolean> {
    const claim = claimOf(jobId);
    if (!claim) return true;
    const row = await prisma.trackStage.findUnique({
        where: { trackId_stage: { trackId, stage } },
        select: { status: true, attempt: true, redelivered: true },
    });
    return row?.status === "working" && row.attempt === claim.attempt && row.redelivered === claim.redelivered;
}

// ── The status columns ───────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

/** The Track columns that show a stage's record. `recording` and `fingerprint` have none. */
const COLUMNS: Partial<Record<StageName, { status: string; error: string; retries: string; started: string; touched: string | null }>> = {
    analysis: {
        status: '"analysisStatus"',
        error: '"analysisError"',
        retries: '"analysisRetryCount"',
        started: '"analysisStartedAt"',
        touched: null,
    },
    embedding: {
        status: '"vibeAnalysisStatus"',
        error: '"vibeAnalysisError"',
        retries: '"vibeAnalysisRetryCount"',
        started: '"vibeAnalysisStartedAt"',
        touched: '"vibeAnalysisStatusUpdatedAt"',
    },
};

/**
 * Makes the status columns of these songs say what their `stage` records say: working is `processing`, done is
 * `completed`, a failure still to retry is `failed`, a closed or blocked one is `permanently_failed`, and anything
 * owed is `pending`. Runs inside the move's transaction, on exactly the songs the move changed.
 */
async function mirror(tx: Tx, stage: StageName, trackIds: string[]): Promise<void> {
    const cols = COLUMNS[stage];
    if (!cols || trackIds.length === 0) return;
    await tx.$executeRawUnsafe(
        `UPDATE "Track" t
            SET ${cols.status} = CASE ts.status
                    WHEN 'working' THEN 'processing'
                    WHEN 'done' THEN 'completed'
                    WHEN 'blocked' THEN 'permanently_failed'
                    WHEN 'failed' THEN CASE WHEN ts.retryable THEN 'failed' ELSE 'permanently_failed' END
                    ELSE 'pending' END,
                ${cols.error} = CASE
                    WHEN ts.status IN ('failed', 'blocked') OR (ts.status = 'pending' AND ts."lastErrorCode" IS NOT NULL)
                    THEN left(COALESCE(ts."lastErrorMessage", t.${cols.error}), 500) END,
                ${cols.retries} = ts.failures,
                ${cols.started} = CASE WHEN ts.status = 'working' THEN ts."startedAt" END
                ${cols.touched ? `, ${cols.touched} = now()` : ""}
           FROM "TrackStage" ts
          WHERE ts."trackId" = t.id AND ts.stage = $1 AND t.id = ANY($2::text[])`,
        stage,
        trackIds,
    );
}

/** Mirrors the records a move returned, one stage at a time. */
async function mirrorMoved(tx: Tx, moved: Array<{ trackId: string; stage: string }>): Promise<void> {
    const byStage = new Map<StageName, string[]>();
    for (const row of moved) {
        const ids = byStage.get(row.stage as StageName) ?? [];
        ids.push(row.trackId);
        byStage.set(row.stage as StageName, ids);
    }
    for (const [stage, ids] of byStage) await mirror(tx, stage, ids);
}

/** The shared valence/arousal pair from both analyzers' raw answers: the blend when both have answered, otherwise whichever has. */
async function syncSharedValenceArousal(tx: Tx, trackIds: string[]): Promise<void> {
    await tx.$executeRawUnsafe(
        `UPDATE "Track"
            SET valence = COALESCE(ROUND((0.7 * "deamValence" + 0.3 * "clapValenceRaw")::numeric, 3)::float8,
                                   "deamValence", "clapValenceRaw"),
                arousal = COALESCE(ROUND((0.5 * "deamArousal" + 0.5 * "clapArousalRaw")::numeric, 3)::float8,
                                   "deamArousal", "clapArousalRaw"),
                -- Raw SQL does not move updatedAt by itself; the mood step reads it to see that a reading changed.
                "updatedAt" = now()
          WHERE id = ANY($1::text[])`,
        trackIds,
    );
}

const recordId = (trackId: string, stage: string) => `${trackId}__${stage}`;

/**
 * A record a bulk re-ask may reopen: not running now, not parked by a person, and its file is present. `alias` names
 * the TrackStage row in the SQL it joins.
 */
function reopenable(alias: string): string {
    return `${alias}.status NOT IN ('working', 'blocked')
        AND ${alias}."failureClass" IS DISTINCT FROM 'FILE_MISSING'
        AND NOT EXISTS (SELECT 1 FROM "Track" gone
                         WHERE gone.id = ${alias}."trackId" AND gone."missingSince" IS NOT NULL)`;
}

// ── Claim and release ────────────────────────────────────────────────────

/** What a record held before a claim took it: `release` puts exactly this back. */
export interface PriorRecord {
    status: string;
    attempt: number;
    redelivered: number;
    startedAt: Date | null;
    nextRetryAt: Date | null;
}

export type ClaimResult =
    | {
          kind: "claimed";
          attempt: number;
          redelivered: number;
          jobId: string;
          /** The record as it was before this claim; null when the claim created it. */
          before: PriorRecord | null;
      }
    /** Answered, closed, parked by a person, or held by a live claim: nothing to hand out. */
    | { kind: "not-owed" }
    /** The claim's lease ran out for the last time: the record is closed so a poison file stops looping. */
    | { kind: "closed" };

/**
 * Hands the question to a worker for a lease. A claim whose lease ran out is re-offered as a redelivery (same attempt,
 * `redelivered` + 1); `STAGE_REDELIVERY_CAP` redeliveries close the record. Only a reported failure uses up a retry.
 * An answered or closed record is never claimed. The song's column says `processing`.
 */
export async function claim(
    trackId: string,
    stage: StageName,
    opts: { jobKey: string; source?: string },
): Promise<ClaimResult> {
    return prisma.$transaction(async (tx) => {
        // Read under the row's lock, so what `release` restores is what the claim below replaces.
        const [before] = await tx.$queryRawUnsafe<PriorRecord[]>(
            `SELECT status, attempt, redelivered, "startedAt", "nextRetryAt" FROM "TrackStage"
              WHERE "trackId" = $1 AND stage = $2 FOR UPDATE`,
            trackId,
            stage,
        );
        const claimed = await tx.$queryRawUnsafe<Array<{ attempt: number; redelivered: number }>>(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt, retryable, evidence,
                 "startedAt", "nextRetryAt")
             VALUES ($1, $2, $3, 'working', $4, 1, true, $5::jsonb,
                     now(), now() + make_interval(secs => $6))
             ON CONFLICT ("trackId", stage) DO UPDATE
                SET status = 'working',
                    "startedAt" = now(),
                    "nextRetryAt" = now() + make_interval(secs => $6),
                    "attempt" = CASE WHEN "TrackStage".status = 'working'
                                     THEN "TrackStage"."attempt"
                                     ELSE "TrackStage"."attempt" + 1 END,
                    "redelivered" = CASE WHEN "TrackStage".status = 'working'
                                          THEN "TrackStage"."redelivered" + 1
                                          ELSE 0 END
              WHERE ("TrackStage".status IN ('pending', 'failed')
                     AND "TrackStage".retryable = true)
                 OR ("TrackStage".status = 'working'
                     AND "TrackStage"."nextRetryAt" IS NOT NULL
                     AND "TrackStage"."nextRetryAt" <= now()
                     AND "TrackStage"."redelivered" < ${STAGE_REDELIVERY_CAP})
             RETURNING attempt, "redelivered"`,
            recordId(trackId, stage),
            trackId,
            stage,
            opts.source ?? STAGE_SOURCE[stage],
            JSON.stringify({ question: opts.jobKey }),
            STAGE_CLAIM_LEASE_MS / 1000,
        );
        if (claimed.length > 0) {
            await mirror(tx, stage, [trackId]);
            const { attempt, redelivered } = claimed[0];
            // Each redelivery gets its own job id so a re-offer never reuses the dead attempt's queue key.
            return {
                kind: "claimed" as const,
                attempt,
                redelivered,
                jobId: `${opts.jobKey}-${attempt}-r${redelivered}`,
                before: before ?? null,
            };
        }
        const closed = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `UPDATE "TrackStage"
                SET status = 'failed',
                    retryable = false,
                    "lastErrorCode" = 'LOST_WORKER',
                    "lastErrorMessage" = 'Kept losing its worker (${STAGE_REDELIVERY_CAP} lease expiries, no answer)',
                    "failureClass" = 'INCONCLUSIVE',
                    "nextRetryAt" = NULL,
                    "finishedAt" = now()
              WHERE "trackId" = $1 AND stage = $2
                AND status = 'working'
                AND "redelivered" >= ${STAGE_REDELIVERY_CAP}
              RETURNING id`,
            trackId,
            stage,
        );
        if (closed.length === 0) return { kind: "not-owed" as const };
        await mirror(tx, stage, [trackId]);
        logger.warn(
            `[Enrichment] ${stage}: ${trackId} lost its worker ${STAGE_REDELIVERY_CAP} times; record closed until a human re-decides`,
        );
        return { kind: "closed" as const };
    });
}

/**
 * Hands a claim back because the work never went out: the record goes back exactly as the claim found it, so a
 * retryable failure is still that failure (same attempt, same retry time) and a lease re-offer is still the expired
 * claim it was. A claim that created the record leaves it pending with no attempt used. A claim that was already
 * re-issued is left alone.
 */
export async function release(
    trackId: string,
    stage: StageName,
    held: Pick<Extract<ClaimResult, { kind: "claimed" }>, "attempt" | "redelivered" | "before">,
): Promise<void> {
    const back: PriorRecord = held.before ?? {
        status: "pending",
        attempt: 0,
        redelivered: 0,
        startedAt: null,
        nextRetryAt: null,
    };
    await prisma.$transaction(async (tx) => {
        const released = await tx.$executeRawUnsafe(
            `UPDATE "TrackStage"
                SET status = $5, attempt = $6, redelivered = $7, "startedAt" = $8, "nextRetryAt" = $9
              WHERE "trackId" = $1 AND stage = $2 AND status = 'working'
                AND attempt = $3 AND redelivered = $4`,
            trackId,
            stage,
            held.attempt,
            held.redelivered,
            back.status,
            back.attempt,
            back.redelivered,
            back.startedAt,
            back.nextRetryAt,
        );
        if (released > 0) await mirror(tx, stage, [trackId]);
    });
}

// ── Answers ──────────────────────────────────────────────────────────────

/**
 * Answers a question `done` by `source`, with evidence. With a job id it settles only that claim; without one it
 * creates or settles the record, unless a person parked it or a claim is open on it (only the claim's holder can say
 * its attempt is answered). Idempotent. A dependent closed because this stage had
 * failed for good (`DEPENDENCY_CLOSED`) is asked again, and a sound answer re-blends the song's valence and arousal.
 */
export async function answer(
    trackId: string,
    stage: StageName,
    source: string,
    evidence?: Record<string, unknown>,
    jobId?: string,
): Promise<void> {
    const claimed = claimOf(jobId);
    const settled = await prisma.$transaction(async (tx) => {
        const written = claimed
            ? await tx.$executeRawUnsafe(
                  `UPDATE "TrackStage"
                      SET status = 'done',
                          source = $2,
                          "lastErrorCode" = NULL,
                          "lastErrorMessage" = NULL,
                          "failureClass" = NULL,
                          retryable = true,
                          "nextRetryAt" = NULL,
                          evidence = $3::jsonb,
                          "finishedAt" = now()
                    WHERE "trackId" = $1 AND stage = $6 AND status = 'working' AND attempt = $4 AND redelivered = $5`,
                  trackId,
                  source,
                  JSON.stringify(evidence ?? { reason: "answered" }),
                  claimed.attempt,
                  claimed.redelivered,
                  stage,
              )
            : await tx.$executeRawUnsafe(
                  `INSERT INTO "TrackStage"
                      (id, "trackId", stage, status, source, attempt, retryable,
                       "nextRetryAt", evidence, "startedAt", "finishedAt")
                   VALUES ($1, $2, $3, 'done', $4, 1, true, NULL, $5::jsonb, now(), now())
                   ON CONFLICT ("trackId", stage) DO UPDATE
                      SET status = 'done',
                          source = EXCLUDED.source,
                          "lastErrorCode" = NULL,
                          "lastErrorMessage" = NULL,
                          "failureClass" = NULL,
                          retryable = true,
                          "nextRetryAt" = NULL,
                          evidence = EXCLUDED.evidence,
                          "startedAt" = COALESCE("TrackStage"."startedAt", now()),
                          "finishedAt" = now()
                    WHERE "TrackStage".status NOT IN ('blocked', 'working')`,
                  recordId(trackId, stage),
                  trackId,
                  stage,
                  source,
                  JSON.stringify(evidence ?? { reason: "answered" }),
              );
        if (written === 0) return false;
        await afterAnswered(tx, stage, [trackId]);
        return true;
    });
    if (!settled) {
        logger.debug(`[Enrichment] ${stage}: ignored a success for ${trackId} that answers no open claim (${jobId ?? "no job id"})`);
    }
}

/**
 * What an answer sets in motion, inside the answering transaction: a dependent closed because this stage had failed
 * for good (`DEPENDENCY_CLOSED`) is asked again, the status columns follow, and a sound answer re-blends the songs'
 * valence and arousal. The other records are taken before the Track rows, the order every move uses.
 */
async function afterAnswered(tx: Tx, stage: StageName, trackIds: string[]): Promise<void> {
    const dependents = STAGE_ORDER.filter((s) => PREREQUISITE_STAGE[s]?.stage === stage);
    if (dependents.length > 0) {
        const reopened = await tx.$queryRawUnsafe<Array<{ trackId: string; stage: string }>>(
            `UPDATE "TrackStage"
                SET ${ASKED_AGAIN_SQL}, evidence = jsonb_build_object('reason', 'dependency answered')
              WHERE "trackId" = ANY($1::text[]) AND stage = ANY($2::text[])
                AND status = 'failed' AND "failureClass" = 'DEPENDENCY_CLOSED'
              RETURNING "trackId", stage`,
            trackIds,
            dependents,
        );
        await mirrorMoved(tx, reopened);
    }
    await mirror(tx, stage, trackIds);
    if (stage === "embedding" || stage === "analysis") await syncSharedValenceArousal(tx, trackIds);
}

/**
 * Answers the `working` records whose analyzer saved its answer after the claim. The Python analyzers never write the
 * record, so a missed completion event leaves it `working` until the lease runs out: an analysis counts as answered
 * when the song's `analyzedAt` is not before the claim, an embedding when its sound vector is. An older vector is the
 * previous answer, kept readable for the vibe map, and answers nothing. One statement, guarded on the record still
 * being `working` and on the claim time it read: a record claimed again meanwhile (the settle waits for that claim's
 * lock and then re-reads the row) stays working. `recording` and `fingerprint` report in this process, so they have
 * nothing to settle. Returns how many records it answered.
 */
export async function settleLandedAnswers(stage: StageName): Promise<number> {
    if (stage !== "analysis" && stage !== "embedding") return 0;
    const landed =
        stage === "analysis"
            ? `t."analyzedAt" >= ts."startedAt"`
            : `EXISTS (SELECT 1 FROM track_embeddings te WHERE te.track_id = ts."trackId" AND te.analyzed_at >= ts."startedAt")`;
    const syncedFrom = stage === "analysis" ? "Track.analyzedAt" : "track_embeddings";
    return retryOnDeadlock(`${stage}: settling landed answers`, () => prisma.$transaction(async (tx) => {
        const answered = await tx.$queryRawUnsafe<Array<{ trackId: string }>>(
            `UPDATE "TrackStage" ts
                SET status = 'done',
                    source = $2,
                    "lastErrorCode" = NULL,
                    "lastErrorMessage" = NULL,
                    "failureClass" = NULL,
                    retryable = true,
                    "nextRetryAt" = NULL,
                    evidence = jsonb_build_object('syncedFrom', $3::text, 'answer', 'completed'),
                    "finishedAt" = now()
               FROM "Track" t
              WHERE t.id = ts."trackId"
                AND ts.stage = $1
                AND ts.status = 'working'
                AND ts."startedAt" IS NOT NULL
                AND ${landed}
            RETURNING ts."trackId"`,
            stage,
            STAGE_SOURCE[stage],
            syncedFrom,
        );
        if (answered.length > 0) await afterAnswered(tx, stage, answered.map((r) => r.trackId));
        return answered.length;
    }, BULK_TX));
}

/** Records "the sources have nothing" as a `done` answer with evidence of what was asked, so a correct "no" does not burn the retry ladder. */
export async function absent(
    trackId: string,
    stage: StageName,
    source: string,
    evidence?: Record<string, unknown>,
    jobId?: string,
): Promise<void> {
    await answer(trackId, stage, source, evidence ?? { reason: "sources have nothing" }, jobId);
}


// ── A file that is gone ──────────────────────────────────────────────────

/**
 * An analyzer found no file for this track. It is flagged missing now and its stage records close (the reporting one
 * too), so nothing waits on it, and a library scan is asked for: the scan removes the song (and an album or artist it
 * empties) when it confirms the file is gone, or clears the flag and re-opens its records when the file is there.
 * Scans resolve paths the way the song was added and stand down when much of the library vanishes at once.
 * Gone means "no such file" here, as the scanner counts it; any other error reading it (permissions, I/O) is another
 * kind of failure, and so is an empty or unreadable music folder (a drive that is not mounted). A report that no
 * longer answers the record's open claim, checked again inside the flagging transaction, flags nothing and is dropped.
 * Returns "flagged", "stale" (dropped) or "file-present" (the file is not gone: an ordinary failure).
 */
async function flagVanishedTrack(
    trackId: string,
    stage: StageName,
    held: { attempt: number; redelivered: number },
    jobId: string | undefined,
): Promise<"flagged" | "file-present" | "stale"> {
    const track = await prisma.track.findUnique({ where: { id: trackId }, select: { filePath: true } });
    if (!track?.filePath) return "file-present";
    const root = config.music.musicPath;
    if ((await fs.readdir(root).catch(() => [])).length === 0) return "file-present";
    const file = path.isAbsolute(track.filePath) ? track.filePath : path.join(root, track.filePath);
    const gone = await fs.access(file).then(() => false, (err: NodeJS.ErrnoException) => err.code === "ENOENT");
    if (!gone) return "file-present";

    const flag = async (tx: Tx): Promise<boolean> => {
        // All of the song's records first, in one order, then its Track row: the order `claim` and every other move
        // takes them, so the flag and a claim on any of the song's questions cannot wait on each other. The claim is
        // checked here, under the lock: the reads above took time, and a report whose claim was re-issued or answered
        // meanwhile must not flag the song.
        const records = await tx.$queryRawUnsafe<Array<OpenRecord & { stage: string }>>(
            `SELECT stage, attempt, failures, retryable, status, redelivered, evidence FROM "TrackStage"
              WHERE "trackId" = $1 ORDER BY stage FOR UPDATE`,
            trackId,
        );
        if (reportIsStale(records.find((r) => r.stage === stage), held)) return false;
        await tx.track.updateMany({ where: { id: trackId, missingSince: null }, data: { missingSince: new Date() } });
        // The reporting record is in flight; as pending it is closed with the rest, its Track column mirrored.
        await tx.trackStage.updateMany({ where: { trackId, stage }, data: { status: "pending", nextRetryAt: null } });
        await closeForMissingFiles(tx, [trackId]);
        return true;
    };
    const flagged = await retryOnDeadlock(`${stage}: ${trackId} flag`, () => prisma.$transaction(flag));
    if (!flagged) {
        logger.debug(`[Enrichment] ${stage}: ignored a file-missing report for ${trackId} that answers no open claim (${jobId ?? "no job id"})`);
        return "stale";
    }
    logger.info(`[Enrichment] ${track.filePath}: no file found; flagged missing and a library scan asked for`);
    const { requestScan } = await import("../../workers/scanRequest");
    try {
        // A scan already running started before this flag and cannot confirm it, so the next one is noted for after it.
        if (!(await requestScan({ source: "vanished-file" })).queued) await redisClient.set(SCAN_AGAIN_KEY, "1");
    } catch (err) {
        logger.warn(`[Enrichment] Could not ask for a library scan: ${(err as Error).message}`);
    }
    return "flagged";
}

// ── Failures ─────────────────────────────────────────────────────────────

interface OpenRecord {
    attempt: number;
    failures: number;
    retryable: boolean;
    status: string;
    redelivered: number;
    evidence: Record<string, unknown> | null;
}

/**
 * A report answers nothing when its record is answered or closed, when it names a claim other than the open one, or
 * when it names no claim and one is open: only the claim's holder can say its attempt failed.
 */
function reportIsStale(
    current: Pick<OpenRecord, "status" | "retryable" | "attempt" | "redelivered"> | undefined,
    held: { attempt: number; redelivered: number } | null,
): boolean {
    const settled = current?.status === "done" || current?.status === "blocked"
        || (current?.status === "failed" && !current.retryable);
    const stale = held === null
        ? current?.status === "working"
        : !(current?.status === "working" && current.attempt === held.attempt && current.redelivered === held.redelivered);
    return settled || stale;
}

/**
 * Whether a failure report may settle this record. An answered or closed record is never reopened by a report, and a
 * report for any attempt other than the open claim is stale. Returns the record and the SQL condition holding the
 * same rule at write time, or null to drop the report.
 */
async function failureMaySettle(
    trackId: string,
    stage: StageName,
    jobId: string | undefined,
): Promise<{ current: OpenRecord | undefined; writeGuard: string } | null> {
    const [current] = await prisma.$queryRawUnsafe<OpenRecord[]>(
        `SELECT attempt, failures, retryable, status, redelivered, evidence FROM "TrackStage"
          WHERE "trackId" = $1 AND stage = $2`,
        trackId,
        stage,
    );
    const held = claimOf(jobId);
    if (reportIsStale(current, held)) {
        logger.debug(`[Enrichment] ${stage}: ignored a failure for ${trackId} that answers no open claim (${jobId ?? "no job id"})`);
        return null;
    }
    const writeGuard = `"TrackStage".status NOT IN ('done', 'blocked')
                AND NOT ("TrackStage".status = 'failed' AND "TrackStage".retryable = false)
                ${held ? `AND "TrackStage".status = 'working' AND "TrackStage".attempt = ${held.attempt} AND "TrackStage".redelivered = ${held.redelivered}` : `AND "TrackStage".status <> 'working'`}`;
    return { current, writeGuard };
}

/** Parks a stage on its source's rate limit until `until`: pending, no attempt used, the evidence kept. `writeGuard` keeps a newer answer from being overwritten. */
async function parkOnRateLimit(
    trackId: string,
    stage: StageName,
    source: string,
    until: Date,
    message: string,
    evidence: unknown,
    writeGuard: string,
): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
        const parked = await tx.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt, retryable,
                 "nextRetryAt", "lastErrorCode", "lastErrorMessage", evidence)
             VALUES ($1, $2, $3, 'pending', $4, 0, true, $5, 'RATE_LIMITED', $6, $7::jsonb)
             ON CONFLICT ("trackId", stage) DO UPDATE
                SET status = 'pending',
                    source = EXCLUDED.source,
                    "nextRetryAt" = EXCLUDED."nextRetryAt",
                    "lastErrorCode" = 'RATE_LIMITED',
                    "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                    evidence = EXCLUDED.evidence
              WHERE ${writeGuard}`,
            recordId(trackId, stage),
            trackId,
            stage,
            source,
            until,
            message,
            JSON.stringify(evidence),
        );
        if (parked > 0) await mirror(tx, stage, [trackId]);
        return parked > 0;
    });
}

/**
 * The record's counts as they are now, with the row locked until the move's transaction ends, so two reports for the
 * same record count one after the other. `seen` is what the earlier unlocked read found, for a record not yet written.
 */
async function lockedCounts(
    tx: Tx,
    trackId: string,
    stage: StageName,
    seen: OpenRecord | undefined,
): Promise<{ attempt: number; failures: number; status: string | undefined }> {
    const [row] = await tx.$queryRawUnsafe<Array<{ attempt: number; failures: number; status: string }>>(
        `SELECT attempt, failures, status FROM "TrackStage" WHERE "trackId" = $1 AND stage = $2 FOR UPDATE`,
        trackId,
        stage,
    );
    return row ?? { attempt: seen?.attempt ?? 0, failures: seen?.failures ?? 0, status: seen?.status };
}

/**
 * Records a failed attempt. A rate limit pauses only that source and parks the record `pending` without consuming an
 * attempt. A file the analyzers could not find flags the song missing and asks for a scan. Any other error writes
 * `failed` with its class and a retry time, and closes the record at STAGE_RETRY_CAP or at once on a corruption
 * signature. A closed record is never reopened here.
 */
export async function fail(
    trackId: string,
    stage: StageName,
    source: string,
    err: unknown,
    evidence?: Record<string, unknown>,
    jobId?: string,
): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const open = await failureMaySettle(trackId, stage, jobId);
    if (!open) return;
    // A file an analyzer could not find: the song is flagged missing and a scan asked for, which removes it once it
    // confirms the file is gone (flagVanishedTrack); a file that is there after all is an ordinary failure, and so is
    // a report that names no claim, since only a claim says whose attempt found the file gone.
    const held = claimOf(jobId);
    if (held && stage !== "recording" && FILE_GONE.test(message) && (await flagVanishedTrack(trackId, stage, held, jobId)) !== "file-present") return;
    const { current, writeGuard } = open;

    if (await sourcePauseController.handleRateLimit(source, err, evidence)) {
        // Source-caused, not work-caused: park the question until the pause lifts without consuming an attempt.
        const pause = await sourcePauseController.getPause(source);
        const until = pause?.until ?? new Date(Date.now() + sourcePauseController.windowMs);

        // A question still waiting 24 h after it first parked raises its source's alert once and stays pending.
        // The marker lives in the record's evidence, so restarts do not raise it again.
        const prev = current?.evidence ?? {};
        const waitingSince = typeof prev.waitingSince === "string" ? prev.waitingSince : new Date().toISOString();
        const waitEvidence: Record<string, unknown> = {
            ...prev,
            reason: "rate-limited",
            error: message,
            waitingSince,
            ...evidence,
        };
        const raiseAlert = Date.now() - new Date(waitingSince).getTime() >= 24 * 60 * 60_000 && waitEvidence.waitingAlerted !== true;
        if (raiseAlert) waitEvidence.waitingAlerted = true;

        // The alert goes out only once the park has landed: a park a newer answer dropped never marked it raised.
        const parked = await parkOnRateLimit(trackId, stage, source, until, message, waitEvidence, writeGuard);
        if (parked && raiseAlert) {
            const { notificationService } = await import("../notificationService");
            await notificationService
                .notifyAdmins({
                    type: "system",
                    title: `Enrichment waiting on ${source}`,
                    message: `Some tracks have waited on ${source} for over 24 h. They stay pending until its rate limit lifts.`,
                    groupKey: `${WAITING_KEY_PREFIX}${source}`,
                })
                .catch(() => undefined);
        }
        return;
    }

    const failureClass = classifyFailure(err);
    await prisma.$transaction(async (tx) => {
        // A `working` record's claim already named this attempt; anything else moves to the next one (at least 1).
        // Only reported failures use up retries: terminal classes close the record at once; INCONCLUSIVE stays
        // retryable until the cap.
        const counts = await lockedCounts(tx, trackId, stage, current);
        const attempt = counts.status === "working" ? Math.max(counts.attempt, 1) : counts.attempt + 1;
        const failures = counts.failures + 1;
        const retryable = failureClass === "INCONCLUSIVE" && failures < STAGE_RETRY_CAP;
        const nextRetryAt = retryable ? new Date(Date.now() + computeStageRetryWaitMs(failures)) : null;
        const written = await tx.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt,
                 "lastErrorCode", "lastErrorMessage", "failureClass",
                 retryable, "nextRetryAt", evidence, "startedAt", "finishedAt", failures)
             VALUES ($1, $2, $3, 'failed', $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now(), now(), $12)
             ON CONFLICT ("trackId", stage) DO UPDATE
                SET status = 'failed',
                    source = EXCLUDED.source,
                    attempt = EXCLUDED.attempt,
                    failures = EXCLUDED.failures,
                    "lastErrorCode" = EXCLUDED."lastErrorCode",
                    "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                    "failureClass" = EXCLUDED."failureClass",
                    retryable = EXCLUDED.retryable,
                    "nextRetryAt" = EXCLUDED."nextRetryAt",
                    evidence = EXCLUDED.evidence,
                    "startedAt" = COALESCE("TrackStage"."startedAt", now()),
                    "finishedAt" = now()
              WHERE ${writeGuard}`,
            recordId(trackId, stage),
            trackId,
            stage,
            source,
            attempt,
            failureClass,
            message,
            failureClass,
            retryable,
            nextRetryAt,
            JSON.stringify({ error: message, ...evidence }),
            failures,
        );
        if (written > 0) await mirror(tx, stage, [trackId]);
    });
}

/** The three kinds of Outcome that failed to answer anything, as opposed to `absent`. */
export type FailureOutcome = Extract<Outcome<unknown>, { kind: "rateLimited" | "transient" | "permanent" }>;

/**
 * Records an external call's failure by its Outcome kind: rate limited parks with no attempt consumed, permanent
 * closes with the outcome's code, transient takes the retry ladder. `answered` and `absent` are answers and are the
 * caller's to handle.
 */
export async function failOutcome(
    trackId: string,
    stage: StageName,
    source: string,
    outcome: FailureOutcome,
    evidence?: Record<string, unknown>,
    jobId?: string,
): Promise<void> {
    if (outcome.kind !== "rateLimited" && outcome.kind !== "permanent") {
        await fail(
            trackId,
            stage,
            source,
            Object.assign(new Error(outcome.error.message), { code: outcome.error.code }),
            { kind: "transient", ...evidence },
            jobId,
        );
        return;
    }
    const open = await failureMaySettle(trackId, stage, jobId);
    if (!open) return;
    const { current, writeGuard } = open;
    if (outcome.kind === "rateLimited") {
        await parkOnRateLimit(
            trackId,
            stage,
            source,
            outcome.retryAfter,
            `source '${source}' is paused until ${outcome.retryAfter.toISOString()}`,
            outcome.evidence,
            writeGuard,
        );
        return;
    }
    await prisma.$transaction(async (tx) => {
        const counts = await lockedCounts(tx, trackId, stage, current);
        const written = await tx.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt,
                 "lastErrorCode", "lastErrorMessage", "failureClass",
                 retryable, "nextRetryAt", evidence, "startedAt", "finishedAt", failures)
             VALUES ($1, $2, $3, 'failed', $4, $5, $6, $7, 'PERMANENT',
                     false, NULL, $8::jsonb, now(), now(), $9)
             ON CONFLICT ("trackId", stage) DO UPDATE
                SET status = 'failed',
                    source = EXCLUDED.source,
                    failures = EXCLUDED.failures,
                    "lastErrorCode" = EXCLUDED."lastErrorCode",
                    "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                    "failureClass" = 'PERMANENT',
                    retryable = false,
                    "nextRetryAt" = NULL,
                    evidence = EXCLUDED.evidence,
                    "startedAt" = COALESCE("TrackStage"."startedAt", now()),
                    "finishedAt" = now()
              WHERE ${writeGuard}`,
            recordId(trackId, stage),
            trackId,
            stage,
            source,
            counts.attempt,
            outcome.error.code,
            outcome.error.message,
            JSON.stringify({ reason: outcome.error.message, ...evidence }),
            counts.failures + 1,
        );
        if (written > 0) await mirror(tx, stage, [trackId]);
    });
}

// ── Whole-library moves ──────────────────────────────────────────────────

/** A move over every song can run longer than an interactive transaction's default 5 s. */
const BULK_TX = { timeout: 5 * 60_000, maxWait: 30_000 };

/**
 * Closes the records whose prerequisite's output can never come: an embedding whose analysis closed (failed for good,
 * or parked by a person). Idempotent; runs every cycle, and never touches a `blocked` record or one already closed.
 * Returns how many it closed.
 */
export async function closeDependents(): Promise<number> {
    return retryOnDeadlock("closing dependents", () => prisma.$transaction(async (tx) => {
        let total = 0;
        for (const [dependent, prerequisite] of Object.entries(PREREQUISITE_STAGE)) {
            // Only a stage that needs the other's output is left unanswerable by its closing; one
            // that waits for it to settle (identification after the fingerprint) still has its answer.
            if (!prerequisite || prerequisite.wait !== "output") continue;
            const closed = await tx.$queryRawUnsafe<Array<{ trackId: string }>>(
                `UPDATE "TrackStage" dep
                    SET status = 'failed',
                        source = $2,
                        retryable = false,
                        "nextRetryAt" = NULL,
                        "startedAt" = COALESCE(dep."startedAt", now()),
                        "finishedAt" = COALESCE(dep."finishedAt", now()),
                        "failureClass" = 'DEPENDENCY_CLOSED',
                        "lastErrorCode" = 'DEPENDENCY_CLOSED',
                        "lastErrorMessage" = 'dependency ' || $3 || ' closed; this question can never be answered',
                        evidence = jsonb_build_object(
                            'reason',
                            'dependency ' || $3 || ' closed: '
                                || COALESCE(pre."failureClass", 'unknown'),
                            'closure', 'dependency-closed'
                        )
                   FROM "TrackStage" pre
                  WHERE dep."trackId" = pre."trackId"
                    AND dep.stage = $1
                    AND pre.stage = $3
                    AND ((pre.status = 'failed' AND pre.retryable = false) OR pre.status = 'blocked')
                    AND dep.status = 'pending'
                    AND dep.retryable = true
              RETURNING dep."trackId"`,
                dependent,
                STAGE_SOURCE[dependent as StageName],
                prerequisite.stage,
            );
            if (closed.length > 0) {
                await mirror(tx, dependent as StageName, closed.map((r) => r.trackId));
                total += closed.length;
                logger.debug(
                    `[Enrichment] Closed ${closed.length} '${dependent}' record(s) whose '${prerequisite.stage}' dependency is closed`,
                );
            }
        }
        return total;
    }, BULK_TX));
}

/**
 * Closes every open record of a song flagged missing as FILE_MISSING, so `pending` always means work the sweep can do
 * and the hang watchdog does not fire on files that are gone. Runs over every flagged song, not just new ones; an
 * answered or parked record stays. A scan that finds the file again asks the records again (`askAgain`). Joins the
 * caller's transaction when given one. With `trackIds`, only those songs' records are closed (the flag on one song
 * leaves the rest to the sweep, so it does not lock the library). Returns how many records it closed.
 */
export async function closeForMissingFiles(within?: Tx, trackIds?: string[]): Promise<number> {
    const run = async (tx: Tx): Promise<number> => {
        const closed = await tx.$queryRawUnsafe<Array<{ trackId: string; stage: string }>>(
            `UPDATE "TrackStage" ts
                SET status = 'failed',
                    retryable = false,
                    "nextRetryAt" = NULL,
                    "startedAt" = COALESCE(ts."startedAt", now()),
                    "finishedAt" = COALESCE(ts."finishedAt", now()),
                    "failureClass" = 'FILE_MISSING',
                    "lastErrorCode" = 'FILE_MISSING',
                    "lastErrorMessage" = 'file missing from the library; a scan that finds it again re-opens this record',
                    evidence = jsonb_build_object('reason', 'file missing', 'closure', 'file-missing')
              WHERE (ts.status = 'pending'
                     OR (ts.status = 'failed' AND ts.retryable
                         AND (ts."nextRetryAt" IS NULL OR ts."nextRetryAt" <= now())))
                AND ts."trackId" IN (SELECT id FROM "Track" WHERE "missingSince" IS NOT NULL)
                AND ($1::text[] IS NULL OR ts."trackId" = ANY($1::text[]))
            RETURNING ts."trackId", ts.stage`,
            trackIds ?? null,
        );
        await mirrorMoved(tx, closed);
        return closed.length;
    };
    return within ? run(within) : retryOnDeadlock("closing records of missing files", () => prisma.$transaction(run, BULK_TX));
}

export type RecordStatus = "pending" | "working" | "done" | "failed" | "blocked";

/** Which records to ask again, from which stages, and why. Every filter narrows; none given means every record of the stages. */
export interface AskAgainSpec {
    stages: readonly StageName[];
    /** Only these songs; omitted means the whole library. */
    trackIds?: string[];
    /** Only these records, by record id (a failure view's selection). */
    recordIds?: string[];
    statuses?: readonly RecordStatus[];
    retryable?: boolean;
    failureClass?: string;
    /** Only a record whose evidence holds all of these entries. */
    evidenceEquals?: Record<string, unknown>;
    /** Leave a record a person decided; without it, a decision stays on the record anyway unless `clearDecision`. */
    undecidedOnly?: boolean;
    /** Wipe the person's decision too. */
    clearDecision?: boolean;
    /** Never re-ask the recording of a song that already has one (the AcoustID dedup guard). */
    keepIdentifiedRecordings?: boolean;
    /** Only records a bulk re-ask may touch: not running, not parked by a person, file present. */
    reopenableOnly?: boolean;
    /** Only songs whose file is not flagged missing (unlike `reopenableOnly`, a parked or running record may still match). */
    songFileThere?: boolean;
    /** Only songs whose record for this other stage is answered (an embedding is asked again only after its analysis). */
    afterAnswerOf?: StageName;
    /** Only songs with no stored sound vector. */
    withoutSoundVector?: boolean;
    /** At most this many records. */
    limit?: number;
    /** The new evidence: what and why, or null for none. Omitted, the record keeps the evidence it had. */
    evidence?: Record<string, unknown> | null;
}

/**
 * Opens questions again from the start: owed now, no failures counted, no claim, no error kept, the status columns
 * pending. Set-based: one statement however many songs. Joins the caller's transaction when given one (a reset that
 * also clears answers commits or rolls back as one). Returns how many records it reopened.
 */
export async function askAgain(spec: AskAgainSpec, within?: Tx): Promise<number> {
    const params: unknown[] = [spec.stages];
    const p = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
    };
    const where = ["ts.stage = ANY($1::text[])"];
    if (spec.trackIds) where.push(`ts."trackId" = ANY(${p(spec.trackIds)}::text[])`);
    if (spec.recordIds) where.push(`ts.id = ANY(${p(spec.recordIds)}::text[])`);
    if (spec.statuses) where.push(`ts.status = ANY(${p(spec.statuses)}::text[])`);
    if (spec.retryable !== undefined) where.push(`ts.retryable = ${p(spec.retryable)}`);
    if (spec.failureClass) where.push(`ts."failureClass" = ${p(spec.failureClass)}`);
    if (spec.evidenceEquals) where.push(`ts.evidence @> ${p(JSON.stringify(spec.evidenceEquals))}::jsonb`);
    if (spec.undecidedOnly) where.push(`ts."decidedAt" IS NULL`);
    if (spec.keepIdentifiedRecordings) {
        where.push(`NOT (ts.stage = 'recording' AND EXISTS (
            SELECT 1 FROM "Track" known WHERE known.id = ts."trackId" AND known."recordingMbid" IS NOT NULL))`);
    }
    if (spec.reopenableOnly) where.push(reopenable("ts"));
    if (spec.songFileThere) {
        where.push(`NOT EXISTS (SELECT 1 FROM "Track" gone WHERE gone.id = ts."trackId" AND gone."missingSince" IS NOT NULL)`);
    }
    if (spec.afterAnswerOf) {
        where.push(`EXISTS (SELECT 1 FROM "TrackStage" a WHERE a."trackId" = ts."trackId" AND a.stage = ${p(spec.afterAnswerOf)} AND a.status = 'done')`);
    }
    if (spec.withoutSoundVector) {
        where.push(`NOT EXISTS (SELECT 1 FROM track_embeddings te WHERE te.track_id = ts."trackId")`);
    }
    const evidenceSql = spec.evidence === undefined
        ? ""
        : `, evidence = ${spec.evidence === null ? "NULL" : `${p(JSON.stringify(spec.evidence))}::jsonb`}`;
    const picked = `SELECT ts.id FROM "TrackStage" ts
              WHERE ${where.join("\n                AND ")}${spec.limit !== undefined ? `\n              LIMIT ${Math.max(0, Math.floor(spec.limit))}` : ""}
              FOR UPDATE OF ts`; // locks the picked rows and re-checks them, so a record claimed meanwhile is not reset

    const run = async (tx: Tx): Promise<number> => {
        const reopened = await tx.$queryRawUnsafe<Array<{ trackId: string; stage: string }>>(
            `UPDATE "TrackStage" target
                SET ${ASKED_AGAIN_SQL}${spec.clearDecision ? `, "decidedAt" = NULL, "decidedBy" = NULL` : ""}${evidenceSql}
              WHERE target.id IN (${picked})
          RETURNING target."trackId", target.stage`,
            ...params,
        );
        await mirrorMoved(tx, reopened);
        return reopened.length;
    };
    return within ? run(within) : retryOnDeadlock("asking again", () => prisma.$transaction(run, BULK_TX));
}

/**
 * A person parks these records (by record id) as blocked: closed, never re-asked behind their back until they ask
 * again with the decision cleared. Only open or failed records move; an answered one stays. Returns how many moved.
 */
export async function decide(recordIds: string[], decidedBy: string): Promise<number> {
    if (recordIds.length === 0) return 0;
    return prisma.$transaction(async (tx) => {
        const parked = await tx.$queryRawUnsafe<Array<{ trackId: string; stage: string }>>(
            `UPDATE "TrackStage"
                SET status = 'blocked', retryable = false, "nextRetryAt" = NULL,
                    "decidedAt" = now(), "decidedBy" = $2
              WHERE id = ANY($1::text[]) AND status IN ('failed', 'pending', 'working')
          RETURNING "trackId", stage`,
            recordIds,
            decidedBy,
        );
        await mirrorMoved(tx, parked);
        return parked.length;
    });
}
