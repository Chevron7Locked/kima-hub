/**
 * The enrichment scheduler: artist metadata, per-track identification,
 * audio analysis, CLAP embeddings, fingerprints and podcast refresh, driven
 * from TrackStage records on a self-rescheduling cycle, then the learned moods
 * and the similarity step from the stored sound vectors.
 */

import { logger } from "../utils/logger";
import { withTimeout } from "../utils/timeout";
import { prisma } from "../utils/db";
import { closeStagesForMissingTracks } from "../services/missingFileStages";
import Redis from "ioredis";
import { config } from "../config";
import os from "os";
import type { Worker as BullWorker } from "bullmq";
import {
    artistQueue,
    trackQueue,
    vibeQueue,
    podcastQueue,
    closeEnrichmentQueues,
    QUEUE_NAMES,
} from "./enrichmentQueues";
import { entityGoneError } from "./entityGone";
import { startArtistEnrichmentWorker } from "./artistEnrichmentWorker";
import { startTrackEnrichmentWorker } from "./trackEnrichmentWorker";
import { startPodcastEnrichmentWorker } from "./podcastEnrichmentWorker";
import {
    startAudioCompletionSubscriber,
    stopAudioCompletionSubscriber,
    haltVibeQueuing,
    resumeVibeQueuing,
} from "./audioCompletionSubscriber";
import { enrichmentStateService, type EnrichmentPhase } from "../services/enrichmentState";
import { STAGE_RETRY_CAP, computeStageRetryWaitMs } from "./stageRetry";
import { ASKED_AGAIN_SQL } from "../services/stageReopen";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { featureDetection } from "../services/featureDetection";
import { musicBrainzService, type AlbumCatalogue } from "../services/musicbrainz";
import { topVoted } from "../utils/votes";
import { trackIdentityService } from "../services/trackIdentity";
import {
    identifyTrackByAcoustid,
    persistAcoustidFingerprint,
    prefetchAcoustidReplies,
    readIdentityTags,
} from "../services/acoustidIdentification";
import { albumFactsOf, fillAlbumFromCatalogue, identifyAlbumsBySound, type AlbumFacts } from "../services/albumIdentification";
import { fpcalcService } from "../services/fpcalc";
import { resolveWithinMusicRoot } from "../routes/library/trackPath";
import { buildMatching, matchingProgress } from "../services/matching/state";
import { buildMoods, moodProgress } from "../services/moods/state";
import { writeMoodTags } from "../services/moods/tags";
import { updateMap } from "../services/matching/map";
import {
    classifyFailure,
} from "../services/enrichmentErrorCodeClassifier";
import { isMbid } from "../services/artistIdentity";
import type { Outcome } from "../utils/outcome";

import { sourcePauseController } from "../services/sourcePauseController";
import { distributedLock } from "../utils/distributedLock";
import { embeddingsDeferredForGpu } from "../services/gpuRuntime";
import { getSystemSettings } from "../utils/systemSettings";
import { normalizeIsrc, pickRecording, recordingAgrees, type ExpectedRecording } from "../services/recordingMatch";

/** The three kinds that failed to answer anything, as opposed to `Absent`. */
type FailureOutcome = Extract<
    Outcome<unknown>,
    { kind: "rateLimited" | "transient" | "permanent" }
>;

// ── Per-track stage queue ────────────────────────────────────────────────

/**
 * The four questions owed per track: which recording it is, its audio
 * analysis, its CLAP embedding, and its local AcoustID fingerprint. Each
 * stage waits only on what PREREQUISITE_STAGE declares for the same track.
 */
export type StageName = "recording" | "analysis" | "embedding" | "fingerprint";

export const STAGE_ORDER: readonly StageName[] = [
    "recording",
    "analysis",
    "embedding",
    "fingerprint",
] as const;

/** The source each stage asks; its records carry it, and a pause on it holds the stage. */
const STAGE_SOURCE: Record<StageName, string> = {
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
    // The sound vector reads the track's analysis: only a done analysis unblocks it; a closed one closes this
    // record too, and a later answer reopens it. Across the library the two heavy models run one at a time
    // (analysisStillRunning).
    embedding: { stage: "analysis", wait: "output" },
    // Reads only the audio file (fpcalc on the local binary).
    fingerprint: null,
};

/**
 * Exactly one producer per queue, so the same work cannot be queued twice under
 * different job keys. Fingerprinting runs fpcalc inline and has no queue.
 */
export const STAGE_QUEUES: Record<StageName, string> = {
    recording: QUEUE_NAMES.TRACKS,
    // The analyzer consumes a plain Redis list, not a BullMQ queue.
    analysis: "audio:analysis:queue",
    embedding: QUEUE_NAMES.VIBE,
    fingerprint: "inline",
};

/** One unit of work: a track, the stage it owes, and how to key the attempt. */
export interface StageWork {
    trackId: string;
    stage: StageName;
    status: string;
    attempt: number;
    source: string | null;
    filePath: string | null;
    duration: number;
    title: string;
    /** Stable identity of the question: `track-<id>-<stage>`. */
    jobKey: string;
    /** Identity of THIS offer: `track-<id>-<stage>-<attempt>-r<redelivery>`. */
    jobId: string;
}

/** A record is due when the answer is missing, a retry's backoff elapsed, or
 * a claim's lease ran out (a `working` record whose `nextRetryAt` came round
 * is an attempt that died without answering). */
const DUE_STATUSES = ["pending", "failed"] as const;

/** How long a claim holds a record before the attempt is presumed dead. */
const STAGE_CLAIM_LEASE_MS = 15 * 60 * 1000;

/** Lease re-offers do not consume attempts; this many close the record so a
 * poison file cannot loop forever. */
const STAGE_REDELIVERY_CAP = 3;

/** An admin chose to run both heavy models side by side, accepting the load (Settings, Library Enrichment). */
async function bothAtOnce(): Promise<boolean> {
    return (await getSystemSettings())?.analysisAndVectorsTogether === true;
}

/**
 * MusiCNN and CLAP run one at a time across the library, never side by side, so each has the machine (CPU and
 * GPU) to itself. Sound vectors start once no track's analysis is owed, due a retry or in flight; an analyzer that
 * is paused or not running holds nothing back, and an analysis waiting out a retry delay does not hold the vectors.
 */
export async function analysisStillRunning(now: Date): Promise<boolean> {
    if (await bothAtOnce()) return false;
    if (await sourcePauseController.isPaused(STAGE_SOURCE.analysis, now)) return false;
    if (!(await featureDetection.analyzerRunning())) return false;
    const [row] = await prisma.$queryRaw<Array<{ open: boolean }>>`
        SELECT EXISTS (
            SELECT 1 FROM "Track" t
              LEFT JOIN "TrackStage" ts ON ts."trackId" = t.id AND ts.stage = 'analysis'
             WHERE t."missingSince" IS NULL
               AND t."filePath" IS NOT NULL
               AND (ts.id IS NULL
                    OR ts.status IN ('pending', 'working')
                    OR (ts.status = 'failed' AND ts.retryable = true
                        AND (ts."nextRetryAt" IS NULL OR ts."nextRetryAt" <= ${now})))
        ) AS open
    `;
    return row.open;
}

/**
 * The other half of one at a time: analysis that comes due while sound vectors are being made (songs added
 * mid-run, a retry whose delay ran out) waits for the tracks CLAP holds a live claim on, then goes first again. A
 * CLAP analyzer that is not running holds nothing back.
 */
export async function vectorsInFlight(): Promise<boolean> {
    if (await bothAtOnce()) return false;
    if (!(await featureDetection.clapRunning())) return false;
    const [row] = await prisma.$queryRaw<Array<{ busy: boolean }>>`
        SELECT EXISTS (
            SELECT 1 FROM "TrackStage"
             WHERE stage = 'embedding' AND status = 'working'
               -- A live claim. One whose lease ran out is an attempt that died; it holds nothing, and the
               -- embedding stage re-offers it once analysis is done.
               AND "nextRetryAt" > ${new Date()}
        ) AS busy
    `;
    return row.busy;
}

/**
 * The work owed for each stage: records with no answer or a due retry, whose
 * prerequisite has answered for the same track. Selection reads TrackStage,
 * never Track status columns, so one failed track cannot hold the rest back.
 */
export async function getNextWork(
    limit: number,
    stageFilter?: StageName,
): Promise<StageWork[]> {
    const now = new Date();
    const work: StageWork[] = [];

    for (const stage of STAGE_ORDER) {
        if (work.length >= limit) break;
        // A phase that owns one stage asks only for that stage, so a hot
        // earlier stage cannot starve it of its share of the limit.
        if (stageFilter && stage !== stageFilter) continue;

        // A paused source gets no work; each attempt would only burn its timeout.
        // Fingerprinting's source is the local fpcalc binary, which nothing pauses.
        const source = STAGE_SOURCE[stage];
        if (await sourcePauseController.isPaused(source, now)) {
            logger.debug(
                `[Enrichment] '${stage}' skipped: source '${source}' is paused`,
            );
            continue;
        }

        // A just-enabled GPU runtime gets a head start on the embedding stage
        // only: a "yes" in the release window must reach the pipeline before
        // the library is embedded on CPU. Bounded by a hard timeout inside
        // the check, so a stuck download defers nothing forever.
        if (stage === "embedding" && (await embeddingsDeferredForGpu(now))) {
            logger.debug(
                "[Enrichment] 'embedding' deferred: GPU runtime installing",
            );
            continue;
        }

        if (stage === "embedding" && (await analysisStillRunning(now))) {
            logger.debug("[Enrichment] 'embedding' waits: audio analysis has tracks left");
            continue;
        }
        if (stage === "analysis" && (await vectorsInFlight())) {
            logger.debug("[Enrichment] 'analysis' waits: sound vectors are being made");
            continue;
        }

    const prerequisite = PREREQUISITE_STAGE[stage];
        // A track with no record for this stage has never been asked — that is
        // "answer missing", so it is due. When there is a record, only a
        // pending or retryable-failed one is.
        const rows = await prisma.$queryRawUnsafe<
            Array<{
                trackId: string;
                status: string;
                attempt: number;
                source: string | null;
                filePath: string;
                duration: number;
                title: string;
            }>
        >(
            `SELECT t.id AS "trackId",
                    COALESCE(ts.status, 'pending')      AS status,
                    COALESCE(ts.attempt, 0)             AS attempt,
                    COALESCE(ts.source, $4)             AS source,
                    t."filePath",
                    t.duration,
                    t.title
               FROM "Track" t
               LEFT JOIN "TrackStage" ts
                        ON ts."trackId" = t.id AND ts.stage = $1
                WHERE (ts.id IS NULL
                       OR ((ts.status = ANY($2)
                            OR ts.status = 'working')
                           AND ts.retryable = true
                           AND (ts."nextRetryAt" IS NULL OR ts."nextRetryAt" <= $3)))
                -- A missing file is skipped, not failed: the scan clears the flag when it returns.
                AND t."missingSince" IS NULL
                -- The prerequisite's record, as its edge declares (StageWaitKind).
                  AND ($5::text IS NULL
                     OR EXISTS (SELECT 1 FROM "TrackStage" prev
                                 WHERE prev."trackId" = t.id
                                   AND prev.stage = $5
                                   AND (prev.status = 'done'
                                        OR ($6::text = 'settled'
                                            AND ((prev.status = 'failed' AND prev.retryable = false)
                                                 OR prev.status = 'blocked')))))
                ORDER BY t."fileModified" DESC
                LIMIT $7`,
            stage,
            [...DUE_STATUSES],
            now,
            source,
            prerequisite?.stage ?? null,
            prerequisite?.wait ?? null,
            limit - work.length,
        );

        for (const row of rows) {
            if (!row.filePath) continue;
            const jobKey = `track-${row.trackId}-${stage}`;
            work.push({
                trackId: row.trackId,
                stage,
                status: row.status,
                attempt: row.attempt,
                source: row.source,
                filePath: row.filePath,
                duration: row.duration,
                title: row.title,
                jobKey,
                // Per attempt, so a retry never reuses the key a failed job
                // still holds.
                jobId: `${jobKey}-${row.attempt + 1}`,
            });
        }
    }

    return work;
}

// Configuration
const ARTIST_BATCH_SIZE = 10;
const TRACK_BATCH_SIZE = 20;
const ENRICHMENT_INTERVAL_MS = 5 * 1000; // 5 seconds - rate limiter handles API limits
// Idle backoff. The cycle is cheap only when it finds work; when there is none
// it still pays for the progress queries, which include a full scan of Track.
// A library that is fully enriched -- the steady state -- was paying that every
// 5 seconds forever against the pool that also serves audio streaming.
const ENRICHMENT_IDLE_INTERVAL_MS = 60 * 1000;
// A failed job keeps its jobId, and the phases skip an entity whose jobId is
// still held, so a failure backs off until this grace cleans the job. Completed
// jobs are cleaned immediately so a reset entity can be queued again.
const FAILED_JOB_RETRY_GRACE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * One enrichment cycle at a time across processes, so a second backend cannot
 * double-dispatch stage records. The TTL outlives the longest real cycle, so a
 * crash releases the lock by expiry.
 */
const CYCLE_LOCK_KEY = "enrichment:cycle-lease";
// Renewed while a cycle runs, so a process that dies or restarts frees it within this time.
const CYCLE_LOCK_TTL_MS = 90 * 1000;

let isRunning = false;
let enrichmentInterval: NodeJS.Timeout | null = null;
// Whether the worker has been explicitly stopped. Distinct from "no timer pending": while a
// cycle is executing there is no pending timer either, and the two must not be confused --
// treating a running cycle as a stopped worker is what allowed a second timer chain to be
// armed alongside the one the cycle was about to arm itself.
let enrichmentStopped = false;
let redis: Redis | null = null;
let controlSubscriber: Redis | null = null;
let isPaused = false;
let isStopping = false;
let userStopped = false; // True after explicit stop; prevents auto-restart via timer
let userStoppedWarned = false; // Throttle warning log to once per stop
let immediateEnrichmentRequested = false;
let activeEnrichmentWorkers: BullWorker[] = [];
let lastRunTime = 0;
const MIN_INTERVAL_MS = 10000; // Minimum 10s between cycles

const AUDIO_ANALYSIS_CONTROL_CHANNEL = "audio:analysis:control";

// Timestamp for once-per-hour orphaned failure record cleanup
let lastOrphanedFailuresCleanup: Date | null = null;

// Timestamp for once-per-day resolved failure record cleanup (>30 days old)
let lastResolvedCleanup: Date | null = null;

/**
 * Resume the BullMQ workers, the vibe queuing bridge, the Python analysis gate
 * and the pub/sub resume signal. Leaves the local pause/stop flags alone, so
 * it can run from the cycle and from hang recovery without undoing a user's stop.
 */
async function resumeInfrastructure(): Promise<void> {
    await Promise.all(activeEnrichmentWorkers.map((w) => w.resume())).catch(() => {});
    resumeVibeQueuing();
    // Clear synchronous gate BEFORE pub/sub resume -- Python sees "open" immediately
    await enrichmentStateService.clearGate();
    // Resume the Python audio analyzer in case it was paused by a prior stop
    try {
        await enrichmentStateService.publishToChannel(AUDIO_ANALYSIS_CONTROL_CHANNEL, "resume");
    } catch (err) {
        logger.warn(`[Enrichment] Failed to resume audio analyzer: ${(err as Error).message}`);
    }
}

/** The stages answered in this process, each timed to its work (a few HTTP calls, one fpcalc run). The
 * analyzers time their own; a claim no answer reaches is re-offered when its lease runs out. */
type TimedStage = "recording" | "fingerprint";

export const STAGE_TIMEOUT_MS: Record<TimedStage, number> = {
    recording: 30_000,
    fingerprint: 30_000,
};

function getStageTimeoutMs(stage: TimedStage): number {
    return STAGE_TIMEOUT_MS[stage];
}

/**
 * The most answers a stage may have in flight. Recording is held under
 * MusicBrainz's ~1 request/s; all three are held lower when they drain slowly
 * (`inFlightCap`); fingerprinting is uncapped.
 */
export const STAGE_IN_FLIGHT_CAP: Partial<Record<StageName, number>> = {
    recording: 30,
    analysis: 200,
    embedding: 64,
};

/** The span over which a stage's drain rate is measured. */
const DRAIN_WINDOW_MS = 2 * 60 * 1000;

/**
 * How many answers a stage may have in flight now: its measured drain rate times
 * half the claim lease, so no queued job outlives its claim and runs twice on a
 * slow machine. Never fewer than two per worker, so each worker has its next track
 * queued, and never more than the ceiling.
 */
export async function inFlightCap(stage: StageName): Promise<number | undefined> {
    return stage === "fingerprint" ? undefined : drainCap(stage);
}

async function drainCap(stage: "recording" | "analysis" | "embedding"): Promise<number> {
    const ceiling = STAGE_IN_FLIGHT_CAP[stage] ?? 1;
    const settings = await getSystemSettings();
    const workers =
        (stage === "analysis"
            ? settings?.audioAnalyzerWorkers
            : stage === "embedding"
              ? settings?.clapWorkers
              : settings?.enrichmentConcurrency) ?? 2;
    const [row] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM "TrackStage"
          WHERE stage = $1 AND status IN ('done', 'failed')
            AND "finishedAt" > now() - make_interval(secs => $2)`,
        stage,
        DRAIN_WINDOW_MS / 1000,
    );
    const drainable = Math.floor(((row?.n ?? 0) / DRAIN_WINDOW_MS) * (STAGE_CLAIM_LEASE_MS / 2));
    return Math.min(ceiling, Math.max(2 * workers, drainable));
}

export { STAGE_RETRY_CAP, computeStageRetryWaitMs } from "./stageRetry";

/** Answer a track's stage `done` by `source`, with evidence; idempotent. */
export async function recordStageSuccess(
    trackId: string,
    stage: StageName,
    source: string,
    evidence?: Record<string, unknown>,
    jobId?: string,
): Promise<void> {
    const claim = claimOf(jobId);
    const settled = claim
        ? await prisma.$executeRawUnsafe(
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
              claim.attempt,
              claim.redelivered,
              stage,
          )
        : await prisma.$executeRawUnsafe(
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
                WHERE "TrackStage".status <> 'blocked'`,
              `${trackId}__${stage}`,
              trackId,
              stage,
              source,
              JSON.stringify(evidence ?? { reason: "answered" }),
          );
    if (settled === 0) {
        logger.debug(`[Enrichment] ${stage}: ignored a success for ${trackId} that answers no open claim (${jobId ?? "no job id"})`);
        return;
    }
    // A dependent closed because this stage had failed for good can be answered now.
    const dependents = STAGE_ORDER.filter((s) => PREREQUISITE_STAGE[s]?.stage === stage);
    if (dependents.length > 0) {
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage"
                SET ${ASKED_AGAIN_SQL}, evidence = jsonb_build_object('reason', 'dependency answered')
              WHERE "trackId" = $1 AND stage = ANY($2::text[])
                AND status = 'failed' AND "failureClass" = 'DEPENDENCY_CLOSED'`,
            trackId,
            dependents,
        );
    }
    // The backend is the only writer of the status columns and of the shared
    // valence/arousal pair; the stage record is the truth and these mirror it.
    if (stage === "embedding") {
        await prisma.$executeRawUnsafe(
            `UPDATE "Track"
                SET "vibeAnalysisStatus" = 'completed',
                    "vibeAnalysisError" = NULL,
                    "vibeAnalysisStatusUpdatedAt" = now()
              WHERE id = $1`,
            trackId,
        );
        await syncSharedValenceArousal(trackId);
    } else if (stage === "analysis") {
        await prisma.$executeRawUnsafe(
            `UPDATE "Track"
                SET "analysisStatus" = 'completed',
                    "analysisError" = NULL,
                    "analysisStartedAt" = NULL
              WHERE id = $1`,
            trackId,
        );
        await syncSharedValenceArousal(trackId);
    }
}

/** The attempt a report answers, read from the per-attempt job id `<key>-<attempt>-r<redelivered>`. */
export function claimOf(jobId: string | undefined): { attempt: number; redelivered: number } | null {
    const match = jobId ? /-(\d+)-r(\d+)$/.exec(jobId) : null;
    return match ? { attempt: Number(match[1]), redelivered: Number(match[2]) } : null;
}

/** Whether a job's claim is still the record's open one. A job whose claim was re-issued (a lease re-offer,
 * a wipe, a restart) does no work: its answer would be dropped as stale, and the asking costs the sources'
 * rate limits. A job with no claim in its id is always current. */
export async function claimIsCurrent(trackId: string, stage: StageName, jobId: string | undefined): Promise<boolean> {
    const claim = claimOf(jobId);
    if (!claim) return true;
    const row = await prisma.trackStage.findUnique({
        where: { trackId_stage: { trackId, stage } },
        select: { status: true, attempt: true, redelivered: true },
    });
    return row?.status === "working" && row.attempt === claim.attempt && row.redelivered === claim.redelivered;
}

/** The shared valence/arousal pair from both analyzers' raw answers: the blend when both
 * have answered, otherwise whichever has. */
async function syncSharedValenceArousal(trackId: string): Promise<void> {
    await prisma.$executeRawUnsafe(
        `UPDATE "Track"
            SET valence = COALESCE(ROUND((0.7 * "deamValence" + 0.3 * "clapValenceRaw")::numeric, 3)::float8,
                                   "deamValence", "clapValenceRaw"),
                arousal = COALESCE(ROUND((0.5 * "deamArousal" + 0.5 * "clapArousalRaw")::numeric, 3)::float8,
                                   "deamArousal", "clapArousalRaw")
          WHERE id = $1`,
        trackId,
    );
}

/**
 * Whether a failure report may settle this record. An answered or closed record is
 * never reopened by a report, and a report for any attempt other than the open claim
 * is stale. Returns the record and the SQL condition holding the same rule at write
 * time, or null to drop the report.
 */
async function failureMaySettle(
    trackId: string,
    stage: StageName,
    jobId: string | undefined,
): Promise<{
    current: { attempt: number; failures: number; retryable: boolean; status: string; redelivered: number; evidence: Record<string, unknown> | null } | undefined;
    writeGuard: string;
} | null> {
    const [current] = await prisma.$queryRawUnsafe<
        Array<{ attempt: number; failures: number; retryable: boolean; status: string; redelivered: number; evidence: Record<string, unknown> | null }>
    >(
        `SELECT attempt, failures, retryable, status, redelivered, evidence FROM "TrackStage"
          WHERE "trackId" = $1 AND stage = $2`,
        trackId,
        stage,
    );
    const claim = claimOf(jobId);
    const settled = current?.status === "done" || current?.status === "blocked"
        || (current?.status === "failed" && !current.retryable);
    const stale = claim !== null && !(current?.status === "working"
        && current.attempt === claim.attempt && current.redelivered === claim.redelivered);
    if (settled || stale) {
        logger.debug(`[Enrichment] ${stage}: ignored a failure for ${trackId} that answers no open claim (${jobId ?? "no job id"})`);
        return null;
    }
    const writeGuard = `"TrackStage".status NOT IN ('done', 'blocked')
                AND NOT ("TrackStage".status = 'failed' AND "TrackStage".retryable = false)
                ${claim ? `AND "TrackStage".status = 'working' AND "TrackStage".attempt = ${claim.attempt} AND "TrackStage".redelivered = ${claim.redelivered}` : ""}`;
    return { current, writeGuard };
}

/**
 * Record a failed attempt. A rate limit pauses only that source and parks the
 * record `pending` without consuming an attempt. Any other error writes `failed`
 * with its class and a retry time, and closes the record at STAGE_RETRY_CAP.
 * A closed record is never reopened here.
 */
export async function recordStageFailure(
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
    const { current, writeGuard } = open;

    if (await sourcePauseController.handleRateLimit(source, err, evidence)) {
        // Source-caused, not work-caused: park the question until the
        // pause lifts without consuming an attempt.
        const pause = await sourcePauseController.getPause(source);
        const until = pause?.until ?? new Date(Date.now() + sourcePauseController.windowMs);

        // A question still waiting 24 h after it first parked raises its source's
        // alert once and stays pending. The marker lives in the record's evidence,
        // so restarts do not raise it again.
        const prev = current?.evidence ?? {};
        const waitingSince =
            typeof prev.waitingSince === "string"
                ? prev.waitingSince
                : new Date().toISOString();
        const waitEvidence: Record<string, unknown> = {
            ...prev,
            reason: "rate-limited",
            error: message,
            waitingSince,
            ...evidence,
        };
        if (
            Date.now() - new Date(waitingSince).getTime() >= 24 * 60 * 60_000 &&
            waitEvidence.waitingAlerted !== true
        ) {
            waitEvidence.waitingAlerted = true;
            const { notificationService } = await import("../services/notificationService");
            await notificationService
                .notifyAdmins({
                    type: "system",
                    title: `Enrichment waiting on ${source}`,
                    message: `Some tracks have waited on ${source} for over 24 h. They stay pending until its rate limit lifts.`,
                    groupKey: `${WAITING_KEY_PREFIX}${source}`,
                })
                .catch(() => undefined);
        }

        const parked = await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt, retryable,
                 "nextRetryAt", "lastErrorCode", "lastErrorMessage", evidence)
             VALUES ($1, $2, $3, 'pending', $4, 0, true, $5, 'RATE_LIMITED', $6, $7::jsonb)
             ON CONFLICT ("trackId", stage) DO UPDATE
                SET status = 'pending',
                    "nextRetryAt" = EXCLUDED."nextRetryAt",
                    "lastErrorCode" = 'RATE_LIMITED',
                    "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                    evidence = EXCLUDED.evidence
              WHERE ${writeGuard}`,
            `${trackId}__${stage}`,
            trackId,
            stage,
            source,
            until,
            message,
            JSON.stringify(waitEvidence),
        );
        if (parked > 0 && stage === "embedding") {
            // Parked on a rate limit, not failed: the mirror says pending.
            await prisma.$executeRawUnsafe(
                `UPDATE "Track"
                    SET "vibeAnalysisStatus" = 'pending',
                        "vibeAnalysisError" = $2,
                        "vibeAnalysisStatusUpdatedAt" = now()
                  WHERE id = $1`,
                trackId,
                message,
            );
        }
        return;
    }

    const failureClass = classifyFailure(err);
    // A `working` record's claim already named this attempt; anything else moves
    // to the next one (at least 1). Only reported failures use up retries: terminal
    // classes close the record at once; INCONCLUSIVE stays retryable until the cap.
    const attempt =
        current?.status === "working"
            ? Math.max(current.attempt, 1)
            : (current?.attempt ?? 0) + 1;
    const failures = (current?.failures ?? 0) + 1;
    const retryable = failureClass === "INCONCLUSIVE" && failures < STAGE_RETRY_CAP;
    const nextRetryAt = retryable
        ? new Date(Date.now() + computeStageRetryWaitMs(failures))
        : null;

    const written = await prisma.$executeRawUnsafe(
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
        `${trackId}__${stage}`,
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
    if (written === 0) return;
    if (stage === "embedding") {
        await prisma.$executeRawUnsafe(
            `UPDATE "Track"
                SET "vibeAnalysisStatus" = $2,
                    "vibeAnalysisError" = $3,
                    "vibeAnalysisRetryCount" = $4,
                    "vibeAnalysisStatusUpdatedAt" = now()
              WHERE id = $1`,
            trackId,
            retryable ? "failed" : "permanently_failed",
            message.slice(0, 500),
            failures,
        );
    } else if (stage === "analysis") {
        await prisma.$executeRawUnsafe(
            `UPDATE "Track"
                SET "analysisStatus" = $2,
                    "analysisError" = $3,
                    "analysisRetryCount" = $4,
                    "analysisStartedAt" = NULL
              WHERE id = $1`,
            trackId,
            retryable ? "failed" : "permanently_failed",
            message.slice(0, 500),
            failures,
        );
    }
}

/** Record "the sources have nothing" as a `done` answer with evidence of what
 * was asked, so a correct "no" does not burn the retry ladder. */
export async function recordStageAbsent(
    trackId: string,
    stage: StageName,
    source: string,
    evidence?: Record<string, unknown>,
    jobId?: string,
): Promise<void> {
    await recordStageSuccess(trackId, stage, source, evidence ?? { reason: "sources have nothing" }, jobId);
}

/**
 * Close embedding records whose analysis record closed, since the embedding
 * can never be built. Idempotent; runs each cycle and never touches `blocked`
 * records or ones already closed.
 */
export async function closeOrphanedDependents(): Promise<void> {
    for (const [dependent, prerequisite] of Object.entries(PREREQUISITE_STAGE)) {
        // Only a stage that needs the other's output is left unanswerable by its closing; one
        // that waits for it to settle (identification after the fingerprint) still has its answer.
        if (!prerequisite || prerequisite.wait !== "output") continue;
        const source = STAGE_SOURCE[dependent as StageName];
        const closed = await prisma.$executeRawUnsafe(
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
                AND dep.retryable = true`,
            dependent,
            source,
            prerequisite.stage,
        );
        if (closed > 0) {
            logger.debug(
                `[Enrichment] Closed ${closed} '${dependent}' record(s) whose '${prerequisite.stage}' dependency is closed`,
            );
        }
    }
}

/**
 * Record an external call's failure by its Outcome kind: rate limited parks with
 * no attempt consumed, permanent closes with `code`, transient takes the retry
 * ladder. `answered`/`absent` are answers and are the caller's to handle.
 */
async function recordOutcomeFailure(
    trackId: string,
    stage: StageName,
    source: string,
    outcome: FailureOutcome,
    evidence?: Record<string, unknown>,
    jobId?: string,
): Promise<void> {
    if (outcome.kind !== "rateLimited" && outcome.kind !== "permanent") {
        await recordStageFailure(
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
        await prisma.$executeRawUnsafe(
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
            `${trackId}__${stage}`,
            trackId,
            stage,
            source,
            outcome.retryAfter,
            `source '${source}' is paused until ${outcome.retryAfter.toISOString()}`,
            JSON.stringify(outcome.evidence),
        );
        return;
    }
    await prisma.$executeRawUnsafe(
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
        `${trackId}__${stage}`,
        trackId,
        stage,
        source,
        current?.attempt ?? 0,
        outcome.error.code,
        outcome.error.message,
        JSON.stringify({ reason: outcome.error.message, ...evidence }),
        (current?.failures ?? 0) + 1,
    );
}

/** An ask that timed out or threw: a transient failure, so the record retries on its ladder. */
function unansweredAsk(err: unknown, label: string): Outcome<never> {
    const message = err instanceof Error ? err.message : String(err);
    return {
        kind: "transient",
        error: {
            code: message === label ? "TIMEOUT" : "REQUEST_FAILED",
            message,
        },
    };
}

/** Ask a source within the stage budget. A blown budget or a throw comes back
 * as `transient` with the real cause, never as "nothing found". */
async function askWithinBudget<T>(
    ask: () => Promise<Outcome<T>>,
    timeoutMs: number,
    label: string,
): Promise<Outcome<T>> {
    try {
        return await withTimeout(ask(), timeoutMs, label);
    } catch (err: any) {
        return unansweredAsk(err, label);
    }
}

/**
 * Initialize Redis connection for audio analysis queue
 */
function getRedis(): Redis {
    if (!redis) {
        redis = new Redis(config.redisUrl);
    }
    return redis;
}

/**
 * Setup subscription to enrichment control channel
 */
async function setupControlChannel() {
    if (!controlSubscriber) {
        controlSubscriber = new Redis(config.redisUrl);
        await controlSubscriber.subscribe("enrichment:control");

        controlSubscriber.on("message", (channel, message) => {
            if (channel === "enrichment:control") {
                logger.debug(
                    `[Enrichment] Received control message: ${message}`,
                );

                if (message === "pause") {
                    isPaused = true;
                    logger.debug("[Enrichment] Paused");
                    Promise.all(activeEnrichmentWorkers.map((w) => w.pause())).catch(() => {});
                    haltVibeQueuing();
                } else if (message === "resume") {
                    isPaused = false;
                    logger.debug("[Enrichment] Resumed");
                    Promise.all(activeEnrichmentWorkers.map((w) => w.resume())).catch(() => {});
                    resumeVibeQueuing();
                } else if (message === "stop") {
                    isStopping = true;
                    isPaused = true;
                    logger.debug(
                        "[Enrichment] Stopping gracefully - completing current item...",
                    );
                    // Pause all BullMQ workers + halt vibe queuing
                    Promise.all(activeEnrichmentWorkers.map((w) => w.pause())).catch(() => {});
                    haltVibeQueuing();
                    // The CLAP analyzer keeps running; with no work it frees its model after
                    // MODEL_IDLE_TIMEOUT (300 s) and loads it again when work arrives.
                }
            }
        });

        logger.debug("[Enrichment] Subscribed to control channel");
    }
}

/**
 * Start the unified enrichment worker (incremental mode)
 */
export async function startUnifiedEnrichmentWorker() {
    // Clear the stop latch, or a restart within the same process arms one cycle and then
    // never reschedules.
    enrichmentStopped = false;
    logger.debug(
        `[Enrichment] Starting worker: artist batch ${ARTIST_BATCH_SIZE}, track batch ${TRACK_BATCH_SIZE}, interval ${ENRICHMENT_INTERVAL_MS / 1000}s`
    );

     // No startup sweep is needed: a job that died mid-flight is a `working` record
     // whose lease comes due on its own.

     // A stored `paused` is an operator instruction and survives a restart. Any
     // other leftover state (`running`, `stopping`) is crash residue and starts fresh.
     const existingState = await enrichmentStateService.getState();
     const honoringPause = existingState?.status === "paused";

     if (honoringPause) {
         isPaused = true;
         userStopped = false;
         isStopping = false;
         logger.warn(
             "[Enrichment] Honouring the persisted pause — " +
                 "use Resume on the Enrichment page to lift it",
         );
     } else {
         isPaused = false;
         isStopping = false;
         userStopped = false;
         if (existingState && existingState.status !== "idle") {
             await enrichmentStateService.clear();
         }
         // Initialize state
         await enrichmentStateService.initializeState();
     }

    // Start BullMQ Workers (artist, track, podcast)
    activeEnrichmentWorkers = await Promise.all([
        startArtistEnrichmentWorker(),
        startTrackEnrichmentWorker(),
        startPodcastEnrichmentWorker(),
    ]);

    if (honoringPause) {
        // Keep workers halted and the analysis gate armed `paused` even if the key was
        // lost, or queued work would drain through the operator's pause.
        haltVibeQueuing();
        await enrichmentStateService.holdGateClosed();
        await Promise.all(activeEnrichmentWorkers.map((w) => w.pause())).catch(
            () => {},
        );
    } else {
        // A previous process's stop() leaves the analysis gate `paused` in Redis, and
        // the analyzer would stay gated while this worker reports running. Resume the
        // real infrastructure before claiming `running`.
        await resumeInfrastructure();
    }

    // Start audio completion subscriber (Essentia → vibe queue bridge)
    startAudioCompletionSubscriber();

    // Setup control channel subscription
    await setupControlChannel();

    // Run immediately
    await runEnrichmentCycle(false);

    // Self-rescheduling: schedule next cycle after current one completes
    scheduleNextEnrichmentCycle();
}

/** Schedule the next cycle. Self-rescheduling, so an overrunning cycle cannot
 * pile up pending ticks. */
function scheduleNextEnrichmentCycle(delayMs: number = ENRICHMENT_INTERVAL_MS) {
    enrichmentInterval = setTimeout(async () => {
        // The timer has fired; clear the spent handle so bumpScheduleToFastInterval does
        // not mistake it for a pending one and start a second chain.
        enrichmentInterval = null;
        let didWork = false;
        // How long to wait before the next cycle. Set here and used by the single
        // scheduling call in the finally block, because scheduling from more than one
        // place spawns parallel timer chains -- see the note there.
        let nextDelayMs: number | null = null;
        try {
            const result = await runEnrichmentCycle(false);

            // A cycle that declined to run has learned nothing about whether
            // there is work, so backing off for a minute on the strength of it
            // is wrong. Come back as soon as the floor allows.
            if (result.declined) {
                const waitedFor = Date.now() - lastRunTime;
                const untilAllowed = Math.max(0, MIN_INTERVAL_MS - waitedFor);
                nextDelayMs = Math.max(untilAllowed, ENRICHMENT_INTERVAL_MS);
                return;
            }

            // Every phase that queued something counts as work.
            didWork =
                result.artists > 0 ||
                result.tracks > 0 ||
                result.audioQueued > 0 ||
                (result.vibeQueued ?? 0) > 0 ||
                (result.fingerprintsQueued ?? 0) > 0;
        } catch (error) {
            // Treat a failure as "work pending" so the retry is prompt rather
            // than backed off for a minute.
            didWork = true;
            logger.error(
                "[Enrichment] Cycle failed; continuing with the next cycle:",
                error instanceof Error ? error.message : String(error)
            );
        } finally {
            // The only scheduling call, in a finally so an early return or a rejected cycle
            // still re-arms the chain; scheduling from two places would start a second
            // chain. `enrichmentStopped` is how stopUnifiedEnrichmentWorker ends it.
            if (!enrichmentStopped) {
                scheduleNextEnrichmentCycle(
                    nextDelayMs ??
                        (didWork
                            ? ENRICHMENT_INTERVAL_MS
                            : ENRICHMENT_IDLE_INTERVAL_MS)
                );
            }
        }
    }, delayMs);
}

/**
 * Pull the pending timer forward to the fast interval, so the cycle after a
 * user-triggered run is not stuck on the idle delay.
 */
function bumpScheduleToFastInterval(): void {
    // No pending timer means stopped, or a cycle is running and its finally will
    // arm the next one; arming another here would leak a second chain. Scan
    // completions call this without awaiting, so that overlap is common.
    if (enrichmentInterval === null) return;
    clearTimeout(enrichmentInterval);
    enrichmentInterval = null;
    scheduleNextEnrichmentCycle(ENRICHMENT_INTERVAL_MS);
}

/**
 * Stop the enrichment worker
 */
export async function stopUnifiedEnrichmentWorker() {
    enrichmentStopped = true;
    if (enrichmentInterval) {
        clearTimeout(enrichmentInterval);
        enrichmentInterval = null;
    }
    logger.debug("[Enrichment] Worker stopped");
    if (redis) {
        redis.disconnect();
        redis = null;
    }
    if (controlSubscriber) {
        controlSubscriber.disconnect();
        controlSubscriber = null;
    }

    // Close BullMQ Workers, audio subscriber, and Queues
    await Promise.all(activeEnrichmentWorkers.map((w) => w.close())).catch(() => {});
    activeEnrichmentWorkers = [];
    await stopAudioCompletionSubscriber().catch(() => {});
    await closeEnrichmentQueues().catch(() => {});

    // Mark as stopped in state
    await enrichmentStateService
        .updateState({
            status: "idle",
            currentPhase: null,
        })
        .catch((err) =>
            logger.error("[Enrichment] Failed to update state:", err),
        );
}

/** Drop every cached mix so the next read rebuilds it; returns how many were dropped. */
async function dropCachedMixes(): Promise<number> {
    const redis = getRedis();
    const keys: string[] = [];
    let cursor = "0";
    do {
        const [next, batch] = await redis.scan(cursor, "MATCH", "mixes:*", "COUNT", 100);
        cursor = next;
        keys.push(...batch);
    } while (cursor !== "0");
    if (keys.length > 0) await redis.del(...keys);
    return keys.length;
}

/** Drop every cached mix so the next read rebuilds it from what enrichment has now answered, and record
 * that this point's clear is done. */
async function clearMixCache(
    point: "core" | "full",
    done: { coreCacheCleared: true } | { fullCacheCleared: true },
): Promise<void> {
    try {
        const dropped = await dropCachedMixes();
        if (dropped > 0) {
            logger.info(`[Enrichment] Cleared ${dropped} mix cache entries after ${point} enrichment complete`);
        }
        await enrichmentStateService.updateState(done);
    } catch (error) {
        logger.error(`[Enrichment] Failed to clear mix cache on ${point} complete:`, error);
    }
}

/** Where a claimed attempt is handed to its queue, shared by the phases and
 * "Retry failed and blocked" so each queue keeps one producer. */
const STAGE_PRODUCERS: Record<StageName, (item: StageWork) => Promise<void>> = {
    recording: async (item) => {
        await trackQueue.add(
            "enrich",
            { trackId: item.trackId, trackTitle: item.title },
            // Per-attempt jobId: a retry never reuses the key a failed job
            // still holds.
            { jobId: item.jobId },
        );
    },
    analysis: async (item) => {
        // The analyzer consumes a plain Redis list, not a BullMQ queue. The job id names
        // the claim, and the analyzer's report carries it back.
        await getRedis().rpush(
            STAGE_QUEUES.analysis,
            JSON.stringify({
                trackId: item.trackId,
                filePath: item.filePath,
                duration: item.duration,
                jobId: item.jobId,
            }),
        );
        await prisma.$executeRawUnsafe(
            `UPDATE "Track"
                SET "analysisStatus" = 'processing',
                    "analysisStartedAt" = now()
              WHERE id = $1`,
            item.trackId,
        );
    },
    embedding: async (item) => {
        await vibeQueue.add(
            "embed",
            { trackId: item.trackId, filePath: item.filePath, duration: item.duration },
            { jobId: item.jobId },
        );
        await prisma.$executeRawUnsafe(
            `UPDATE "Track"
                SET "vibeAnalysisStatus" = 'processing',
                    "vibeAnalysisStartedAt" = now(),
                    "vibeAnalysisStatusUpdatedAt" = now()
              WHERE id = $1`,
            item.trackId,
        );
    },
    fingerprint: async (item) => {
        // The fingerprint pool runs fpcalc at machine concurrency and returns at once,
        // so no stage or cycle waits on the sweep. dispatchStageWork owns the claim;
        // runFingerprintStageWork owns the answer.
        runFingerprintInPool(item);
    },
};

/**
 * Answer one fingerprint question with local fpcalc and store the fingerprint
 * whatever identification later finds, since dedupe uses it too. A stored
 * fingerprint is reused, never recomputed. Failures go through recordStageFailure.
 */
async function runFingerprintStageWork(item: StageWork): Promise<void> {
    try {
        const track = await prisma.track.findUnique({
            where: { id: item.trackId },
            select: { acoustidFingerprint: true },
        });
        if (!track) {
            throw new Error(`ENTITY_NOT_FOUND: Track ${item.trackId} deleted`);
        }

        if (track.acoustidFingerprint) {
            await recordStageSuccess(item.trackId, "fingerprint", "fpcalc", {
                reason: "fingerprint already stored",
                characters: track.acoustidFingerprint.length,
            }, item.jobId);
            await reopenRecordingThatNeverAskedAcoustid(item.trackId);
            return;
        }

        if (!item.filePath) {
            throw new Error(
                `Track ${item.trackId} has no file path to fingerprint`,
            );
        }
        const absolutePath = resolveWithinMusicRoot(item.filePath);
        if (!absolutePath) {
            throw new Error(
                `Track ${item.trackId} path escapes the music folder: ${item.filePath}`,
            );
        }

        // Throws FpcalcFailure on a real failure — the error carries fpcalc's
        // exit code and stderr, so classifyFailure below sees the true reason.
        const fingerprint = await fpcalcService.fingerprintFile(absolutePath);

        await persistAcoustidFingerprint(item.trackId, fingerprint.fingerprint);
        await recordStageSuccess(item.trackId, "fingerprint", "fpcalc", {
            characters: fingerprint.fingerprint.length,
            duration: fingerprint.duration,
        }, item.jobId);
        await reopenRecordingThatNeverAskedAcoustid(item.trackId);
    } catch (err) {
        logger.debug(
            `[Enrichment] Fingerprint failed for ${item.trackId}: ${(err as Error).message}`,
        );
        await recordStageFailure(item.trackId, "fingerprint", "fpcalc", err, {
            paths: ["fpcalc"],
        }, item.jobId);
    }
}

/**
 * The fingerprint pool: up to availableParallelism() fpcalc runs at once, each
 * bounded by the stage timeout, so one hung run stalls nothing. A timeout is
 * recorded like any other fingerprint failure.
 */
const FINGERPRINT_CONCURRENCY = Math.max(1, os.availableParallelism());

class FingerprintPool {
    private active = 0;
    private waiting: Array<() => void> = [];

    async run<T>(task: () => Promise<T>): Promise<T> {
        while (this.active >= FINGERPRINT_CONCURRENCY) {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        this.active++;
        try {
            return await task();
        } finally {
            this.active--;
            this.waiting.shift()?.();
        }
    }
}
const fingerprintPool = new FingerprintPool();
const fingerprintWork = new Set<Promise<void>>();

function runFingerprintInPool(item: StageWork): void {
    const run = fingerprintPool
        .run(() =>
            withTimeout(
                runFingerprintStageWork(item),
                getStageTimeoutMs("fingerprint"),
                `Timeout fingerprinting ${item.filePath ?? item.trackId}`,
            ),
        )
        .catch((err: unknown) => {
            // The per-call budget expired (or the pool itself broke):
            // record it as the classified failure it is — never a silent
            // drop, never an unhandled rejection.
            logger.warn(
                `[Enrichment] Fingerprint work for ${item.trackId} did not finish: ${(err as Error).message}`,
            );
            return recordStageFailure(
                item.trackId,
                "fingerprint",
                "fpcalc",
                err,
                { paths: ["fpcalc"], timedOut: true },
                item.jobId,
            );
        })
        .finally(() => {
            fingerprintWork.delete(run);
        });
    fingerprintWork.add(run);
}

/** Resolves once every fingerprint run handed to the pool has settled. The engine never waits on
 * it (the pool answers on its own schedule); tests do. */
export async function waitForFingerprintWork(): Promise<void> {
    while (fingerprintWork.size > 0) {
        await Promise.allSettled([...fingerprintWork]);
    }
}

/** Offer the fingerprint stage its own batch, so busier stages cannot starve it. */
export async function executeFingerprintPhase(): Promise<number> {
    const features = await featureDetection.getFeatures();
    // No fpcalc binary: the questions stay pending — owed, not failed.
    // Installing chromaprint is what answers them; nothing is made up and
    // nothing is marked done that was not measured.
    if (!features.fpcalc) return 0;

    const work = await getNextWork(TRACK_BATCH_SIZE, "fingerprint");
    return dispatchStageWork("fingerprint", work, STAGE_PRODUCERS.fingerprint);
}

/** Evidence on a recording no-match that could not ask AcoustID: the file had no fingerprint. */
const ACOUSTID_NOT_ASKED = "not asked: the file's fingerprint question closed";

/**
 * A fingerprint just landed: a recording no-match that closed without asking AcoustID,
 * for want of one, can ask now.
 */
async function reopenRecordingThatNeverAskedAcoustid(trackId: string): Promise<void> {
    try {
        const reopened = await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage"
                SET ${ASKED_AGAIN_SQL}, evidence = jsonb_build_object('reason', 'fingerprint landed')
              WHERE "trackId" = $1
                AND stage = 'recording'
                AND status = 'done'
                AND evidence ->> 'acoustid' = $2`,
            trackId,
            ACOUSTID_NOT_ASKED,
        );
        if (reopened > 0) {
            logger.debug(`[Enrichment] Fingerprint landed for ${trackId}: its recording question asks AcoustID now`);
        }
    } catch (err) {
        // The fingerprint is answered either way; this only leaves the recording closed as it was.
        logger.warn(`[Enrichment] Could not reopen the recording question for ${trackId}: ${(err as Error).message}`);
    }
}

/**
 * "Retry failed and blocked": offer every record that is owed or due a retry.
 * Nothing is reset; `done` and terminal answers stay closed.
 */
export async function retryFailedAndBlocked(
    limit = TRACK_BATCH_SIZE,
): Promise<StageWork[]> {
    // Each stage gets its own window, so one press reopens every owed question.
    const work: StageWork[] = [];
    for (const stage of STAGE_ORDER) {
        const stageWork = await getNextWork(limit, stage);
        work.push(...stageWork);
        await dispatchStageWork(stage, stageWork, STAGE_PRODUCERS[stage]);
    }

    return work;
}

/**
 * "Re-decide everything": reopen every stage question, answered or not, for
 * when the answers are known to be wrong. A track that already has a
 * recordingMbid keeps its recording answer. No answer rows are deleted.
 */
export async function redecideEverything(): Promise<{ reopened: number }> {
    let reopened = 0;

    for (const stage of STAGE_ORDER) {
        reopened += await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage" ts
                SET ${ASKED_AGAIN_SQL}, "decidedAt" = NULL, "decidedBy" = NULL
               FROM "Track" t
              WHERE ts.stage = $1
                AND t.id = ts."trackId"
                -- AcoustID dedup guard: never re-ask a recording we found.
                AND NOT (ts.stage = 'recording' AND t."recordingMbid" IS NOT NULL)`,
            stage,
        );
    }

    reopened -= await closeStagesForMissingTracks(prisma);

    // Mirror the reopen onto the Track columns the analyzer claims and the UI reads;
    // a column still saying `completed` would let reconcileStaleStageRecords close
    // the reopened record again before anything answered it.
    await prisma.track.updateMany({
        // A missing file's columns were just mirrored closed with its records; they stay so.
        where: { analysisStatus: { not: "pending" }, missingSince: null },
        data: {
            analysisStatus: "pending",
            analysisStartedAt: null,
            analysisRetryCount: 0,
        },
    });

    logger.debug(`[Enrichment] Re-deciding everything: ${reopened} stage records reopened`);

    // No dispatch here: the next cycle offers the reopened records. Claiming them
    // now would hide the reopened state and park unconsumed claims until the lease.

    return { reopened };
}

const ENRICHMENT_FAILURES_KEY = "enrichment-failures";
const WAITING_KEY_PREFIX = "enrichment-waiting:";

/** Remove each source's waiting alert once no alerted record still waits on it. */
export async function syncWaitingAlerts(): Promise<void> {
    const { notificationService } = await import("../services/notificationService");
    const alerts = await prisma.notification.findMany({
        where: { groupKey: { startsWith: WAITING_KEY_PREFIX } },
        distinct: ["groupKey"],
        select: { groupKey: true },
    });
    if (alerts.length === 0) return;
    const waiting = await prisma.$queryRawUnsafe<Array<{ source: string }>>(
        `SELECT DISTINCT source FROM "TrackStage"
          WHERE status = 'pending' AND "lastErrorCode" = 'RATE_LIMITED'
            AND evidence->>'waitingAlerted' = 'true'`,
    );
    const still = new Set(waiting.map((r) => `${WAITING_KEY_PREFIX}${r.source}`));
    for (const { groupKey } of alerts) {
        if (groupKey && !still.has(groupKey)) await notificationService.resolve(groupKey);
    }
}

/** Keep one alert per admin naming what enrichment could not finish. It changes
 * only when the failure counts change and is removed once nothing has failed. */
export async function syncEnrichmentFailureAlert(): Promise<void> {
    const { notificationService } = await import("../services/notificationService");
    // TrackStage-backed for track stages, so it matches the failures list in Settings.
    const failureCounts = await enrichmentFailureService.getFailureCounts();
    if (failureCounts.total === 0) {
        await notificationService.resolve(ENRICHMENT_FAILURES_KEY);
        return;
    }

    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const parts = [
        failureCounts.artist > 0 && count(failureCounts.artist, "artist", "artists"),
        failureCounts.track > 0 && count(failureCounts.track, "track", "tracks"),
        failureCounts.audio > 0 && count(failureCounts.audio, "audio analysis", "audio analyses"),
        failureCounts.vibe > 0 && count(failureCounts.vibe, "vibe embedding", "vibe embeddings"),
        failureCounts.scan > 0 && count(failureCounts.scan, "fingerprint", "fingerprints"),
        failureCounts.podcast > 0 && count(failureCounts.podcast, "podcast", "podcasts"),
    ].filter(Boolean);

    await notificationService.notifyAdmins({
        type: "error",
        title: "Enrichment failures",
        message: `${count(failureCounts.total, "item", "items")} could not be enriched: ${parts.join(", ")}.`,
        metadata: { href: "/settings#enrichment-failures" },
        groupKey: ENRICHMENT_FAILURES_KEY,
    });
}

async function runEnrichmentCycle(fullMode: boolean): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
    /** Queued for embedding this cycle. */
    vibeQueued?: number;
    /** Fingerprint answers landed this cycle (local fpcalc, inline). */
    fingerprintsQueued?: number;
    /**
     * Set when the cycle declined to run, as opposed to running and finding nothing.
     * An empty cycle backs off; a declined one should come back promptly.
     */
    declined?: "already-running" | "too-soon";
}> {
    const emptyResult = { artists: 0, tracks: 0, audioQueued: 0 };

    // Handle stopping state: transition to idle before checking isPaused.
    // This must run first because stop sets both isStopping AND isPaused.
    // If we checked isPaused first, we'd return early and never clear isStopping.
    if (isStopping) {
        // No stop-cleanup reset: stopping does not edit answers. The record
        // owns the attempt, and flipping `processing` rows back to `pending`
        // here would re-ask questions the stage records have already answered.
        await enrichmentStateService.updateState({ status: "idle", currentPhase: null });
        isStopping = false;
        isPaused = false;
        userStopped = true;
        return emptyResult;
    }

    // User explicitly stopped -- don't auto-restart via timer. startEnrichmentNow clears this.
    if (userStopped && !fullMode && !immediateEnrichmentRequested) {
        if (!userStoppedWarned) {
            const pendingCount = await prisma.track.count({ where: { analysisStatus: "pending" } });
            if (pendingCount > 0) {
                logger.warn(`[Enrichment] userStopped=true but ${pendingCount} tracks are pending. Use "Run Enrichment" or "Full Enrichment" to resume.`);
                userStoppedWarned = true;
            }
        }
        return emptyResult;
    }

    // Sync local flags with state service (fallback for missed control messages)
    if (isPaused) {
        // State says running but this process is paused: resume the real infrastructure,
        // not just the flag. A missed resume message would otherwise leave workers
        // paused and the analyzer gated while state reports running.
        const state = await enrichmentStateService.getState();
        if (state?.status === "running") {
            logger.warn("[Enrichment] Reverse sync: state is running but local pause was set -- resuming workers + analyzer gate");
            await resumeInfrastructure();
            isPaused = false;
        }
    } else {
        const state = await enrichmentStateService.getState();
        if (state?.status === "paused") {
            isPaused = true;
        } else if (state?.status === "stopping") {
            // State says stopping but we missed the control message. Same
            // reasoning as the isStopping branch above: no reset of
            // `processing` rows, because the stage record owns the attempt and
            // rewriting the column would contradict it.
            await enrichmentStateService.updateState({ status: "idle", currentPhase: null });
            userStopped = true;
            return emptyResult;
        }
    }

    if (isPaused) {
        return emptyResult;
    }

    // Never allow concurrent runs
    if (isRunning) {
        return { ...emptyResult, declined: "already-running" };
    }

    // Enforce minimum interval (unless full mode or immediate request)
    const bypassIntervalCheck = fullMode || immediateEnrichmentRequested;
    const now = Date.now();
    if (!bypassIntervalCheck && now - lastRunTime < MIN_INTERVAL_MS) {
        return { ...emptyResult, declined: "too-soon" };
    }

    immediateEnrichmentRequested = false;
    lastRunTime = now;

    // Detect hangs: warn if enrichment has been "running" > 15 min with no state update
    const isHung = await enrichmentStateService.detectHang();
    if (isHung) {
        logger.warn("[Enrichment] Hang detected — enrichment has been running > 15 min with no activity");
    }

    // The flag above covers this process; the lock covers others, so two processes
    // never offer the same records.
    if (!(await distributedLock.acquire(CYCLE_LOCK_KEY, CYCLE_LOCK_TTL_MS))) {
        return { ...emptyResult, declined: "already-running" };
    }
    const stopLockRenewal = distributedLock.keepAlive(CYCLE_LOCK_KEY, CYCLE_LOCK_TTL_MS);

    isRunning = true;

    let artistsProcessed = 0;
    let tracksProcessed = 0;
    let audioQueued = 0;
    let vibeQueued = 0;
    let fingerprintsQueued = 0;

    try {
        // Close dependents of closed prerequisites first, so they never sit `pending`.
        await closeOrphanedDependents();
        await syncWaitingAlerts();

        // Run phases sequentially, halting if stopped/paused
        const artistResult = await runPhase("artists", executeArtistsPhase);
        if (artistResult === null) {
            return { artists: 0, tracks: 0, audioQueued: 0 };
        }
        artistsProcessed = artistResult;

        const trackResult = await runPhase("tracks", executeIdentificationPhase);
        if (trackResult === null) {
            return { artists: artistsProcessed, tracks: 0, audioQueued: 0 };
        }
        tracksProcessed = trackResult;

        // Fingerprint sweep — local fpcalc, no prerequisite: every track
        // gets its fingerprint stored,
        // independent of where its identity or analysis stand. A paused
        // 'acoustid' source gates only the network lookup, never this.
        const fingerprintResult = await runPhase("fingerprint", executeFingerprintPhase);
        if (fingerprintResult === null) {
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued: 0 };
        }
        fingerprintsQueued = fingerprintResult;

        const audioResult = await runPhase("audio", executeAudioPhase);
        if (audioResult === null) {
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued: 0 };
        }
        audioQueued = audioResult;

        // Podcast refresh phase -- only runs if subscriptions exist
        await runPhase("podcasts", executePodcastRefreshPhase);

        // Vibe embedding sweep — catches tracks missed by the event-driven subscriber
        const vibeResult = await runPhase("vibe", executeVibePhase);
        vibeQueued = vibeResult ?? 0;

        await runPhase("mood", executeMoodPhase);

        await runPhase("similarity", executeSimilarityPhase);

        // Orphaned failure cleanup -- runs at most once per hour, never during stop/pause
        const ONE_HOUR_MS = 60 * 60 * 1000;
        if (!isStopping && !isPaused && (!lastOrphanedFailuresCleanup || Date.now() - lastOrphanedFailuresCleanup.getTime() > ONE_HOUR_MS)) {
            await enrichmentFailureService.cleanupOrphanedFailures();
            lastOrphanedFailuresCleanup = new Date();
        }

        // Daily: clean up old resolved failures (>30 days)
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        if (!isStopping && !isPaused && (!lastResolvedCleanup || Date.now() - lastResolvedCleanup.getTime() > ONE_DAY_MS)) {
            lastResolvedCleanup = new Date();
            await enrichmentFailureService.cleanupOldResolved();
        }

        const features = await featureDetection.getFeatures();
        // Computed ONCE per cycle; everything below reads this copy.
        const progress = await getEnrichmentProgress();
        const didWork =
            artistsProcessed > 0 ||
            tracksProcessed > 0 ||
            audioQueued > 0 ||
            fingerprintsQueued > 0;

         // Log progress (only if work was done)
         if (didWork) {
            logger.debug(
                `[Enrichment] Progress: artists ${progress.artists.completed}/${progress.artists.total} (${progress.artists.progress}%)`,
            );
            logger.debug(
                `[Enrichment] Progress: track tags ${progress.trackTags.enriched}/${progress.trackTags.total} (${progress.trackTags.progress}%)`,
            );
            logger.debug(
                `[Enrichment] Progress: audio analysis ${progress.audioAnalysis.completed}/${progress.audioAnalysis.total} (${progress.audioAnalysis.progress}%)`,
            );
            if (features.fpcalc) {
                logger.debug(
                    `[Enrichment] Progress: fingerprints ${progress.fingerprints.completed}/${progress.fingerprints.total} (${progress.fingerprints.progress}%)`,
                );
            }
            if (features.vibeEmbeddings) {
                logger.debug(
                    `[Enrichment] Progress: vibe embeddings ${progress.clapEmbeddings.completed}/${progress.clapEmbeddings.total} (${progress.clapEmbeddings.progress}%)`,
                );
            }

            // Update state with progress
            await enrichmentStateService.updateState({
                artists: {
                    total: progress.artists.total,
                    completed: progress.artists.completed,
                    failed: progress.artists.failed,
                },
                tracks: {
                    total: progress.trackTags.total,
                    completed: progress.trackTags.enriched,
                    failed: 0,
                },
                audio: {
                    total: progress.audioAnalysis.total,
                    completed: progress.audioAnalysis.completed,
                    failed: progress.audioAnalysis.failed,
                    processing: progress.audioAnalysis.processing,
                },
                completionNotificationSent: false, // Reset flag when new work is processed
            });

        }

        // Core enrichment gives artists their images: drop the cached mixes once.
        if (progress.coreComplete) {
            const state = await enrichmentStateService.getState();
            if (!state?.coreCacheCleared) await clearMixCache("core", { coreCacheCleared: true });
        }

        if (progress.isFullyComplete) {
            // Flush final audio counter before going idle -- it may be stale because
            // the update block above only runs when audioQueued > 0.  Once all tracks
            // are already queued, that block is skipped while Essentia finishes in
            // the background, leaving the counter frozen at a mid-run snapshot.
            await enrichmentStateService.updateState({
                status: "idle",
                currentPhase: null,
                audio: {
                    total: progress.audioAnalysis.total,
                    completed: progress.audioAnalysis.completed,
                    failed: progress.audioAnalysis.failed,
                    processing: 0,
                },
            });

            const stateBeforeNotify = await enrichmentStateService.getState();

            // Mixes are rebuilt once the analysis they read is in.
            if (!stateBeforeNotify?.fullCacheCleared) await clearMixCache("full", { fullCacheCleared: true });

            if (!stateBeforeNotify?.completionNotificationSent) {
                try {
                    await syncEnrichmentFailureAlert();

                    await enrichmentStateService.updateState({ completionNotificationSent: true });
                } catch (error) {
                    logger.error("[Enrichment] Failed to update the failure alert:", error);
                }
            }
        }
    } catch (error) {
        logger.error("[Enrichment] Cycle error:", error);

        // A failure of the enrichment system itself. Per-track failures live only in
        // TrackStage; this ledger is for entities without a stage record.
        await enrichmentFailureService
            .recordFailure({
                entityType: "artist", // Generic type for system errors
                entityId: "system",
                entityName: "Enrichment System",
                errorMessage:
                    error instanceof Error ? error.message : String(error),
                errorCode: "SYSTEM_ERROR",
            })
            .catch((err) =>
                logger.error("[Enrichment] Failed to record failure:", err),
            );
    } finally {
        isRunning = false;
        stopLockRenewal();
        await distributedLock.release(CYCLE_LOCK_KEY);
    }

    return {
        artists: artistsProcessed,
        tracks: tracksProcessed,
        audioQueued,
        vibeQueued,
        fingerprintsQueued,
    };
}


/**
 * True when the fingerprint stage closed as a permanent failure: the question
 * is settled as "never", so identification skips AcoustID and records the skip.
 * Open fingerprint states never reach here; the prerequisite gate holds them.
 */
async function fingerprintStageSettledFailed(trackId: string): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<
        Array<{ status: string; retryable: boolean }>
    >(
        `SELECT status, retryable FROM "TrackStage"
          WHERE "trackId" = $1 AND stage = 'fingerprint'`,
        trackId,
    );
    const row = rows[0];
    return !!row && row.status === "failed" && !row.retryable;
}

type CatalogueRecording = AlbumCatalogue["recordings"][number];

/** What the album chain answered: this track's row plus the album-level answers. */
type CatalogueAnswer = AlbumFacts & { entry: CatalogueRecording };

/**
 * Find our file in its album's tracklist: title, version and length must agree (`recordingAgrees`). A row
 * credited to the track's artist wins, since two songs on a compilation can share a title. With none, the
 * album vouches for the artist (a name written another way) only when exactly one row is the track. Rows
 * carrying the file's ISRC are tried first.
 */
function matchCatalogueRecording(
    recordings: CatalogueRecording[],
    expected: ExpectedRecording,
    isrc: string | null,
): CatalogueRecording | null {
    const asCandidates = (rows: CatalogueRecording[], artists?: string[]) =>
        rows.map((rec) => ({
            id: rec.recordingId,
            title: rec.title,
            lengthMs: rec.durationMs,
            artists: artists ?? rec.artists,
        }));
    const credited = (rows: CatalogueRecording[]) => pickRecording(asCandidates(rows), expected);
    const vouched = (rows: CatalogueRecording[]) => {
        const agreeing = asCandidates(rows, expected.artists).filter((c) => recordingAgrees(c, expected));
        return agreeing.length === 1 ? agreeing[0] : null;
    };
    const withIsrc = isrc ? recordings.filter((rec) => rec.isrcs.includes(isrc)) : [];
    const pick = credited(withIsrc) ?? credited(recordings) ?? vouched(withIsrc) ?? vouched(recordings);
    return pick ? recordings.find((rec) => rec.recordingId === pick.id) ?? null : null;
}

/**
 * Answer one track's `recording` question and write it to the record. Runs only
 * once the fingerprint question is settled; waiting is the gate's job.
 */
export async function enrichSingleTrack(
    trackId: string,
    jobId?: string,
): Promise<"identified" | "no_match" | "deferred"> {
    const track = await prisma.track.findUnique({
        where: { id: trackId },
        include: {
            album: {
                include: {
                    artist: { select: { name: true } },
                },
            },
        },
    });

    if (!track) {
        throw entityGoneError("Track", trackId);
    }

    // Identification ladder: the file's own recording id; AcoustID, by the sound (a reply
    // saved when the dispatch asked for a batch of songs, else asked here); the album's
    // tracklist, which names the recording when nothing has yet and otherwise gives the
    // ISRCs and genres of an answer that is on it; the file's ISRC; the name search. Every
    // MusicBrainz candidate must be this track (`recordingAgrees`) before it is accepted.
    // A MusicBrainz failure stops the ladder: the record defers with the real cause.
    // AcoustID failing or paused does not stop MusicBrainz from answering; the record waits
    // for AcoustID only when MusicBrainz has no answer either.
    const timeoutMs = getStageTimeoutMs("recording");
    const trackRef = {
        id: track.id,
        title: track.title,
        filePath: track.filePath,
        duration: track.duration,
    };
    const tags = await readIdentityTags(trackRef);
    const expected: ExpectedRecording = {
        title: track.title,
        artists: [...(tags?.artists ?? []), track.album.artist.name],
        durationSec: track.duration > 0 ? track.duration : tags?.duration || null,
    };
    const isrc = normalizeIsrc(track.isrc);
    const asked: string[] = [];
    let recordingMbid: string | null = null;
    let answerSource = "musicbrainz";
    let fingerprintToStore: string | null = tags?.fingerprint ?? null;
    let failedAsk: { source: string; outcome: FailureOutcome } | null = null;
    // Why the AcoustID step never ran, when it did not: the fingerprint question closed
    // for good (AcoustID cannot be asked about this file), or the source is paused until
    // a time (it can be asked then).
    let acoustidSkipped: { reason: "fingerprint-closed" } | { reason: "paused"; until: Date } | null = null;
    // AcoustID failing to answer: kept, and the cause of the deferral only when no other
    // source names the recording.
    let acoustidFailure: FailureOutcome | null = null;
    // The recordings AcoustID would also accept, best first.
    let acoustidCandidates: string[] = [];
    // An AcoustID pick whose title is not the track's (only its length is): asked last,
    // once the tracklist, the ISRC and the name search have had their turn.
    let acoustidLengthOnly: { candidates: string[]; fingerprintFrom?: string } | null = null;
    // The album row's own tracklist, with this track on it (its recording or its name): the
    // album's year, label and genres, for the row.
    let rowAlbum: AlbumFacts | null = null;
    // The tracklist fetched, kept for the length-only pick to take its row from.
    let tracklist: AlbumCatalogue | null = null;
    // Set when the album's tracklist answered: the identity, the ISRCs, the
    // genres and the album-level answers all come from that one fetch.
    let catalogueAnswer: CatalogueAnswer | null = null;
    let evidenceFromAcoustid: Record<string, unknown> = {};

    if (tags?.recordingMbid) {
        recordingMbid = tags.recordingMbid;
        answerSource = "file_tag";
    }

    // AcoustID first for a file whose tags do not name its recording. The prerequisite
    // gate guarantees the fingerprint question is settled: use the stored fingerprint, or
    // skip and record the skip when it closed as a permanent failure.
    if (!recordingMbid) {
        const pause = await sourcePauseController.getPause("acoustid");
        if (!track.acoustidFingerprint && (await fingerprintStageSettledFailed(track.id))) {
            acoustidSkipped = { reason: "fingerprint-closed" };
        } else if (pause) {
            acoustidSkipped = { reason: "paused", until: pause.until };
        } else {
            asked.push("acoustid");
            const identified = await askWithinBudget(
                () =>
                    identifyTrackByAcoustid(
                        trackRef,
                        tags,
                        // The fingerprint stage's stored answer: never a second fpcalc run.
                        track.acoustidFingerprint ? { fingerprint: track.acoustidFingerprint } : null,
                    ),
                timeoutMs,
                `Timeout asking AcoustID: ${track.title}`,
            );
            if (identified.kind === "answered") {
                fingerprintToStore = identified.value.fingerprint ?? fingerprintToStore;
                if (identified.value.titleAgrees === false) {
                    acoustidLengthOnly = {
                        candidates: identified.value.candidates ?? [identified.value.recordingMbid],
                        fingerprintFrom: identified.value.fingerprintFrom,
                    };
                } else {
                    recordingMbid = identified.value.recordingMbid;
                    answerSource = identified.value.source;
                    evidenceFromAcoustid = { fingerprintFrom: identified.value.fingerprintFrom };
                    acoustidCandidates = identified.value.candidates ?? [identified.value.recordingMbid];
                }
            } else if (identified.kind === "absent") {
                // Asked and nothing matched — an answer, not a failure. The
                // dedupe column still wants the fingerprint.
                const fp = identified.evidence["fingerprint"];
                if (typeof fp === "string") fingerprintToStore = fp;
            } else {
                acoustidFailure = identified;
            }
        }
    }

    // The album's tracklist, by the album row's release-group id: from the files' tags, or from
    // the album step's AcoustID vote (identifyAlbumsBySound). The row's year, label and genres
    // are filled (`rowAlbum`) only when this track is on it.
    const albumRg = isMbid(track.album.rgMbid) ? track.album.rgMbid : null;
    if (albumRg) {
        asked.push("album-catalogue");
        const chain = await askWithinBudget(
            () => musicBrainzService.getAlbumCatalogue(albumRg),
            timeoutMs,
            `Timeout fetching MB album: ${track.album.title}`,
        );
        if (chain.kind === "answered") {
            tracklist = chain.value;
            const row = (id: string) => chain.value.recordings.find((rec) => rec.recordingId === id) ?? null;
            // An answer already found takes its ISRCs and genres from its row: AcoustID's
            // best candidate that is on this album, the file tag's own row. Nothing found
            // yet: the tracklist names the recording.
            const byName = () => matchCatalogueRecording(chain.value.recordings, expected, isrc);
            const entry = !recordingMbid
                ? byName()
                : answerSource === "acoustid"
                  ? acoustidCandidates.map(row).find((rec) => rec !== null) ?? null
                  : row(recordingMbid);
            const facts = albumFactsOf(chain.value);
            if (entry) {
                catalogueAnswer = { entry, ...facts };
                recordingMbid = entry.recordingId;
            }
            // The album row is filled only when this track is on its tracklist: by its recording,
            // or, for a recording found elsewhere that is not, by its name (with none found, the
            // name was the match just tried).
            if (entry || (recordingMbid && byName())) rowAlbum = facts;
        } else if (chain.kind !== "absent" && !recordingMbid) {
            failedAsk = { source: "musicbrainz", outcome: chain };
        }
    }

    if (!recordingMbid && !failedAsk && isrc) {
        asked.push("isrc");
        const hits = await askWithinBudget(
            () => musicBrainzService.lookupRecordingsByIsrc(isrc),
            timeoutMs,
            `Timeout looking up MB recordings by ISRC: ${track.title}`,
        );
        if (hits.kind === "answered") {
            const pick = pickRecording(hits.value, expected);
            if (pick) {
                recordingMbid = pick.id;
                answerSource = "isrc";
            }
        } else if (hits.kind !== "absent") {
            failedAsk = { source: "musicbrainz", outcome: hits };
        }
    }

    if (!recordingMbid && !failedAsk) {
        asked.push("mb-search");
        const search = await askWithinBudget(
            () => musicBrainzService.identifyRecording(expected),
            timeoutMs,
            `Timeout searching MB recording: ${track.title}`,
        );
        if (search.kind === "answered") {
            recordingMbid = search.value.id;
            answerSource = "musicbrainz";
        } else if (search.kind !== "absent") {
            failedAsk = { source: "musicbrainz", outcome: search };
        }
    }

    if (!recordingMbid && !failedAsk && acoustidLengthOnly) {
        const { candidates } = acoustidLengthOnly;
        // A candidate on the fetched tracklist brings its ISRCs and genres with it.
        const entry = tracklist
            ? candidates.map((id) => tracklist!.recordings.find((rec) => rec.recordingId === id)).find((rec) => rec !== undefined) ?? null
            : null;
        if (entry && tracklist) {
            catalogueAnswer = { entry, ...albumFactsOf(tracklist) };
            rowAlbum = catalogueAnswer;
        }
        recordingMbid = entry?.recordingId ?? candidates[0];
        answerSource = "acoustid";
        evidenceFromAcoustid = { fingerprintFrom: acoustidLengthOnly.fingerprintFrom, match: "length only: AcoustID's title is not the track's" };
    }

    if (!recordingMbid && !failedAsk && acoustidFailure) {
        failedAsk = { source: "acoustid", outcome: acoustidFailure };
    }

    if (fingerprintToStore && fingerprintToStore !== track.acoustidFingerprint) {
        try {
            await persistAcoustidFingerprint(track.id, fingerprintToStore);
        } catch (err) {
            // A failed fingerprint write is a real failure: the record keeps the
            // actual error and the question stays open on its own schedule.
            await recordStageFailure(track.id, "recording", "acoustid", err, {
                stage: "persisting the fingerprint on Track",
            }, jobId);
            return "deferred";
        }
    }

    if (failedAsk) {
        await recordOutcomeFailure(
            track.id,
            "recording",
            failedAsk.source,
            failedAsk.outcome,
            { asked, ...(acoustidSkipped ? { acoustid: acoustidSkipped.reason } : {}) },
            jobId,
        );
        return "deferred";
    }

    if (!recordingMbid) {
        if (acoustidSkipped?.reason === "paused") {
            // AcoustID can be asked when its pause ends: the question waits until then
            // and uses up no retry.
            await recordOutcomeFailure(track.id, "recording", "acoustid", {
                kind: "rateLimited",
                retryAfter: acoustidSkipped.until,
                evidence: { asked, acoustid: "paused" },
            }, { asked }, jobId);
            return "deferred";
        }
        // Every source that can be asked said "nothing" (AcoustID cannot be, when the
        // file's fingerprint question closed for good): close `done` with evidence
        // naming who was asked. A scan that finds the file changed asks again.
        await recordStageAbsent(track.id, "recording", "acoustid", {
            reason: "no source has a recording that is this track",
            asked,
            ...(acoustidSkipped ? { acoustid: ACOUSTID_NOT_ASKED } : {}),
        }, jobId);
        return "no_match";
    }

    const mbid = recordingMbid;
    // Asking took time: a claim re-issued meanwhile (a wipe, a changed file) owns the answer now.
    if (!(await claimIsCurrent(track.id, "recording", jobId))) return "deferred";
    await prisma.track.update({
        where: { id: track.id },
        data: { recordingMbid: mbid },
    });

    // The track's ISRC comes from its file or an import, or from the recording it
    // was identified as. Only an absent one, or one MusicBrainz gave for an earlier
    // answer, is replaced by this answer's (or cleared when it has none).
    const storeRecordingIsrc =
        answerSource !== "isrc" && (track.isrcSource == null || track.isrcSource === "musicbrainz");

    if (catalogueAnswer) {
        try {
            if (storeRecordingIsrc) await replaceRecordingIsrc(track.id, catalogueAnswer.entry.isrcs[0] ?? null);
            // A track's genres are its recording's curated genres, whichever way it was identified.
            const topGenres = topVoted(catalogueAnswer.entry.genres, 5);
            await trackIdentityService.populateTrackGenres(track.id, topGenres);
            // The same fetch answers the album: original year, label, and genres,
            // filled only where the row is still blank, and only for the album the row names.
            if (rowAlbum) await fillAlbumFromCatalogue(track.album, rowAlbum);
            await recordStageSuccess(track.id, "recording", answerSource, {
                recordingMbid: mbid,
                reason: answerSource === "file_tag"
                    ? "the file's own recording id, found in the album's tracklist"
                    : answerSource === "acoustid"
                      ? "AcoustID's recording, found in the album's tracklist"
                      : "identified from the album's tracklist",
                album:
                    track.album.rgMbidSource === "acoustid"
                        ? "the album's id from the AcoustID vote"
                        : track.album.rgMbidSource === "search"
                          ? "the album's id from a name search"
                          : "the album's own id",
                tags: topGenres,
                ...evidenceFromAcoustid,
            }, jobId);
            return "identified";
        } catch (err) {
            await recordStageFailure(track.id, "recording", "musicbrainz", err, {
                recordingMbid: mbid,
                stage: "writing the album-chain answer",
            }, jobId);
            return "deferred";
        }
    }

    try {
        // One request answers both when the ISRC is ours to store.
        const detailsLabel = `Timeout fetching MB ISRC and genres: ${track.title}`;
        const details = storeRecordingIsrc
            ? await withTimeout(musicBrainzService.getRecordingIsrcAndGenres(mbid), timeoutMs, detailsLabel).catch(
                  (err) => ({ isrc: unansweredAsk(err, detailsLabel), genres: unansweredAsk(err, detailsLabel) }),
              )
            : null;
        if (details?.isrc.kind === "answered") {
            await replaceRecordingIsrc(track.id, details.isrc.value);
        } else if (details?.isrc.kind === "absent") {
            await replaceRecordingIsrc(track.id, null);
        }
        const genres =
            details?.genres ??
            (await askWithinBudget(
                () => musicBrainzService.getRecordingGenres(mbid),
                timeoutMs,
                `Timeout fetching MB genres: ${track.title}`,
            ));
        // The album row's own tracklist answered though this recording is not on it: the
        // album is still filled from that fetch.
        if (rowAlbum) await fillAlbumFromCatalogue(track.album, rowAlbum);
        const evidence = { recordingMbid: mbid, reason: `identified via ${answerSource}`, ...evidenceFromAcoustid };
        if (genres.kind === "answered") {
            const topGenres = topVoted(genres.value.genres, 5);
            await trackIdentityService.populateTrackGenres(track.id, topGenres);
            await recordStageSuccess(track.id, "recording", answerSource, { ...evidence, tags: topGenres }, jobId);
            return "identified";
        }
        if (genres.kind === "absent") {
            // Identified, and the recording has no genres: an answer, not a failure.
            await trackIdentityService.populateTrackGenres(track.id, []);
            await recordStageSuccess(track.id, "recording", answerSource, {
                ...evidence,
                reason: `identified via ${answerSource}, recording carries no genres`,
            }, jobId);
            return "identified";
        }
        await recordOutcomeFailure(track.id, "recording", "musicbrainz", genres, {
            recordingMbid: mbid,
            stage: "fetching genres/isrc for an identified recording",
        }, jobId);
        return "deferred";
    } catch (err) {
        // An unexpected throw (a DB write, not a source answer): record it with its
        // real error so the question is re-asked on the record's own schedule.
        await recordStageFailure(track.id, "recording", answerSource, err, {
            recordingMbid: mbid,
            stage: "fetching genres/isrc for an identified recording",
        }, jobId);
        return "deferred";
    }
}

/** Set the ISRC MusicBrainz gives for the identified recording, or clear an earlier MusicBrainz one when it has none. */
async function replaceRecordingIsrc(trackId: string, isrc: string | null): Promise<void> {
    const code = normalizeIsrc(isrc);
    await prisma.track.update({
        where: { id: trackId },
        data: code ? { isrc: code, isrcSource: "musicbrainz" } : { isrc: null, isrcSource: null },
    });
}


/**
 * Check if enrichment should stop and handle state cleanup if stopping.
 * Returns true if cycle should halt (either stopping or paused).
 */
async function shouldHaltCycle(): Promise<boolean> {
    if (isStopping || userStopped) {
        await enrichmentStateService.updateState({
            status: "idle",
            currentPhase: null,
        });
        isStopping = false;
        isPaused = false;
        return true;
    }
    return isPaused;
}

/**
 * Run a phase and return result. Returns null if cycle should halt.
 */
async function runPhase(
    phaseName: NonNullable<EnrichmentPhase>,
    executor: () => Promise<number>,
): Promise<number | null> {
    await enrichmentStateService.updateState({
        status: "running",
        currentPhase: phaseName,
    });

    const result = await executor();

    if (await shouldHaltCycle()) {
        return null;
    }

    return result;
}

export async function executeArtistsPhase(): Promise<number> {
    // Reset temp-MBID artists that have been unresolvable for >24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.artist.updateMany({
        where: {
            mbid: { startsWith: "temp-" },
            enrichmentStatus: "unresolvable",
            lastEnriched: { lt: oneDayAgo },
        },
        data: { enrichmentStatus: "pending", enrichmentFailures: 0 },
    });

    // With nothing queued or running, no artist is really being enriched: one still marked so
    // lost its job (Redis emptied, a crash) and is asked again.
    const inQueue = await artistQueue.getJobCounts("waiting", "active", "delayed", "prioritized");
    if (Object.values(inQueue).every((n) => n === 0)) {
        await prisma.artist.updateMany({
            where: { enrichmentStatus: "enriching" },
            data: { enrichmentStatus: "pending" },
        });
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const pendingArtists = await prisma.artist.findMany({
        where: {
            OR: [
                { enrichmentStatus: "pending" },
                { enrichmentStatus: "failed" },
                { enrichmentStatus: "unresolvable", lastEnriched: { lt: sevenDaysAgo } },
            ],
            albums: { some: {} },
        },
        select: { id: true, name: true },
        take: ARTIST_BATCH_SIZE,
    });

    if (pendingArtists.length === 0) return 0;

    // Free reusable jobIds: completed immediately, failed after a backoff grace.
    // Without this a failed artist's `artist-<id>` marker blocks every re-add
    // until BullMQ's removeOnFail age (24h) expires -- far slower than intended.
    try {
        await artistQueue.clean(0, 0, "completed");
        await artistQueue.clean(FAILED_JOB_RETRY_GRACE_MS, 0, "failed");
    } catch (err) {
        logger.warn(`[Enrichment] artistQueue clean failed: ${(err as Error).message}`);
    }

    let queued = 0;
    for (const artist of pendingArtists) {
        try {
            // Enqueue and mark "enriching" only when the jobId slot is free. A failed job
            // inside the grace still holds it, so add() would no-op and the artist would sit
            // "enriching" until restart.
            const jobId = `artist-${artist.id}`;
            if (await artistQueue.getJob(jobId)) continue;
            // Add FIRST — if Redis is down, status stays "pending" and retries naturally
            await artistQueue.add(
                "enrich",
                { artistId: artist.id, artistName: artist.name },
                { jobId },
            );
            // Update AFTER successful add
            await prisma.artist.update({
                where: { id: artist.id },
                data: { enrichmentStatus: "enriching" },
            });
            queued++;
        } catch (err) {
            logger.warn(`[Enrichment] Failed to queue artist ${artist.id}: ${(err as Error).message}`);
        }
    }

    if (queued > 0) {
        logger.debug(`[Enrichment] Queued ${queued} artists`);
    }
    return queued;
}

/**
 * Sync `working` records with the answers the Python consumers write, since they never write the
 * record: an answer newer than the claim closes it. A claim no answer reaches is re-offered when its
 * lease runs out, which counts toward the redelivery cap, as in every stage.
 */
export async function reconcileStaleStageRecords(stage: StageName): Promise<void> {
    // Identification and fingerprinting run in this process and report even a timeout; a
    // claim whose job died is re-offered by the claim lease. Their 30 s per-question limit
    // is no measure of a dead claim: a job queued behind others waits longer than that.
    if (stage === "recording" || stage === "fingerprint") return;

    if (stage === "analysis") {
        const rows = await prisma.$queryRawUnsafe<
            Array<{ trackId: string; answer: string; error: string | null }>
        >(
            `SELECT ts."trackId",
                    CASE WHEN t."analyzedAt" >= ts."startedAt" THEN 'completed'
                         ELSE t."analysisStatus" END AS answer,
                    t."analysisError" AS error
               FROM "TrackStage" ts
               JOIN "Track" t ON t.id = ts."trackId"
              WHERE ts.stage = 'analysis'
                AND ts.status = 'working'
                AND ts."startedAt" IS NOT NULL
                AND (t."analyzedAt" >= ts."startedAt"
                     OR (t."analysisStatus" IN ('failed', 'permanently_failed')
                         AND (t."analysisStartedAt" IS NULL
                              OR t."analysisStartedAt" >= ts."startedAt")))`,
        );
        for (const row of rows) {
            if (row.answer === "completed") {
                await recordStageSuccess(row.trackId, "analysis", "analyzer", {
                    syncedFrom: "analysisStatus",
                    answer: "completed",
                });
            } else {
                await recordStageFailure(
                    row.trackId,
                    "analysis",
                    "analyzer",
                    new Error(row.error ?? "analysis failed"),
                    { syncedFrom: "analysisStatus", answer: row.answer },
                );
            }
        }
        return;
    }

    // Only an embedding answer newer than the claim counts: an older row is the previous answer,
    // kept readable for the vibe map. The claim's dispatch stamps the status columns, so a failure
    // they record is this claim's.
    const rows = await prisma.$queryRawUnsafe<
        Array<{ trackId: string; answer: string; error: string | null }>
    >(
        `SELECT ts."trackId",
                CASE WHEN te.track_id IS NOT NULL THEN 'completed'
                     ELSE t."vibeAnalysisStatus" END AS answer,
                t."vibeAnalysisError" AS error
           FROM "TrackStage" ts
           JOIN "Track" t ON t.id = ts."trackId"
           LEFT JOIN track_embeddings te
                  ON te.track_id = t.id AND te.analyzed_at >= ts."startedAt"
          WHERE ts.stage = 'embedding'
            AND ts.status = 'working'
            AND ts."startedAt" IS NOT NULL
            AND (te.track_id IS NOT NULL
                 OR (t."vibeAnalysisStatus" IN ('failed', 'permanently_failed')
                     AND t."vibeAnalysisStatusUpdatedAt" >= ts."startedAt"))`,
    );
    for (const row of rows) {
        if (row.answer === "completed") {
            await recordStageSuccess(row.trackId, "embedding", "clap", {
                syncedFrom: "track_embeddings",
                answer: "completed",
            });
        } else {
            await recordStageFailure(
                row.trackId,
                "embedding",
                "clap",
                new Error(row.error ?? "embedding failed"),
                { syncedFrom: "vibeAnalysisStatus", answer: row.answer },
            );
        }
    }
}

/**
 * Claim the owed records for `stage` and queue one job per track: the only
 * producer for each stage's queue.
 */
async function dispatchStageWork(
    stage: StageName,
    work: StageWork[],
    add: (item: StageWork) => Promise<void>,
): Promise<number> {
    let owed = work.filter((w) => w.stage === stage);
    if (owed.length === 0) return 0;

    // The record owns the answer: sync any record still `working` whose
    // answer has already landed in the columns before deciding what to
    // hand out.
    await reconcileStaleStageRecords(stage);

    // Defense in depth: getNextWork already skips a paused source, but a
    // pause opened between the offer and the dispatch must not hand out
    // more work for the same refusing source.
    const source = owed[0].source ?? STAGE_SOURCE[stage];
    if (await sourcePauseController.isPaused(source)) {
        logger.debug(
            `[Enrichment] ${stage}: source '${source}' paused — ${owed.length} owed attempts wait`,
        );
        return 0;
    }

    let queued = 0;
    // Defense in depth: getNextWork already skips tracks the scan flagged
    // missing, but a scan can flag a file between the offer and the
    // dispatch. Such an item is dropped here BEFORE the claim, so no attempt
    // is consumed and no failure is recorded for a file that is not there.
    if (owed.length > 0) {
        const missingIds = new Set(
            (
                await prisma.$queryRawUnsafe<Array<{ trackId: string }>>(
                    `SELECT id AS "trackId" FROM "Track"
                      WHERE "missingSince" IS NOT NULL AND id = ANY($1::text[])`,
                    owed.map((w) => w.trackId),
                )
            ).map((r) => r.trackId),
        );
        if (missingIds.size > 0) {
            logger.debug(
                `[Enrichment] ${stage}: dropping ${missingIds.size} item(s) flagged missing between offer and dispatch`,
            );
        }
        owed = owed.filter((w) => !missingIds.has(w.trackId));
        if (owed.length === 0) return 0;
    }

    // Dispatch only as deep as the stage can drain within the record's patience; the
    // rest stays `pending` for the next offer. A claim whose lease ran out is not in
    // flight: it is owed again, so it must not hold a place.
    const cap = await inFlightCap(stage);
    if (cap !== undefined) {
        const working = await prisma.trackStage.count({
            where: { stage, status: "working", nextRetryAt: { gt: new Date() } },
        });
        if (working >= cap) return 0;
        if (owed.length > cap - working) owed = owed.slice(0, cap - working);
    }

    for (const item of owed) {
        let claimed: Array<{ attempt: number; redelivered: number }> = [];
        try {
            // Claim before queueing, so the next cycle does not re-offer the attempt. The
            // lease re-offers a record whose worker died; each re-offer bumps `redelivered`,
            // which closes the record at the cap. Only a reported failure uses up a retry
            // (`failures`). The WHERE clause never claims an answered or closed record.
            claimed = await prisma.$queryRawUnsafe<Array<{ attempt: number; redelivered: number }>>(
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
                `${item.trackId}__${stage}`,
                item.trackId,
                stage,
                source,
                JSON.stringify({ question: item.jobKey }),
                STAGE_CLAIM_LEASE_MS / 1000,
            );
            if (claimed.length === 0) {
                // At the redelivery cap: close it with its evidence and
                // stop offering it, or a poison file loops every cycle
                // without ever consuming an attempt.
                const closed = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
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
                    item.trackId,
                    stage,
                );
                if (closed.length > 0) {
                    logger.warn(
                        `[Enrichment] ${stage}: ${item.title} lost its worker ${STAGE_REDELIVERY_CAP} times — record closed until a human re-decides`,
                    );
                }
                continue;
            }
            // Each redelivery gets its own jobId so a re-offer never reuses
            // the dead attempt's queue key; the attempt count stays put
            // because the failed delivery was never an answer.
            item.jobId = `${item.jobKey}-${claimed[0].attempt}-r${claimed[0].redelivered}`;

            await add(item);
            queued++;
        } catch (err) {
            // Release the claim: the push never happened, so the record must
            // stay due instead of parking in `working` past the lease.
            if (claimed.length > 0) {
                await prisma.$executeRawUnsafe(
                    `UPDATE "TrackStage"
                        SET status = 'pending', "startedAt" = NULL, "nextRetryAt" = NULL
                      WHERE "trackId" = $1 AND stage = $2 AND status = 'working'
                        AND attempt = $3 AND redelivered = $4`,
                    item.trackId,
                    stage,
                    claimed[0].attempt,
                    claimed[0].redelivered,
                ).catch(() => undefined);
            }
            logger.warn(
                `[Enrichment] Failed to queue ${stage} for ${item.trackId}: ${(err as Error).message}`,
            );
        }
    }

    if (queued > 0) {
        logger.debug(`[Enrichment] Queued ${queued} tracks for ${stage}`);
    }
    return queued;
}

/** How far ahead of the dispatch AcoustID is asked, so its batches fill up (10 songs per request). */
const ACOUSTID_LOOKAHEAD = 100;

/** The `recording` question (identity and genres), offered from the records in its own window. */
export async function executeIdentificationPhase(): Promise<number> {
    const upcoming = await getNextWork(ACOUSTID_LOOKAHEAD, "recording");
    await prefetchAcoustidForWork(upcoming);
    await identifyAlbumsForWork(upcoming);
    return dispatchStageWork("recording", upcoming.slice(0, TRACK_BATCH_SIZE), STAGE_PRODUCERS.recording);
}

/**
 * Give untagged albums their MusicBrainz id before their songs are handed out, so each song's
 * job reads the album's tracklist by that id; the backlog of albums whose songs are already
 * identified is worked through as well. Holds the dispatch for about one round's budget at
 * most (identifyAlbumsBySound); a failure only means this round names no album.
 */
async function identifyAlbumsForWork(work: StageWork[]): Promise<void> {
    try {
        const rows = work.length > 0
            ? await prisma.track.findMany({
                  where: { id: { in: work.map((w) => w.trackId) } },
                  select: { id: true, albumId: true },
              })
            : [];
        // The albums in the order their songs go out.
        const albumOf = new Map(rows.map((r) => [r.id, r.albumId]));
        const ordered = [...new Set(work.map((w) => albumOf.get(w.trackId)).filter((id): id is string => !!id))];
        await identifyAlbumsBySound(ordered);
    } catch (err) {
        logger.warn(`[Enrichment] Album identification skipped this round: ${(err as Error).message}`);
    }
}

/**
 * Ask AcoustID about the songs coming up in batches before their jobs run (AcoustID's limit
 * is per app key, shared by every install on it). Never holds the dispatch back: a failure
 * here only means each job asks for itself.
 */
async function prefetchAcoustidForWork(work: StageWork[]): Promise<void> {
    if (work.length === 0) return;
    try {
        const tracks = await prisma.track.findMany({
            where: { id: { in: work.map((w) => w.trackId) } },
            select: { id: true, title: true, filePath: true, duration: true, acoustidFingerprint: true, fileModified: true },
        });
        const asked = await prefetchAcoustidReplies(tracks);
        if (asked > 0) logger.debug(`[Enrichment] Asked AcoustID about ${asked} track(s) in batches`);
    } catch (err) {
        logger.warn(`[Enrichment] AcoustID batch lookup skipped: ${(err as Error).message}`);
    }
}

/**
 * The `analysis` question (Essentia decode and measure), offered from the
 * records. Nothing here flushes the analysis list or rewrites columns, which
 * would let a queued job and its record disagree.
 */
export async function executeAudioPhase(): Promise<number> {
    // Its own window, as deep as the stage may hold in flight, so analysis overlaps
    // network-bound identification and every worker always has its next track queued.
    const work = await getNextWork(await drainCap("analysis"), "analysis");
    return dispatchStageWork("analysis", work, STAGE_PRODUCERS.analysis);
}


/**
 * The `embedding` question (CLAP), offered only for tracks whose own analysis
 * is `done`, so one unanalysable file cannot hold back anyone else's.
 */
export async function executeVibePhase(): Promise<number> {
    const features = await featureDetection.getFeatures();
    if (!features.vibeEmbeddings) {
        return 0;
    }
    const work = await getNextWork(await drainCap("embedding"), "embedding");
    return dispatchStageWork("embedding", work, STAGE_PRODUCERS.embedding);
}

/**
 * The mood step: the learned mood scores for new or changed sound vectors and the
 * library's mood statistics when their inputs changed (services/moods/state.ts),
 * then every track's mood tags from them. Mixes are cached from the moods, so any
 * change to scores or statistics drops the cached mixes. A failure is logged, the
 * transaction it happened in writes nothing, and the cycle goes on to the similarity
 * step, which never reads the moods. Returns how many tracks were scored.
 */
export async function executeMoodPhase(): Promise<number> {
    try {
        const { scored, stateChanged } = await buildMoods();
        if (scored > 0 || stateChanged) {
            const dropped = await dropCachedMixes();
            if (dropped > 0) logger.info(`[Enrichment] Cleared ${dropped} mix cache entries after the moods changed`);
        }
        const tagged = await writeMoodTags();
        if (tagged > 0) logger.info(`[Enrichment] Mood tags changed on ${tagged} tracks`);
        return scored;
    } catch (error) {
        logger.error("[Enrichment] Mood step failed; the cycle goes on without it:", error);
        return 0;
    }
}

/**
 * The similarity step: feel for new sound vectors and the library's matching
 * state when its inputs changed (services/matching/state.ts), then the vibe map:
 * laid out or extended with new tracks (services/matching/map.ts). Returns how
 * many tracks got feel or a map position.
 */
export async function executeSimilarityPhase(): Promise<number> {
    const features = await featureDetection.getFeatures();
    if (!features.vibeEmbeddings) {
        return 0;
    }
    const { feelUpdated } = await buildMatching();
    // The one-time layout waits for everything the formula reads: artist genres, analysis and sound
    // vectors, including answers still due a retry.
    const progress = await getEnrichmentProgress();
    const formulaInputsSettled =
        progress.artists.owed === 0 &&
        progress.audioAnalysis.pending === 0 &&
        progress.audioAnalysis.processing === 0 &&
        progress.audioAnalysis.failed === 0 &&
        progress.clapEmbeddings.pending === 0 &&
        progress.clapEmbeddings.processing === 0 &&
        progress.clapEmbeddings.retrying === 0;
    const { laidOut, placed } = await updateMap(formulaInputsSettled);
    if (laidOut > 0) logger.info(`[Enrichment] Vibe map laid out: ${laidOut} tracks`);
    return feelUpdated + laidOut + placed;
}

export async function executePodcastRefreshPhase(): Promise<number> {
    const podcastCount = await prisma.podcast.count();
    if (podcastCount === 0) return 0;

    const ONE_HOUR = 60 * 60 * 1000;
    const staleThreshold = new Date(Date.now() - ONE_HOUR);
    const stalePodcasts = await prisma.podcast.findMany({
        where: { lastRefreshed: { lt: staleThreshold } },
        select: { id: true, title: true },
    });

    if (stalePodcasts.length === 0) return 0;

    // BullMQ keeps the jobId marker after completed and failed jobs alike; a kept
    // failed job would make every later add() for that podcast a silent no-op. Clean both.
    try {
        await podcastQueue.clean(0, 0, "completed");
        await podcastQueue.clean(0, 0, "failed");
    } catch (err) {
        logger.warn(`[Enrichment] podcastQueue clean failed: ${(err as Error).message}`);
    }

    // Advance lastRefreshed before queuing so every outcome, including an
    // unreachable feed, gets a full backoff window instead of re-queuing each cycle.
    await prisma.podcast.updateMany({
        where: { id: { in: stalePodcasts.map((p) => p.id) } },
        data: { lastRefreshed: new Date() },
    });

    let queued = 0;
    for (const podcast of stalePodcasts) {
        try {
            await podcastQueue.add(
                "refresh",
                { podcastId: podcast.id, podcastTitle: podcast.title },
                { jobId: `podcast-${podcast.id}` }, // dedup: completed jobs are cleaned above
            );
            queued++;
        } catch (err) {
            logger.warn(`[Enrichment] Failed to queue podcast ${podcast.id}: ${(err as Error).message}`);
        }
    }

    if (queued > 0) {
        logger.debug(`[Enrichment] Queued ${queued} podcast refreshes`);
    }
    return queued;
}

/** Memo for the progress readout, polled by the scheduler and every open
 * settings tab; it lives no longer than a cycle interval. */
let progressMemo: { at: number; value: EnrichmentProgress } | null = null;
const PROGRESS_MEMO_MS = 5 * 1000;

type EnrichmentProgress = Awaited<ReturnType<typeof computeEnrichmentProgress>>;

/**
 * A stage's percent done over the songs whose files are there: a song whose file is gone is not owed (the scan
 * reopens it if the file comes back), so it neither counts as done nor holds the bar short of 100.
 */
function shareDone(completed: number, total: number, missing: number): number {
    const owed = total - missing;
    return owed > 0 ? Math.round((completed / owed) * 100) : 0;
}

export async function getEnrichmentProgress(): Promise<EnrichmentProgress> {
    if (progressMemo && Date.now() - progressMemo.at < PROGRESS_MEMO_MS) {
        return progressMemo.value;
    }
    const value = await computeEnrichmentProgress();
    progressMemo = { at: Date.now(), value };
    return value;
}

/** Drop the memo so the next read reflects a write that just happened. */
export function invalidateEnrichmentProgress(): void {
    progressMemo = null;
}

/** Enrichment progress per stage, read from the records and the analysis queue. */
async function computeEnrichmentProgress() {
    // Artist progress
    const artistCounts = await prisma.artist.groupBy({
        by: ["enrichmentStatus"],
        _count: true,
    });

    const artistTotal = artistCounts.reduce((sum, s) => sum + s._count, 0);
    const artistCompleted =
        (artistCounts.find((s) => s.enrichmentStatus === "completed")?._count || 0) +
        (artistCounts.find((s) => s.enrichmentStatus === "unresolvable")?._count || 0);
    const artistPending =
        artistCounts.find((s) => s.enrichmentStatus === "pending")?._count || 0;
    // Still to answer: waiting, in flight, or failed and due a retry; only artists with albums are enriched.
    const artistsOwed = await prisma.artist.count({
        where: { enrichmentStatus: { in: ["pending", "enriching", "failed"] }, albums: { some: {} } },
    });

    // Per-stage counts come from TrackStage, one LEFT JOIN from Track per stage, so
    // a track with no record counts as owed rather than vanishing from the totals.
    const stageCounts = await Promise.all(
        STAGE_ORDER.map(async (stage) => {
            const [row] = await prisma.$queryRaw<
                {
                    total: bigint;
                    completed: bigint;
                    working: bigint;
                    retryable_failed: bigint;
                    terminal_failed: bigint;
                    file_missing: bigint;
                }[]
            >`
                SELECT
                    count(*)                                                    AS total,
                    count(*) FILTER (WHERE ts.status = 'done')                AS completed,
                    count(*) FILTER (WHERE ts.status = 'working')             AS working,
                    count(*) FILTER (
                        WHERE ts.status = 'failed' AND ts.retryable
                    )                                                           AS retryable_failed,
                    count(*) FILTER (
                        WHERE (ts.status = 'failed' AND NOT ts.retryable
                               AND ts."failureClass" IS DISTINCT FROM 'FILE_MISSING')
                           OR ts.status = 'blocked'
                    )                                                           AS terminal_failed,
                    count(*) FILTER (
                        WHERE ts.status = 'failed' AND NOT ts.retryable
                          AND ts."failureClass" = 'FILE_MISSING'
                    )                                                           AS file_missing
                FROM "Track" t
                LEFT JOIN "TrackStage" ts
                         ON ts."trackId" = t.id AND ts.stage = ${stage}
            `;
            return {
                total: Number(row?.total ?? 0),
                completed: Number(row?.completed ?? 0),
                working: Number(row?.working ?? 0),
                retryableFailed: Number(row?.retryable_failed ?? 0),
                terminalFailed: Number(row?.terminal_failed ?? 0),
                fileMissing: Number(row?.file_missing ?? 0),
            };
        }),
    );
    const [recording, analysis, embedding, fingerprint] = stageCounts;

    // The analysis queue is a Redis list, so its depth is read from the list. The
    // embedding queue's jobs are all covered by `working` records.
    const audioQueueLength = await getRedis().llen("audio:analysis:queue");

    // Recording records whose fingerprint is not settled are blocked, not owed:
    // the gate keeps them unoffered. Reported separately so the UI does not show
    // work the sweep cannot do. Missing files are counted as `waitingMissing`.
    const [recordingWaitingRow] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting
          FROM "TrackStage" ts
          JOIN "Track" t ON t.id = ts."trackId"
         WHERE t."missingSince" IS NULL
           AND ts.stage = 'recording'
           AND (ts.status = 'pending'
                OR (ts.status = 'failed' AND ts.retryable
                    AND (ts."nextRetryAt" IS NULL
                         OR ts."nextRetryAt" <= now())))
           AND NOT EXISTS (
               SELECT 1 FROM "TrackStage" prev
                WHERE prev."trackId" = ts."trackId"
                  AND prev.stage = 'fingerprint'
                  AND (prev.status IN ('done', 'blocked')
                       OR (prev.status = 'failed'
                           AND NOT prev.retryable))
           )
    `;
    const recordingWaiting = Number(recordingWaitingRow?.waiting ?? 0);

    const moods = await moodProgress();
    const similarity = await matchingProgress();

    // Questions about missing files are closed by the scan as FILE_MISSING and
    // reported per stage as `waitingMissing`; the scan reopens them if the file returns.

    const recordingPending =
        recording.total -
        recording.completed -
        recording.terminalFailed -
        recording.retryableFailed -
        recording.working -
        recording.fileMissing;
    const analysisPending =
        analysis.total -
        analysis.completed -
        analysis.terminalFailed -
        analysis.retryableFailed -
        analysis.working -
        analysis.fileMissing;
    const embeddingPending =
        embedding.total -
        embedding.completed -
        embedding.terminalFailed -
        embedding.retryableFailed -
        embedding.working -
        embedding.fileMissing;
    const fingerprintPending =
        fingerprint.total -
        fingerprint.completed -
        fingerprint.terminalFailed -
        fingerprint.retryableFailed -
        fingerprint.working -
        fingerprint.fileMissing;
    const coreComplete =
        artistsOwed === 0 &&
        recordingPending === 0 &&
        recording.working === 0 &&
        recording.retryableFailed === 0 &&
        // A waiting recording is not a done answer: core completion must not
        // fire while questions are parked behind the fingerprint gate.
        recordingWaiting === 0;

    return {
        // Where every number below comes from -- the settings UI and the
        // state-service counters must not claim a column-derived figure.
        source: "TrackStage",

        // Core enrichment (blocking)
        artists: {
            total: artistTotal,
            completed: artistCompleted,
            pending: artistPending,
            owed: artistsOwed,
            failed:
                artistCounts.find((s) => s.enrichmentStatus === "failed")
                    ?._count || 0,
            progress:
                artistTotal > 0 ?
                    Math.round((artistCompleted / artistTotal) * 100)
                :   0,
        },
        trackTags: {
            total: recording.total,
            enriched: recording.completed,
            // Actionable now: the sweep can offer these.
            pending: recordingPending - recordingWaiting,
            // Open but blocked behind the fingerprint gate — the sweep
            // cannot act on them until the fingerprint question settles.
            waiting: recordingWaiting,
            // Owed again when a scan finds the file; nothing the sweep can do meanwhile.
            waitingMissing: recording.fileMissing,
            progress: shareDone(recording.completed, recording.total, recording.fileMissing),
        },

        // Background enrichment (non-blocking, runs in audio-analyzer container)
        audioAnalysis: {
            total: analysis.total,
            completed: analysis.completed,
            pending: analysisPending,
            queued: audioQueueLength,
            processing: analysis.working,
            failed: analysis.retryableFailed,
            permanentlyFailed: analysis.terminalFailed,
            waitingMissing: analysis.fileMissing,
            progress: shareDone(analysis.completed, analysis.total, analysis.fileMissing),
            isBackground: true, // Flag to indicate this runs separately
        },

        // CLAP embeddings (for vibe similarity search)
        clapEmbeddings: {
            total: embedding.total,
            completed: embedding.completed,
            pending: embeddingPending,
            processing: embedding.working,
            failed: embedding.retryableFailed + embedding.terminalFailed,
            retrying: embedding.retryableFailed,
            waitingMissing: embedding.fileMissing,
            progress: shareDone(embedding.completed, embedding.total, embedding.fileMissing),
            isBackground: true,
        },

        // AcoustID fingerprints (local fpcalc; covers EVERY track — the
        // dedupe column wants the fingerprint whether or not any lookup
        // matched).
        fingerprints: {
            total: fingerprint.total,
            completed: fingerprint.completed,
            pending: fingerprintPending,
            processing: fingerprint.working,
            failed: fingerprint.retryableFailed + fingerprint.terminalFailed,
            waitingMissing: fingerprint.fileMissing,
            progress: shareDone(fingerprint.completed, fingerprint.total, fingerprint.fileMissing),
            isBackground: true,
        },

        // The learned mood scores for each sound vector (the mood step)
        moods: {
            total: moods.total,
            completed: moods.completed,
            pending: moods.total - moods.completed,
            progress: moods.total > 0 ? Math.round((moods.completed / moods.total) * 100) : 0,
            isBackground: true,
        },

        // Feel for each sound vector and the library's matching state (the similarity step)
        similarity: {
            total: similarity.total,
            completed: similarity.completed,
            pending: similarity.total - similarity.completed,
            progress:
                similarity.total > 0 ?
                    Math.round((similarity.completed / similarity.total) * 100)
                :   0,
            isBackground: true,
        },

        // Overall status
        coreComplete, // True when artists + track tags are done
        isFullyComplete:
            coreComplete &&
            analysisPending === 0 &&
            audioQueueLength === 0 &&
            analysis.working === 0 &&
            analysis.retryableFailed === 0 &&
            embeddingPending === 0 &&
            embedding.working === 0 &&
            embedding.retryableFailed === 0 &&
            fingerprintPending === 0 &&
            fingerprint.working === 0 &&
            fingerprint.retryableFailed === 0 &&
            moods.completed === moods.total &&
            similarity.completed === similarity.total,
    };
}

/**
 * An operator's start (Run Enrichment, wipe and re-run, start vibe analysis): lifts a
 * stop or a pause, wakes the workers and the analyzer, then runs a cycle now.
 */
export async function startEnrichmentNow(): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    const state = await enrichmentStateService.getState();
    if (state?.status === "paused" || state?.status === "stopping") {
        await enrichmentStateService.updateState({ status: "idle", currentPhase: null, pausedAt: undefined });
    }
    isPaused = false;
    isStopping = false;
    userStopped = false;
    userStoppedWarned = false;
    await resumeInfrastructure();
    return triggerEnrichmentNow();
}

/** Run one enrichment cycle now, without waiting for the timer. Non-blocking. */
export async function triggerEnrichmentNow(): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    logger.debug("[Enrichment] Triggering immediate enrichment cycle...");

    // A trigger runs one cycle and never lifts an operator's stop or pause;
    // startEnrichmentNow does.

    // Set flag to bypass the minimum interval check (does NOT bypass isRunning —
    // a concurrent cycle will still cause this call to return an empty result)
    immediateEnrichmentRequested = true;
    invalidateEnrichmentProgress();
    bumpScheduleToFastInterval();

    return runEnrichmentCycle(false);
}


