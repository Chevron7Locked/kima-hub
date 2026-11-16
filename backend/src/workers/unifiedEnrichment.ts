/**
 * The enrichment scheduler: artist metadata, per-track identification,
 * audio analysis, CLAP embeddings, fingerprints and podcast refresh, driven
 * from TrackStage records on a self-rescheduling cycle, then the learned moods
 * and the similarity step from the stored sound vectors.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import Redis from "ioredis";
import { config } from "../config";
import type { Worker as BullWorker } from "bullmq";
import { closeEnrichmentQueues, QUEUE_NAMES } from "./enrichmentQueues";
import { ARTIST_BATCH_SIZE, artistProgress, queueOwedArtists, startArtistWorker } from "./enrichment/artists";
import { startTrackEnrichmentWorker } from "./trackEnrichmentWorker";
import { queueStalePodcasts, startPodcastWorker } from "./enrichment/podcasts";
import {
    startAudioCompletionSubscriber,
    stopAudioCompletionSubscriber,
    haltVibeQueuing,
    resumeVibeQueuing,
} from "./audioCompletionSubscriber";
import { createRunState } from "./enrichment/runState";
import { createMoodStep } from "./enrichment/moods";
import { runSimilarityStep } from "./enrichment/similarity";
import { ANALYSIS_QUEUE, pushToAnalyzer, runAudioAnalysis } from "./enrichment/audioAnalysisJob";
import { queueSoundVector, runSoundVectors } from "./enrichment/soundVectorJob";
import type { StageOffer, StageWork } from "./enrichment/stageOffer";
import { runFingerprints, startFingerprint } from "./enrichment/fingerprint";
import { queueIdentification, runIdentification } from "./enrichment/identification";
import { enrichmentStateService, type EnrichmentPhase } from "../services/enrichmentState";
// The stage vocabulary and every change to a stage record live in services/stages/stageRecords.ts.
import * as stageRecords from "../services/stages/stageRecords";
import {
    STAGE_ORDER,
    PREREQUISITE_STAGE,
    STAGE_SOURCE,
    STAGE_CLAIM_LEASE_MS,
    WAITING_KEY_PREFIX,
    type StageName,
} from "../services/stages/stageRecords";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { featureDetection } from "../services/featureDetection";
import { libraryScanRunning } from "./scanActivity";
import { matchingProgress } from "../services/matching/state";
import { moodProgress } from "../services/moods/state";
import { dropCachedMixes } from "../services/mixes/dropCache";

import { sourcePauseController } from "../services/sourcePauseController";
import { distributedLock } from "../utils/distributedLock";
import { embeddingsDeferredForGpu } from "../services/gpuRuntime";
import { getSystemSettings } from "../utils/systemSettings";
import { flushShownPictureChanges } from "../services/shownPictureChanges";

// ── Per-track stage queue ────────────────────────────────────────────────

/**
 * Exactly one producer per queue, so the same work cannot be queued twice under
 * different job keys. Fingerprinting runs fpcalc inline and has no queue.
 */
export const STAGE_QUEUES: Record<StageName, string> = {
    recording: QUEUE_NAMES.TRACKS,
    // The analyzer consumes a plain Redis list, not a BullMQ queue.
    analysis: ANALYSIS_QUEUE,
    embedding: QUEUE_NAMES.VIBE,
    fingerprint: "inline",
};

/** The statuses a record can be due in by its `nextRetryAt`; a `working` record whose lease ran out is due as well. */
const DUE_STATUSES = ["pending", "failed"] as const;

/** An admin chose to run both heavy models side by side, accepting the load (Settings, under Library). */
async function bothAtOnce(): Promise<boolean> {
    return (await getSystemSettings())?.analysisAndVectorsTogether === true;
}

/**
 * Which heavy model has the current run: "analysis" (MusiCNN) or "embedding" (CLAP), written each time one is handed
 * songs. The one that has it finishes every song it owes before the other starts, so a song added mid-run waits.
 */
const HEAVY_RUN_KEY = "enrichment:heavy-run";

async function takeHeavyRun(stage: "analysis" | "embedding"): Promise<void> {
    await getRedis().set(HEAVY_RUN_KEY, stage);
}

/**
 * CLAP has the run and still has a library track's vector in flight or due by the same rule the offer uses (getNextWork).
 * A CLAP that is not running or is paused holds nothing, nor does a vector waiting out a retry delay.
 */
async function clapHasTheRun(now: Date): Promise<boolean> {
    if (await bothAtOnce()) return false;
    if ((await getRedis().get(HEAVY_RUN_KEY)) !== "embedding") return false;
    if (await sourcePauseController.isPaused(STAGE_SOURCE.embedding, now)) return false;
    if (!(await featureDetection.clapRunning())) return false;
    const [row] = await prisma.$queryRaw<Array<{ owed: boolean }>>`
        SELECT EXISTS (
            SELECT 1 FROM "Track" t
              JOIN "TrackStage" an ON an."trackId" = t.id AND an.stage = 'analysis' AND an.status = 'done'
              LEFT JOIN "TrackStage" ts ON ts."trackId" = t.id AND ts.stage = 'embedding'
             WHERE t."missingSince" IS NULL
               AND t."filePath" IS NOT NULL
               AND EXISTS (SELECT 1 FROM "Album" a WHERE a.id = t."albumId" AND a.location = 'LIBRARY')
               AND (ts.id IS NULL
                    OR ts.status = 'working'
                    OR (ts.status IN ('pending', 'failed') AND ts.retryable = true
                        AND (ts."nextRetryAt" IS NULL OR ts."nextRetryAt" <= ${now})))
        ) AS owed
    `;
    return row.owed;
}

/**
 * MusiCNN and CLAP run one at a time across the library, never side by side, so each has the machine (CPU and
 * GPU) to itself. Sound vectors start once no track's analysis is owed, due a retry or in flight (unless CLAP
 * already has the run: clapHasTheRun); an analyzer that is paused or not running holds nothing back, and an
 * analysis waiting out a retry delay does not hold the vectors.
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
               AND EXISTS (SELECT 1 FROM "Album" a WHERE a.id = t."albumId" AND a.location = 'LIBRARY')
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
 * mid-run, a retry whose delay ran out) waits until CLAP has finished its run, not just its current batch. A
 * CLAP analyzer that is not running holds nothing back.
 */
export async function vectorsInFlight(now = new Date()): Promise<boolean> {
    if (await bothAtOnce()) return false;
    if (!(await featureDetection.clapRunning())) return false;
    if (await clapHasTheRun(now)) return true;
    // The count the CLAP worker publishes as a job starts and ends. A re-run resets the embedding stage rows to pending
    // while CLAP is still computing its batch, so only the published count shows that work. A key the worker never wrote
    // counts as nothing running.
    const inflight = await getRedis().get("clap:worker:inflight");
    if (inflight !== null && Number(inflight) > 0) return true;
    // A dispatched job whose CLAP worker has not started is counted by neither check above, but its stage row holds a live
    // lease, so it keeps analysis waiting through the handoff. One whose lease ran out died and holds nothing; the embedding
    // stage re-offers it once analysis is done.
    const [row] = await prisma.$queryRaw<Array<{ busy: boolean }>>`
        SELECT EXISTS (
            SELECT 1 FROM "TrackStage"
             WHERE stage = 'embedding' AND status = 'working'
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

        // An install without sound vectors is never offered an embedding, whichever caller asks.
        if (stage === "embedding" && !(await featureDetection.getFeatures()).vibeEmbeddings) {
            logger.debug("[Enrichment] 'embedding' skipped: sound vectors are switched off");
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

        if (stage === "embedding" && !(await clapHasTheRun(now)) && (await analysisStillRunning(now))) {
            logger.debug("[Enrichment] 'embedding' waits: audio analysis has tracks left");
            continue;
        }
        if (stage === "analysis" && (await vectorsInFlight(now))) {
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
                -- A Discover song is never enriched; a like moves its album to the library, and it is due from then.
                AND EXISTS (SELECT 1 FROM "Album" a WHERE a.id = t."albumId" AND a.location = 'LIBRARY')
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
const TRACK_BATCH_SIZE = 20;
const ENRICHMENT_INTERVAL_MS = 5 * 1000; // 5 seconds - rate limiter handles API limits
// Idle backoff. The cycle is cheap only when it finds work; when there is none
// it still pays for the progress queries, which include a full scan of Track.
// A library that is fully enriched -- the steady state -- was paying that every
// 5 seconds forever against the pool that also serves audio streaming.
const ENRICHMENT_IDLE_INTERVAL_MS = 60 * 1000;

/**
 * One enrichment cycle at a time across processes, so a second backend cannot
 * double-dispatch stage records. The TTL outlives the longest real cycle, so a
 * crash releases the lock by expiry.
 */
const CYCLE_LOCK_KEY = "enrichment:cycle-lease";
// Renewed while a cycle runs, so a process that dies or restarts frees it within this time.
const CYCLE_LOCK_TTL_MS = 90 * 1000;

/**
 * What the scheduler is doing: running, paused, stopping or stopped, whether a cycle is in flight, whether a
 * trigger is waiting, and whether the worker is closed. It changes only through the named moves in
 * workers/enrichment/runState.ts. The closed latch is distinct from "no timer pending": while a cycle is
 * executing there is no pending timer either, and treating a running cycle as a closed worker is what allowed a
 * second timer chain to be armed alongside the one the cycle was about to arm itself.
 */
const run = createRunState();
let enrichmentInterval: NodeJS.Timeout | null = null;
let redis: Redis | null = null;
let controlSubscriber: Redis | null = null;
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

/**
 * Initialize Redis connection for audio analysis queue
 */
function getRedis(): Redis {
    if (!redis) {
        redis = new Redis(config.redisUrl);
    }
    return redis;
}

/** The mood step (workers/enrichment/moods.ts): it reads this scheduler's progress counts and Redis. */
const moodStep = createMoodStep({ readProgress: () => getEnrichmentProgress(), redis: () => getRedis() });

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
                    run.pause();
                    logger.debug("[Enrichment] Paused");
                    Promise.all(activeEnrichmentWorkers.map((w) => w.pause())).catch(() => {});
                    haltVibeQueuing();
                } else if (message === "resume") {
                    run.resume();
                    logger.debug("[Enrichment] Resumed");
                    Promise.all(activeEnrichmentWorkers.map((w) => w.resume())).catch(() => {});
                    resumeVibeQueuing();
                } else if (message === "stop") {
                    run.stop();
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

/** Starts the enrichment cycle: control channel, one cycle now, then each cycle schedules the next. */
export async function startUnifiedEnrichmentWorker() {
    logger.debug(
        `[Enrichment] Starting worker: artist batch ${ARTIST_BATCH_SIZE}, track batch ${TRACK_BATCH_SIZE}, interval ${ENRICHMENT_INTERVAL_MS / 1000}s`
    );

    // No startup sweep is needed: a job that died mid-flight is a `working` record
    // whose lease comes due on its own.

    // A stored `paused` is an operator instruction and survives a restart. Any
    // other leftover state (`running`, `stopping`) is crash residue and starts fresh.
    const existingState = await enrichmentStateService.getState();
    const honoringPause = existingState?.status === "paused";

    // Opening clears the closed latch, or a restart within the same process arms one cycle and then
    // never reschedules.
    run.open({ paused: honoringPause });
    if (honoringPause) {
        logger.warn(
            "[Enrichment] Honouring the persisted pause — " +
                "use Resume on the Enrichment page to lift it",
        );
    } else {
        if (existingState && existingState.status !== "idle") {
            await enrichmentStateService.clear();
        }
        // Initialize state
        await enrichmentStateService.initializeState();
    }

    // Start BullMQ Workers (artist, track, podcast)
    activeEnrichmentWorkers = await Promise.all([
        startArtistWorker(),
        startTrackEnrichmentWorker(),
        startPodcastWorker(),
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

    await setupControlChannel();
    await runEnrichmentCycle();
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
            const result = await runEnrichmentCycle();

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
            // chain. The closed latch is how stopUnifiedEnrichmentWorker ends it.
            if (!run.isClosed()) {
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

/** How long a stop waits for the cycle in flight before it gives up and goes on closing. */
const STOP_WAIT_MS = 30_000;

/**
 * Closes the worker and returns once no cycle of this process is running. A cycle in flight is asked to stop at
 * its next phase and awaited, so nothing it does lands after this returns; a cycle stuck in a phase is waited for
 * STOP_WAIT_MS, then left (with a warning naming the phase) so a shutdown is not held up by it.
 */
export async function stopUnifiedEnrichmentWorker() {
    run.close();
    if (enrichmentInterval) {
        clearTimeout(enrichmentInterval);
        enrichmentInterval = null;
    }
    if (run.cycleInFlight()) run.stop();
    let giveUp: NodeJS.Timeout | undefined;
    let settled: boolean;
    try {
        settled = await Promise.race([
            run.cycleSettled().then(() => true),
            new Promise<false>((resolve) => {
                giveUp = setTimeout(() => resolve(false), STOP_WAIT_MS);
            }),
        ]);
    } finally {
        clearTimeout(giveUp);
    }
    if (!settled) {
        logger.warn(
            `[Enrichment] The cycle did not settle within ${STOP_WAIT_MS / 1000}s of the stop; closing anyway. It is ${
                run.phase() ? `still in its "${run.phase()}" phase` : "outside any phase"
            }.`,
        );
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

/** Drop every cached mix so the next read rebuilds it from what enrichment has now answered, and record
 * that this point's clear is done. */
async function clearMixCache(
    point: "core" | "full",
    done: { coreCacheCleared: true } | { fullCacheCleared: true },
): Promise<void> {
    try {
        const dropped = await dropCachedMixes(getRedis());
        if (dropped > 0) {
            logger.info(`[Enrichment] Cleared ${dropped} mix cache entries after ${point} enrichment complete`);
        }
        await enrichmentStateService.updateState(done);
    } catch (error) {
        logger.error(`[Enrichment] Failed to clear mix cache on ${point} complete:`, error);
    }
}

/** The analyzer's list on the scheduler's Redis client, opened on first use. */
const analysisList = { rpush: (key: string, value: string) => getRedis().rpush(key, value) };

/** Where a claimed attempt is handed to its queue, shared by the phases and
 * "Retry failed and blocked" so each queue keeps one producer. */
const STAGE_PRODUCERS: Record<StageName, (item: StageWork) => Promise<void>> = {
    recording: queueIdentification,
    analysis: (item) => pushToAnalyzer(analysisList, item),
    embedding: queueSoundVector,
    fingerprint: async (item) => {
        // The fingerprint pool runs fpcalc at machine concurrency and returns at once,
        // so no stage or cycle waits on the sweep. dispatchStageWork owns the claim;
        // workers/enrichment/fingerprint.ts owns the answer.
        startFingerprint(item);
    },
};

/** The `fingerprint` question, in its own batch so busier stages cannot starve it: its own work is in enrichment/fingerprint.ts. */
export async function executeFingerprintPhase(): Promise<number> {
    return runFingerprints(offerFor("fingerprint"));
}

/**
 * "Retry failed and blocked": offer every record that is owed or due a retry.
 * Nothing is reset; `done` and terminal answers stay closed.
 */
export async function retryFailedAndBlocked(
    limit = TRACK_BATCH_SIZE,
): Promise<StageWork[]> {
    // The scan goes first; the next cycle after it offers the same work.
    if (await libraryScanRunning()) return [];
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
    // The records and the status columns that show them move together; the missing-file closure after it closes (and
    // mirrors) the records of songs whose file is gone.
    let reopened = await stageRecords.askAgain({
        stages: STAGE_ORDER,
        clearDecision: true,
        // AcoustID dedup guard: never re-ask a recording we found.
        keepIdentifiedRecordings: true,
        evidence: { reason: "re-decided" },
    });

    reopened -= await stageRecords.closeForMissingFiles();

    logger.debug(`[Enrichment] Re-deciding everything: ${reopened} stage records reopened`);

    // No dispatch here: the next cycle offers the reopened records. Claiming them
    // now would hide the reopened state and park unconsumed claims until the lease.

    return { reopened };
}

const ENRICHMENT_FAILURES_KEY = "enrichment-failures";

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
        metadata: { href: "/settings/library#enrichment-failures" },
        groupKey: ENRICHMENT_FAILURES_KEY,
    });
}

async function runEnrichmentCycle(): Promise<{
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
    declined?: "already-running" | "too-soon" | "scan-running" | "stopped" | "lock-unavailable";
}> {
    const emptyResult = { artists: 0, tracks: 0, audioQueued: 0 };

    // A closed worker's queues and connections are gone, and its timer chain has ended: nothing past a stop runs,
    // however it was asked (a trigger, a late timer). Declined, not empty, so a caller does not back off on it.
    if (run.isClosed()) return { ...emptyResult, declined: "stopped" };

    // A stop asked over the control channel is seen first: it settles to stopped before anything else is checked.
    if (run.mode() === "stopping") {
        // No stop-cleanup reset: stopping does not edit answers. The record
        // owns the attempt, and flipping `processing` rows back to `pending`
        // here would re-ask questions the stage records have already answered.
        // Settled before the write: a start that lands during it is then not undone.
        run.settleStop();
        await enrichmentStateService.updateState({ status: "idle", currentPhase: null });
        return emptyResult;
    }

    // User explicitly stopped -- don't auto-restart via timer. startEnrichmentNow lifts it.
    if (!run.admitsCycle()) {
        if (!run.stopWarned()) {
            const pendingCount = await prisma.track.count({ where: { analysisStatus: "pending" } });
            if (pendingCount > 0) {
                logger.warn(`[Enrichment] Stopped, but ${pendingCount} tracks are pending. Use "Run Enrichment" or "Full Enrichment" to resume.`);
                run.markStopWarned();
            }
        }
        return emptyResult;
    }

    // Sync the run state with the state service (fallback for missed control messages)
    if (run.mode() === "paused") {
        // State says running but this process is paused: resume the real infrastructure,
        // not just the mode. A missed resume message would otherwise leave workers
        // paused and the analyzer gated while state reports running.
        const state = await enrichmentStateService.getState();
        if (state?.status === "running") {
            logger.warn("[Enrichment] Reverse sync: state is running but local pause was set -- resuming workers + analyzer gate");
            await resumeInfrastructure();
            run.resume();
        }
    } else {
        const state = await enrichmentStateService.getState();
        if (state?.status === "paused") {
            run.adoptPause();
            return emptyResult;
        } else if (state?.status === "stopping") {
            // State says stopping but we missed the control message. Same
            // reasoning as the stopping branch above: no reset of
            // `processing` rows, because the stage record owns the attempt and
            // rewriting the column would contradict it.
            run.settleStop();
            await enrichmentStateService.updateState({ status: "idle", currentPhase: null });
            return emptyResult;
        }
    }

    if (run.mode() === "paused") {
        return emptyResult;
    }

    // Never allow concurrent runs
    if (run.cycleInFlight()) {
        return { ...emptyResult, declined: "already-running" };
    }

    // The scan goes first: every step starts from the whole library, never the part scanned so far.
    if (await libraryScanRunning()) {
        logger.debug("[Enrichment] Waiting: a library scan is still adding songs");
        return { ...emptyResult, declined: "scan-running" };
    }

    // Enforce minimum interval (unless an immediate request)
    const bypassIntervalCheck = run.wakeRequested();
    const now = Date.now();
    if (!bypassIntervalCheck && now - lastRunTime < MIN_INTERVAL_MS) {
        return { ...emptyResult, declined: "too-soon" };
    }

    // Detect hangs: warn if enrichment has been "running" > 15 min with no state update
    const isHung = await enrichmentStateService.detectHang();
    if (isHung) {
        logger.warn("[Enrichment] Hang detected — enrichment has been running > 15 min with no activity");
    }

    // The in-flight check above declines quickly; the lock is what keeps two cycles, in this process or
    // another, from offering the same records.
    const cycleLock = await distributedLock.acquire(CYCLE_LOCK_KEY, CYCLE_LOCK_TTL_MS);
    if (cycleLock.outcome === "held") {
        return { ...emptyResult, declined: "already-running" };
    }
    if (cycleLock.outcome === "unavailable") {
        // Without the lock another process could be offering the same records, so the cycle waits for Redis.
        logger.warn("[Enrichment] Redis is not reachable: cycle declined until it is", cycleLock.error);
        return { ...emptyResult, declined: "lock-unavailable" };
    }
    const lease = cycleLock.lease;
    // A stop that landed while this cycle waited for the lock closed the worker, and its queues and connections
    // with it: this cycle was admitted before the stop and must not start after it.
    if (run.isClosed()) {
        await lease.release();
        return { ...emptyResult, declined: "stopped" };
    }
    const stopLockRenewal = lease.keepAlive();
    // Spent only now that this cycle holds the lock: one that lost it leaves the request and the interval
    // for the cycle that holds it.
    run.takeWake();
    lastRunTime = now;

    run.beginCycle();

    let artistsProcessed = 0;
    let tracksProcessed = 0;
    let audioQueued = 0;
    let vibeQueued = 0;
    let fingerprintsQueued = 0;

    try {
        // Close dependents of closed prerequisites first, so they never sit `pending`.
        await stageRecords.closeDependents();
        await syncWaitingAlerts();

        // Run phases sequentially, halting if stopped/paused
        const artistResult = await runPhase(lease.signal, "artists", queueOwedArtists);
        if (artistResult === null) {
            return { artists: 0, tracks: 0, audioQueued: 0 };
        }
        artistsProcessed = artistResult;

        const trackResult = await runPhase(lease.signal, "tracks", executeIdentificationPhase);
        if (trackResult === null) {
            return { artists: artistsProcessed, tracks: 0, audioQueued: 0 };
        }
        tracksProcessed = trackResult;

        // Fingerprint sweep — local fpcalc, no prerequisite: every track
        // gets its fingerprint stored,
        // independent of where its identity or analysis stand. A paused
        // 'acoustid' source gates only the network lookup, never this.
        const fingerprintResult = await runPhase(lease.signal, "fingerprint", executeFingerprintPhase);
        if (fingerprintResult === null) {
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued: 0 };
        }
        fingerprintsQueued = fingerprintResult;

        const audioResult = await runPhase(lease.signal, "audio", executeAudioPhase);
        if (audioResult === null) {
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued: 0 };
        }
        audioQueued = audioResult;

        // Podcast refresh phase -- only runs if subscriptions exist
        await runPhase(lease.signal, "podcasts", queueStalePodcasts);

        // Vibe embedding sweep — catches tracks missed by the event-driven subscriber
        const vibeResult = await runPhase(lease.signal, "vibe", executeVibePhase);
        vibeQueued = vibeResult ?? 0;

        await runPhase(lease.signal, "mood", moodStep);

        await runPhase(lease.signal, "similarity", () => runSimilarityStep(getEnrichmentProgress));

        // Without the lock the housekeeping and the progress below are left to the cycle that holds it.
        if (cycleLockLost(lease.signal)) {
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued, vibeQueued, fingerprintsQueued };
        }

        // Orphaned failure cleanup -- runs at most once per hour, never during stop/pause
        const ONE_HOUR_MS = 60 * 60 * 1000;
        if (run.mayDoHousekeeping() && (!lastOrphanedFailuresCleanup || Date.now() - lastOrphanedFailuresCleanup.getTime() > ONE_HOUR_MS)) {
            await enrichmentFailureService.cleanupOrphanedFailures();
            lastOrphanedFailuresCleanup = new Date();
        }

        // Daily: clean up old resolved failures (>30 days)
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        if (run.mayDoHousekeeping() && (!lastResolvedCleanup || Date.now() - lastResolvedCleanup.getTime() > ONE_DAY_MS)) {
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
            vibeQueued > 0 ||
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
        stopLockRenewal();
        // Whatever the cycle's workers found for a shown picture, year or genre list reaches Subsonic clients now, not
        // when the quiet window ends (it never throws).
        await flushShownPictureChanges();
        // The cycle settles only after the lease is let go, so a stop that returns leaves the next cycle a free
        // lock; and a release that fails cannot leave the stop waiting forever.
        try {
            await lease.release();
        } finally {
            run.endCycle();
        }
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
 * Check if enrichment should stop and handle state cleanup if stopping.
 * Returns true if cycle should halt (stopping, stopped or paused). A stop seen here settles to
 * stopped, so the next timer tick does not start work again.
 */
async function shouldHaltCycle(): Promise<boolean> {
    const mode = run.mode();
    if (mode === "stopping" || mode === "stopped") {
        // Settled before the write: a start that lands during it is then not undone.
        run.settleStop();
        await enrichmentStateService.updateState({
            status: "idle",
            currentPhase: null,
        });
        return true;
    }
    return run.haltRequested();
}

const lockLossSaid = new WeakSet<AbortSignal>();

/**
 * Whether the cycle lock is gone: another holder may be offering the same records, so this cycle starts nothing more.
 * It says so once.
 */
function cycleLockLost(lock: AbortSignal): boolean {
    if (!lock.aborted) return false;
    if (!lockLossSaid.has(lock)) {
        lockLossSaid.add(lock);
        logger.warn("[Enrichment] The cycle lock was lost while the cycle ran: it stops at the end of this step");
    }
    return true;
}

/**
 * Run a phase and return result. Returns null if cycle should halt: stopped, paused, or its lock `lock` was lost.
 */
async function runPhase(
    lock: AbortSignal,
    phaseName: NonNullable<EnrichmentPhase>,
    executor: () => Promise<number>,
): Promise<number | null> {
    if (cycleLockLost(lock)) return null;
    run.enterPhase(phaseName);
    let result: number;
    try {
        await enrichmentStateService.updateState({
            status: "running",
            currentPhase: phaseName,
        });
        result = await executor();
    } finally {
        run.leavePhase(phaseName);
    }

    if (await shouldHaltCycle()) {
        return null;
    }
    // A phase that ran past the loss did its work under no lock; what it queued is claimed in the stage records, which
    // the holder's cycle reads, so nothing more is started here.
    if (cycleLockLost(lock)) return null;

    return result;
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
    await stageRecords.settleLandedAnswers(stage);

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
        let claim: stageRecords.ClaimResult | undefined;
        try {
            // Claim before queueing, so the next cycle does not re-offer the attempt. The lease re-offers a
            // record whose worker died; the module closes it at the redelivery cap so a poison file stops
            // looping, and never claims an answered or closed record.
            claim = await stageRecords.claim(item.trackId, stage, { jobKey: item.jobKey, source });
            if (claim.kind !== "claimed") continue;
            item.jobId = claim.jobId;

            await add(item);
            queued++;
        } catch (err) {
            // Hand the claim back: the push never happened, so the record must stay due instead of parking in
            // `working` past the lease.
            if (claim?.kind === "claimed") {
                await stageRecords.release(item.trackId, stage, claim).catch((releaseErr) =>
                    logger.warn(`[Enrichment] Could not hand ${stage} back for ${item.trackId}; its lease will expire: ${(releaseErr as Error).message}`),
                );
            }
            logger.warn(
                `[Enrichment] Failed to queue ${stage} for ${item.trackId}: ${(err as Error).message}`,
            );
        }
    }

    if (queued > 0) {
        logger.debug(`[Enrichment] Queued ${queued} tracks for ${stage}`);
        if (stage === "analysis" || stage === "embedding") await takeHeavyRun(stage);
    }
    return queued;
}

/** The `recording` question (identity and genres): its own work is in enrichment/identification.ts. */
export async function executeIdentificationPhase(): Promise<number> {
    return runIdentification(offerFor("recording"));
}

/**
/** The `analysis` question: its own work is in enrichment/audioAnalysisJob.ts; this binds the offer to the stage. */
export async function executeAudioPhase(): Promise<number> {
    return runAudioAnalysis(offerFor("analysis"), analysisList);
}

/** The `embedding` question: its own work is in enrichment/soundVectorJob.ts. */
export async function executeVibePhase(): Promise<number> {
    return runSoundVectors(offerFor("embedding"));
}

/**
 * What a stage job asks of the scheduler: its window, the work owed to it, and the claim-and-queue dispatch. The
 * heavy stages (analysis, embedding) move at the rate their answers drain; recording and fingerprint take a fixed batch.
 */
function offerFor(stage: StageName): StageOffer {
    return {
        window: async () => (stage === "analysis" || stage === "embedding" ? drainCap(stage) : TRACK_BATCH_SIZE),
        nextWork: (limit) => getNextWork(limit, stage),
        dispatch: (work, produce) => dispatchStageWork(stage, work, produce),
    };
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
    // Which artists count, and which are owed, is the artist job's rule.
    const artists = await artistProgress();

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
                -- Library songs only: Discover songs are never enriched, so they are never owed.
                WHERE EXISTS (SELECT 1 FROM "Album" a WHERE a.id = t."albumId" AND a.location = 'LIBRARY')
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
    const audioQueueLength = await getRedis().llen(ANALYSIS_QUEUE);

    // Recording records whose fingerprint is not settled are blocked, not owed:
    // the gate keeps them unoffered. Reported separately so the UI does not show
    // work the sweep cannot do. Missing files are counted as `waitingMissing`.
    const [recordingWaitingRow] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting
          FROM "TrackStage" ts
          JOIN "Track" t ON t.id = ts."trackId"
         WHERE t."missingSince" IS NULL
           AND EXISTS (SELECT 1 FROM "Album" a WHERE a.id = t."albumId" AND a.location = 'LIBRARY')
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
        artists.owed === 0 &&
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
        artists,
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
    run.start();
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

    // Ask for a cycle past the minimum interval (does NOT bypass a cycle in flight —
    // a concurrent cycle will still cause this call to return an empty result)
    run.requestWake();
    invalidateEnrichmentProgress();
    bumpScheduleToFastInterval();

    return runEnrichmentCycle();
}

