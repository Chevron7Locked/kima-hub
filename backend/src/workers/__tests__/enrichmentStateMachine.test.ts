/**
 * The enrichment cycle's controls (stop, pause, resume, re-run), stop
 * persistence and state sync, plus the per-track stage queue. Real database: the
 * stage queue, progress counts and mood step read seeded tracks and stage records.
 * Redis, BullMQ and the network-facing services are mocked; the control flow in
 * unifiedEnrichment.ts is real.
 */

// ── Mocks ───────────────────────────────────────────────────────────

const mockUpdateState = jest.fn().mockResolvedValue({});
const mockGetState = jest.fn().mockResolvedValue(null);
const mockInitializeState = jest.fn().mockResolvedValue({});
const mockClear = jest.fn().mockResolvedValue(undefined);
const mockDetectHang = jest.fn().mockResolvedValue(false);
const mockPublishToChannel = jest.fn().mockResolvedValue(undefined);
const mockClearGate = jest.fn().mockResolvedValue(undefined);

const mockMarkFailed = jest.fn().mockResolvedValue(undefined);
const mockWaitForStatus = jest.fn().mockImplementation((statuses, _timeoutMs) =>
    Promise.resolve(statuses?.[0] ?? "running"));

jest.mock("../../services/enrichmentState", () => ({
    enrichmentStateService: {
        updateState: mockUpdateState,
        getState: mockGetState,
        initializeState: mockInitializeState,
        clear: mockClear,
        detectHang: mockDetectHang,
        clearGate: mockClearGate,
        publishToChannel: mockPublishToChannel,
        markFailed: mockMarkFailed,
        waitForStatus: mockWaitForStatus,
    },
}));

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        cleanupOrphanedFailures: jest.fn().mockResolvedValue({ cleaned: 0, checked: 0 }),
        cleanupOldResolved: jest.fn().mockResolvedValue(0),
        recordFailure: jest.fn().mockResolvedValue({}),
        resolveByEntity: jest.fn().mockResolvedValue(true),
    },
}));

jest.mock("../../services/featureDetection", () => ({
    featureDetection: { analyzerRunning: jest.fn().mockResolvedValue(false), clapRunning: jest.fn().mockResolvedValue(false),
        getFeatures: jest.fn().mockResolvedValue({
            vibeEmbeddings: true,
            podcastSupport: false,
            fpcalc: true,
        }),
    },
}));

const mockRedisPublish = jest.fn().mockResolvedValue(1);
const mockRedisQuit = jest.fn().mockResolvedValue(undefined);
const mockRedisSubscribe = jest.fn().mockResolvedValue(undefined);
const mockRedisOn = jest.fn();
const mockRedisSet = jest.fn().mockResolvedValue("OK");
const mockRedisRpush = jest.fn().mockResolvedValue(1);
const mockRedisLlen = jest.fn().mockResolvedValue(0);
const mockRedisDel = jest.fn().mockResolvedValue(1);
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisScan = jest.fn().mockResolvedValue(["0", []]);

jest.mock("ioredis", () => {
    return jest.fn().mockImplementation(() => ({
        publish: mockRedisPublish,
        quit: mockRedisQuit,
        subscribe: mockRedisSubscribe,
        on: mockRedisOn,
        set: mockRedisSet,
        rpush: mockRedisRpush,
        llen: mockRedisLlen,
        del: mockRedisDel,
        get: mockRedisGet,
        scan: mockRedisScan,
        disconnect: jest.fn(),
        status: "ready",
    }));
});

const mockBuildMoods = jest.fn();
const mockWriteMoodTags = jest.fn();
jest.mock("../../services/moods/state", () => ({
    buildMoods: () => mockBuildMoods(),
    moodProgress: jest.fn().mockResolvedValue({ total: 0, completed: 0 }),
}));
jest.mock("../../services/moods/tags", () => ({
    writeMoodTags: () => mockWriteMoodTags(),
}));

const mockLibraryScanRunning = jest.fn().mockResolvedValue(false);
jest.mock("../scanActivity", () => ({
    libraryScanRunning: () => mockLibraryScanRunning(),
}));

jest.mock("../../config", () => ({
    config: { redisUrl: "redis://localhost:6379" },
}));

const mockQueueAdd = jest.fn().mockResolvedValue({ id: "job-1" });
const mockQueueClean = jest.fn().mockResolvedValue([]);
const mockQueuePause = jest.fn().mockResolvedValue(undefined);
const mockQueueResume = jest.fn().mockResolvedValue(undefined);
const mockQueueGetJob = jest.fn().mockResolvedValue(null);
const mockQueueGetJobCounts = jest.fn().mockResolvedValue({ active: 0, waiting: 0, completed: 0, failed: 0 });

jest.mock("../enrichmentQueues", () => ({
    QUEUE_NAMES: {
        ARTISTS: "enrichment-artists",
        TRACKS: "enrichment-tracks",
        VIBE: "enrichment-vibe",
        PODCASTS: "enrichment-podcasts",
    },
    artistQueue: { add: mockQueueAdd, getJob: mockQueueGetJob, pause: mockQueuePause, resume: mockQueueResume, getJobCounts: mockQueueGetJobCounts },
    trackQueue: { add: mockQueueAdd, getJob: mockQueueGetJob, pause: mockQueuePause, resume: mockQueueResume, getJobCounts: mockQueueGetJobCounts },
    vibeQueue: { add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob, pause: mockQueuePause, resume: mockQueueResume, getJobCounts: mockQueueGetJobCounts },
    podcastQueue: { add: mockQueueAdd, getJob: mockQueueGetJob, pause: mockQueuePause, resume: mockQueueResume, getJobCounts: mockQueueGetJobCounts },
    createWorkerConnection: () => ({ host: "localhost", port: 6379 }),
    closeEnrichmentQueues: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../enrichment/artists", () => ({
    queueOwedArtists: jest.fn().mockResolvedValue(0), startArtistWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
    // The progress readout counts the real artist rows; only the queue and worker are stood in.
    artistProgress: () => jest.requireActual("../enrichment/artists").artistProgress(),
}));
jest.mock("../trackEnrichmentWorker", () => ({
    startTrackEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../enrichment/podcasts", () => ({
    queueStalePodcasts: jest.fn().mockResolvedValue(0), startPodcastWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../audioCompletionSubscriber", () => ({
    startAudioCompletionSubscriber: jest.fn(),
    stopAudioCompletionSubscriber: jest.fn().mockResolvedValue(undefined),
    haltVibeQueuing: jest.fn(),
    resumeVibeQueuing: jest.fn(),
}));

// The album step before dispatch is not what this tests, and must never reach the network.
jest.mock("../../services/albumIdentification", () => ({
    ...jest.requireActual("../../services/albumIdentification"),
    identifyAlbumsBySound: jest.fn().mockResolvedValue([]),
}));
// The AcoustID batch asked before dispatch is not what this tests, and must never reach the network.
jest.mock("../../services/acoustidIdentification", () => ({
    ...jest.requireActual("../../services/acoustidIdentification"),
    prefetchAcoustidReplies: jest.fn().mockResolvedValue(0),
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ audioAnalyzerWorkers: 2, clapWorkers: 2 }),
}));

// Silence logger during tests
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

// ── Imports ─────────────────────────────────────────────────────────

import {
    triggerEnrichmentNow,
    startEnrichmentNow,
    startUnifiedEnrichmentWorker,
    stopUnifiedEnrichmentWorker,
    executeAudioPhase,
    executeVibePhase,
    executeIdentificationPhase,
    getEnrichmentProgress,
    invalidateEnrichmentProgress,
} from "../unifiedEnrichment";
import { waitForFingerprintWork } from "../enrichment/fingerprint";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { setTimeout as realSleep } from "timers/promises";
import { putStage, deleteSeededRows, seedArtistAndAlbum } from "../../__tests__/helpers/trackStage";

const P = "zz-esm";
const id = (n: string) => `${P}_${n}`;

// ── Test helpers ────────────────────────────────────────────────────

/**
 * Stop arrives over Redis pub/sub in production. The state service mock
 * reports "stopping", which the sync block picks up the same way.
 */
function simulateStopViaStateService() {
    mockGetState.mockResolvedValueOnce({ status: "stopping" });
}

function simulatePauseViaStateService() {
    mockGetState.mockResolvedValueOnce({ status: "paused" });
}

/** A library song with no stage records: it owes every question until a test answers some. */
async function seedTrack(n: string, columns: Record<string, unknown> = {}) {
    await prisma.track.create({
        data: {
            id: id(n), albumId: id("alb"), title: n, trackNo: 1, duration: 200,
            filePath: `/music/${P}/${n}.flac`, fileModified: new Date(), fileSize: 1000,
            ...columns,
        },
    });
}

/** The fingerprint and recording questions are answered, so only the sound questions remain owed. */
async function answerIdentity(n: string) {
    await putStage(id(n), "fingerprint", "done", { source: "fpcalc" });
    await putStage(id(n), "recording", "done", { source: "musicbrainz" });
}

const wipe = () => deleteSeededRows(P);

const stageStatus = async (n: string, stage: string) =>
    (await prisma.trackStage.findUnique({ where: { trackId_stage: { trackId: id(n), stage } } }))?.status ?? null;

/** Wait for something a timer-driven cycle does in the background, in real time (the fake clock stays put). */
async function until(done: () => boolean) {
    for (let i = 0; i < 200 && !done(); i++) await realSleep(10);
    expect(done()).toBe(true);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Enrichment State Machine", () => {
    beforeAll(wipe);
    afterAll(wipe);
    beforeEach(async () => {
        await wipe();
        await seedArtistAndAlbum(P, "Esm");
        jest.clearAllMocks();
        // Only the clock timers are faked: the database's own I/O needs the real next-tick and immediate queues.
        jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "clearImmediate", "queueMicrotask"] });
        // Default: state service returns idle
        mockGetState.mockResolvedValue({ status: "idle" });
        mockBuildMoods.mockResolvedValue({ scored: 0, stateChanged: false });
        mockWriteMoodTags.mockResolvedValue(0);
        mockRedisScan.mockResolvedValue(["0", []]);
        // The library is empty unless a test seeds songs: no phase finds work.
    });

    afterEach(async () => {
        // Inline fingerprint runs finish before the next test's wipe deletes their song.
        await waitForFingerprintWork();
        // The cycle's timer chain ends with the test; its fake clock goes with it. A cycle already under way
        // finishes first (stop waits for it), so it never reads the next test's songs or writes against a deleted one.
        await stopUnifiedEnrichmentWorker();
        jest.useRealTimers();
    });

    describe("stop persistence", () => {
        it("should not auto-restart enrichment after stop via state service", async () => {
            await startUnifiedEnrichmentWorker();
            mockUpdateState.mockClear();

            // Simulate stop: state service says "stopping"
            simulateStopViaStateService();

            // First call: detects stopping, transitions to idle
            await triggerEnrichmentNow();

            // State was set to idle
            expect(mockUpdateState).toHaveBeenCalledWith(
                expect.objectContaining({ status: "idle" }),
            );

            // Now simulate a timer tick (no explicit user action)
            mockUpdateState.mockClear();
            mockGetState.mockResolvedValue({ status: "idle" });
            mockDetectHang.mockClear();

            // After the stop landed, a trigger still runs exactly one cycle
            // (the immediate flag); it does not re-arm the engine, so the timer
            // never auto-restarts a stopped engine. Only a cycle that runs checks for a hang.
            await triggerEnrichmentNow();

            expect(mockDetectHang).toHaveBeenCalledTimes(1);
        });
    });

    describe("the scan goes first", () => {
        it("hands out no work at all while a library scan is running, and runs once it is done", async () => {
            await startUnifiedEnrichmentWorker();
            // One song owes only its analysis, so a cycle that runs hands it to the analyzer.
            await seedTrack("t1");
            await answerIdentity("t1");
            mockQueueAdd.mockClear();
            mockRedisRpush.mockClear();
            mockUpdateState.mockClear();
            mockLibraryScanRunning.mockResolvedValueOnce(true);

            const held = await triggerEnrichmentNow();

            expect(held).toEqual(expect.objectContaining({ declined: "scan-running" }));
            expect(mockQueueAdd).not.toHaveBeenCalled();
            expect(mockRedisRpush).not.toHaveBeenCalled();
            expect(mockBuildMoods).not.toHaveBeenCalled();
            expect(mockUpdateState).not.toHaveBeenCalledWith(expect.objectContaining({ currentPhase: expect.any(String) }));

            await triggerEnrichmentNow();
            expect(mockUpdateState).toHaveBeenCalledWith(expect.objectContaining({ currentPhase: "artists" }));
            expect(mockRedisRpush).toHaveBeenCalledWith("audio:analysis:queue", expect.stringContaining(`"trackId":"${id("t1")}"`));
        });
    });

    describe("trigger semantics", () => {
        it("a trigger runs one cycle; it does not publish resume or lift a stop", async () => {
            await startUnifiedEnrichmentWorker();
            mockPublishToChannel.mockClear();

            await triggerEnrichmentNow();

            // A trigger is "run one cycle", not "undo what the operator
            // stopped": it never publishes the resume signal on its own.
            // (It still runs the one cycle via the immediate flag.)
            expect(mockPublishToChannel).not.toHaveBeenCalledWith(
                "audio:analysis:control",
                "resume",
            );
        });
    });

    describe("state sync edge cases", () => {
        it("should handle stopping state via state sync when control message lost", async () => {
            await startUnifiedEnrichmentWorker();
            mockUpdateState.mockClear();

            // State says "stopping" but no control message arrived (isStopping is false)
            simulateStopViaStateService();
            await triggerEnrichmentNow();

            // Should detect stopping via state sync and transition to idle
            expect(mockUpdateState).toHaveBeenCalledWith(
                expect.objectContaining({ status: "idle" }),
            );
        });

        it("should handle paused state via state sync", async () => {
            await startUnifiedEnrichmentWorker();

            // State says "paused"
            simulatePauseViaStateService();
            mockDetectHang.mockClear();
            const result = await triggerEnrichmentNow();

            // The trigger does not clear anything on its own; the cycle's
            // state sync reads "paused", parks isPaused, and declines before
            // any work (the hang check is the cycle's first step).
            expect(result).toEqual({ artists: 0, tracks: 0, audioQueued: 0 });
            expect(mockDetectHang).not.toHaveBeenCalled();
        });

        it("should reverse-sync when local isPaused is stale", async () => {
            await startUnifiedEnrichmentWorker();

            // First: get into a paused state via state sync
            simulatePauseViaStateService();
            await triggerEnrichmentNow();

            // Now state changes to running (user resumed via another path)
            mockGetState.mockResolvedValue({ status: "running" });
            mockDetectHang.mockClear();

            // Next trigger should detect the mismatch and resume: the cycle runs
            // instead of declining on the stale isPaused.
            await triggerEnrichmentNow();
            expect(mockDetectHang).toHaveBeenCalledTimes(1);
        });
    });

    describe("an operator's start lifts a stop or a pause", () => {
        it("after a stop, wakes the analyzer and runs a cycle", async () => {
            await startUnifiedEnrichmentWorker();

            simulateStopViaStateService();
            await triggerEnrichmentNow(); // the cycle observes the stop -> idle + userStopped

            mockGetState.mockResolvedValue({ status: "idle" });
            mockUpdateState.mockClear();
            mockClearGate.mockClear();
            mockPublishToChannel.mockClear();

            await startEnrichmentNow();
            expect(mockClearGate).toHaveBeenCalled();
            expect(mockPublishToChannel).toHaveBeenCalledWith("audio:analysis:control", "resume");
            expect(mockUpdateState).toHaveBeenCalledWith(
                expect.objectContaining({ status: "running" }),
            );
        });

        it("while paused, clears the stored pause and runs the cycle a plain trigger declines", async () => {
            await startUnifiedEnrichmentWorker();
            mockUpdateState.mockClear();
            mockGetState.mockResolvedValueOnce({ status: "paused" }).mockResolvedValue({ status: "idle" });

            await startEnrichmentNow();
            expect(mockUpdateState).toHaveBeenCalledWith(expect.objectContaining({ status: "idle" }));
            expect(mockUpdateState).toHaveBeenCalledWith(
                expect.objectContaining({ status: "running" }),
            );
        });
    });

    describe("startup resumes analyzer infrastructure", () => {
        it("should clear the stale analyzer gate on worker start", async () => {
            mockClearGate.mockClear();
            await startUnifiedEnrichmentWorker();
            expect(mockClearGate).toHaveBeenCalled();
        });

        it("should publish resume to the audio analyzer on worker start", async () => {
            mockPublishToChannel.mockClear();
            await startUnifiedEnrichmentWorker();
            expect(mockPublishToChannel).toHaveBeenCalledWith(
                "audio:analysis:control",
                "resume",
            );
        });
    });

    describe("reverse-sync must resume infrastructure, not just flip the local flag", () => {
        it("should call clearGate when reverse-syncing a stale pause to running", async () => {
            // The wedge is a missed "resume" control message: state says
            // "paused" (the pause landed), then state says "running" (the
            // resume was lost), then the next timer tick must self-heal the
            // infrastructure, not just the flag.
            await startUnifiedEnrichmentWorker();

            // State says paused -> local isPaused becomes true via the sync block
            simulatePauseViaStateService();
            await jest.advanceTimersByTimeAsync(10_000);

            // Now state says running -- the resume pub/sub was lost
            mockGetState.mockResolvedValue({ status: "running" });
            mockClearGate.mockClear();
            mockPublishToChannel.mockClear();

            // Advance to the next scheduled cycle (timer path). The cycle's database work runs in real time.
            await jest.advanceTimersByTimeAsync(60_000);
            await until(() => mockClearGate.mock.calls.length > 0);
            // The cycle has finished when it has armed the next one.
            await until(() => jest.getTimerCount() > 0);

            // The reverse-sync must have resumed the real infrastructure,
            // NOT merely flipped the local flag.
            expect(mockClearGate).toHaveBeenCalled();
            expect(mockPublishToChannel).toHaveBeenCalledWith(
                "audio:analysis:control",
                "resume",
            );
        });
    });

    describe("per-track stage queue", () => {
        it("does not drain a past-cap track to permanently_failed", async () => {
            // Selection comes from the stage record, so tracks are never
            // selected by analysisRetryCount to have their status rewritten.
            await seedTrack("stuck", { analysisRetryCount: 5, analysisStatus: "failed" });

            await expect(executeAudioPhase()).resolves.toBe(1);

            expect((await prisma.track.findUnique({ where: { id: id("stuck") } }))?.analysisStatus).not.toBe("permanently_failed");
            expect(await stageStatus("stuck", "analysis")).toBe("working");
        });

        it("feeds the analysis queue from the stage record, not from analysisStatus", async () => {
            // The column says done but no record answers it: the question is owed. The other song's
            // column says pending but its record is answered: it is not.
            await seedTrack("t1", { analysisStatus: "completed" });
            await seedTrack("t2", { analysisStatus: "pending" });
            await putStage(id("t2"), "analysis", "done");

            const queued = await executeAudioPhase();

            expect(queued).toBe(1);
            expect(mockRedisRpush).toHaveBeenCalledTimes(1);
            expect(mockRedisRpush).toHaveBeenCalledWith(
                "audio:analysis:queue",
                expect.stringContaining(`"trackId":"${id("t1")}"`),
            );
        });

        it("does not re-queue a track whose recording stage is already answered", async () => {
            // Both songs' fingerprints are settled; only one song's recording is still owed.
            await seedTrack("t1");
            await seedTrack("t2");
            await putStage(id("t1"), "fingerprint", "done", { source: "fpcalc" });
            await putStage(id("t2"), "fingerprint", "done", { source: "fpcalc" });
            await putStage(id("t2"), "recording", "done", { source: "musicbrainz" });

            const queued = await executeIdentificationPhase();

            expect(queued).toBe(1);
            expect(mockQueueAdd).toHaveBeenCalledTimes(1);
            expect(mockQueueAdd).toHaveBeenCalledWith(
                "enrich",
                expect.objectContaining({ trackId: id("t1") }),
                expect.objectContaining({ jobId: `track-${id("t1")}-recording-1-r0` }),
            );
        });

        it("with no analyzer running, embeds a ready track while another track's analysis is still owed", async () => {
            // Only the ready track's embedding record is due; the other is gated by its own unfinished analysis.
            // A running analyzer holds every vector until analysis is done (unifiedEnrichment.oneHeavyModel.test.ts).
            await seedTrack("ready");
            await seedTrack("owing");
            await putStage(id("ready"), "analysis", "done");

            await expect(executeVibePhase()).resolves.toBe(1);
            expect(mockQueueAdd).toHaveBeenCalledTimes(1);
            expect(mockQueueAdd).toHaveBeenCalledWith(
                "embed",
                expect.objectContaining({ trackId: id("ready") }),
                expect.objectContaining({ jobId: `track-${id("ready")}-embedding-1-r0` }),
            );
        });

        it("offers nothing for a track whose records are all answered, whatever its status columns say", async () => {
            await seedTrack("answered", { analysisStatus: "pending", vibeAnalysisStatus: "pending" });
            for (const stage of ["fingerprint", "recording", "analysis", "embedding"]) {
                await putStage(id("answered"), stage, "done");
            }

            await expect(executeAudioPhase()).resolves.toBe(0);
            await expect(executeVibePhase()).resolves.toBe(0);
            await expect(executeIdentificationPhase()).resolves.toBe(0);

            expect(mockRedisRpush).not.toHaveBeenCalled();
            expect(mockQueueAdd).not.toHaveBeenCalled();
        });
    });

    describe("the mood step in the cycle", () => {
        // The step's own work is tried in workers/enrichment/__tests__/moods.test.ts; here only where the cycle puts it.
        it("runs after the vibe sweep and before the similarity step", async () => {
            await startUnifiedEnrichmentWorker();
            mockUpdateState.mockClear();

            await triggerEnrichmentNow();

            const phases = mockUpdateState.mock.calls
                .map(([update]) => (update as { currentPhase?: string | null }).currentPhase)
                .filter(Boolean);
            expect(phases.slice(phases.indexOf("vibe"))).toEqual(["vibe", "mood", "similarity"]);
            expect(mockBuildMoods).toHaveBeenCalledTimes(1);
        });

        it("logs a failure and goes on to the similarity step, writing no tags", async () => {
            const refused = new Error("[Moods] arousal_mean has no value over 3 eligible tracks");
            mockBuildMoods.mockRejectedValue(refused);
            await startUnifiedEnrichmentWorker();
            mockUpdateState.mockClear();

            await triggerEnrichmentNow();

            const phases = mockUpdateState.mock.calls
                .map(([update]) => (update as { currentPhase?: string | null }).currentPhase)
                .filter(Boolean);
            expect(phases.slice(phases.indexOf("vibe"))).toEqual(["vibe", "mood", "similarity"]);
            expect(logger.error).toHaveBeenCalledWith(
                "[Enrichment] Mood step failed; the cycle goes on without it:",
                refused,
            );
            expect(logger.error).not.toHaveBeenCalledWith("[Enrichment] Cycle error:", refused);
            expect(mockWriteMoodTags).not.toHaveBeenCalled();
        });
    });

    describe("progress readout reflects the stage records", () => {
        it("computes progress from the TrackStage records, not the columns", async () => {
            // The record owns the answer: each stage's counts come from
            // TrackStage, and no stage checks track_embeddings to decide
            // whether an answer exists. Every column says pending except one that says done with no record.
            await seedTrack("a");
            await seedTrack("b");
            await seedTrack("c", { analysisStatus: "completed" });
            await putStage(id("a"), "recording", "done");
            await putStage(id("b"), "recording", "done");
            await putStage(id("a"), "analysis", "done");
            await putStage(id("b"), "analysis", "failed", { retryable: true });
            await putStage(id("a"), "embedding", "done");

            // The progress readout is memoized for PROGRESS_MEMO_MS so the
            // settings UI's polling does not re-scan Track every call; drop it
            // so this test reads its own rows rather than a cached value.
            invalidateEnrichmentProgress();

            const progress = await getEnrichmentProgress();

            expect(progress.audioAnalysis).toEqual(expect.objectContaining({ total: 3, completed: 1, failed: 1, pending: 1 }));
            expect(progress.clapEmbeddings).toEqual(expect.objectContaining({ total: 3, completed: 1, pending: 2 }));
            expect(progress.trackTags).toEqual(expect.objectContaining({ total: 3, enriched: 2 }));
            expect(progress.coreComplete).toBe(false);
        });
    });
});
