/**
 * The enrichment cycle's controls (stop, pause, resume, re-run), stop
 * persistence and state sync, plus the per-track stage queue. Prisma, Redis,
 * BullMQ and services are mocked; the control flow in unifiedEnrichment.ts is real.
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

jest.mock("../artistEnrichmentWorker", () => ({
    startArtistEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../trackEnrichmentWorker", () => ({
    startTrackEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../podcastEnrichmentWorker", () => ({
    startPodcastEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../audioCompletionSubscriber", () => ({
    startAudioCompletionSubscriber: jest.fn(),
    stopAudioCompletionSubscriber: jest.fn().mockResolvedValue(undefined),
    haltVibeQueuing: jest.fn(),
    resumeVibeQueuing: jest.fn(),
}));

// Mock Prisma with defaults that make the cycle do minimal work
const mockPrismaArtistFindMany = jest.fn().mockResolvedValue([]);
const mockPrismaArtistUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const mockPrismaTrackFindMany = jest.fn().mockResolvedValue([]);
const mockPrismaTrackUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const mockPrismaTrackCount = jest.fn().mockResolvedValue(0);
const mockQueryRaw = jest.fn();

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

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findMany: mockPrismaArtistFindMany,
            updateMany: mockPrismaArtistUpdateMany,
            count: jest.fn().mockResolvedValue(0),
            groupBy: jest.fn().mockResolvedValue([]),
        },
        track: {
            findMany: mockPrismaTrackFindMany,
            updateMany: mockPrismaTrackUpdateMany,
            count: mockPrismaTrackCount,
            groupBy: jest.fn().mockResolvedValue([]),
        },
        trackStage: {
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
            count: jest.fn().mockResolvedValue(0),
        },
        sourceAttempt: {
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        podcast: {
            findMany: jest.fn().mockResolvedValue([]),
            count: jest.fn().mockResolvedValue(0),
        },
        enrichmentFailure: {
            findMany: jest.fn().mockResolvedValue([]),
        },
        notification: {
            findMany: jest.fn().mockResolvedValue([]),
        },
        $queryRaw: mockQueryRaw,
        $queryRawUnsafe: mockQueryRaw,
        $executeRaw: jest.fn().mockResolvedValue(0),
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    },
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
    executeAudioPhase,
    executeVibePhase,
    executeMoodPhase,
    executeIdentificationPhase,
    getEnrichmentProgress,
    invalidateEnrichmentProgress,
} from "../unifiedEnrichment";
import { logger } from "../../utils/logger";

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

/** One owed stage row, shaped like the TrackStage query result. */
function stageRows(rows: Array<{ trackId: string; stage: string; attempt?: number }>) {
    return rows.map((r) => ({
        trackId: r.trackId,
        stage: r.stage,
        status: "pending",
        attempt: r.attempt ?? 0,
        source: "analyzer",
        filePath: `/music/${r.trackId}.flac`,
        duration: 200,
        title: r.trackId,
    }));
}

/** The claim succeeds; only `stage` is owed, by `trackIds`. */
function claimOneStage(stage: string, trackIds: string[]) {
    mockQueryRaw.mockImplementation(async (...args: unknown[]) => {
        const sql = String(args[0]);
        if (sql.includes("SET status = 'working'")) return [{ attempt: 1, redelivered: 0 }];
        if (args[1] === stage) return stageRows(trackIds.map((trackId) => ({ trackId, stage })));
        return [];
    });
}

/** One stage's progress counts, as BigInt the way the SQL returns them. */
function progressRow(completed: bigint, retryableFailed = 0n) {
    return [{ total: 10n, completed, working: 0n, retryable_failed: retryableFailed, terminal_failed: 0n }];
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Enrichment State Machine", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        // Default: state service returns idle
        mockGetState.mockResolvedValue({ status: "idle" });
        mockBuildMoods.mockResolvedValue({ scored: 0, stateChanged: false });
        mockWriteMoodTags.mockResolvedValue(0);
        mockRedisScan.mockResolvedValue(["0", []]);
        // Default: one track owes each stage, so a phase that consults the
        // stage records finds work unless a test restapes this.
        // getNextWork passes the stage as a bind parameter, so the stage under
        // query arrives as the argument after the SQL, not inside the text.
        mockQueryRaw.mockImplementation(async (...args: unknown[]) => {
            const sql = String(args[0]);
            const stage = args[1] as string | undefined;
            if (sql.includes('"TrackStage"') && stage) {
                return stageRows([{ trackId: "t1", stage }]);
            }
            return [];
        });
    });

    afterEach(() => {
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

            // Advance to the next scheduled cycle (timer path)
            await jest.advanceTimersByTimeAsync(60_000);

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
            mockPrismaTrackFindMany.mockResolvedValue([
                { id: "stuck", title: "Stuck", filePath: "/m/stuck.flac", analysisRetryCount: 5 },
            ]);

            await executeAudioPhase();

            const purgatorySelects = mockPrismaTrackFindMany.mock.calls.filter(
                (call) => JSON.stringify(call[0] ?? {}).includes("analysisRetryCount"),
            );
            expect(purgatorySelects).toHaveLength(0);

            const condemned = mockPrismaTrackUpdateMany.mock.calls.filter(
                (call) => JSON.stringify(call[0] ?? {}).includes("permanently_failed"),
            );
            expect(condemned).toHaveLength(0);
        });

        it("feeds the analysis queue from the stage record, not from analysisStatus", async () => {
            // One track owes analysis; it must be pushed even though no
            // `analysisStatus: "pending"` select drove the choice.
            claimOneStage("analysis", ["t1"]);

            const queued = await executeAudioPhase();

            expect(queued).toBe(1);
            expect(mockRedisRpush).toHaveBeenCalledWith(
                "audio:analysis:queue",
                expect.stringContaining('"trackId":"t1"'),
            );
        });

        it("does not re-queue a track whose recording stage is already answered", async () => {
            // Only the recording stage is owed, and only for one track.
            claimOneStage("recording", ["t1"]);

            const queued = await executeIdentificationPhase();

            expect(queued).toBe(1);
            expect(mockQueueAdd).toHaveBeenCalledWith(
                "enrich",
                expect.objectContaining({ trackId: "t1" }),
                expect.objectContaining({ jobId: "track-t1-recording-1-r0" }),
            );
        });

        it("with no analyzer running, embeds a ready track while another track's analysis is still owed", async () => {
            // Only the ready track's embedding record is due; the other is gated by its own unfinished analysis.
            // A running analyzer holds every vector until analysis is done (unifiedEnrichment.oneHeavyModel.test.ts).
            claimOneStage("embedding", ["ready"]);
            // A track still sits at analysisStatus 'pending'; that must not
            // hold back the embedding phase.
            mockPrismaTrackCount.mockResolvedValue(1);

            await expect(executeVibePhase()).resolves.toBe(1);
            expect(mockQueueAdd).toHaveBeenCalledWith(
                "embed",
                expect.objectContaining({ trackId: "ready" }),
                expect.objectContaining({ jobId: "track-ready-embedding-1-r0" }),
            );
        });

        it("does not select work by scanning Track status columns", async () => {
            await executeVibePhase();
            await executeIdentificationPhase();

            // Gating reads TrackStage; no phase may decide work from
            // analysisStatus across the whole library.
            const statusScans = mockPrismaTrackFindMany.mock.calls.filter((call) => {
                const where = JSON.stringify(call[0] ?? {});
                return where.includes("analysisStatus");
            });
            expect(statusScans).toHaveLength(0);
        });
    });

    describe("the mood step", () => {
        // The mood step reads the progress counts to see whether the moods' inputs have settled: with no tracks owing
        // anything they have.
        beforeEach(() => {
            mockQueryRaw.mockImplementation(async () => [{ total: 0, completed: 0 }]);
            invalidateEnrichmentProgress();
            // A small in-memory Redis for the notes the step writes; a fresh one for every test.
            const notes = new Map<string, string>();
            mockRedisSet.mockImplementation(async (k: string, v: string) => (notes.set(k, v), "OK"));
            mockRedisGet.mockImplementation(async (k: string) => notes.get(k) ?? null);
            mockRedisDel.mockImplementation(async (...ks: string[]) => ks.filter((k) => notes.delete(k)).length);
        });

        afterEach(() => {
            mockRedisSet.mockReset().mockResolvedValue("OK");
            mockRedisGet.mockReset().mockResolvedValue(null);
            mockRedisDel.mockReset().mockResolvedValue(1);
        });

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

        it.each([
            ["new scores", { scored: 3, stateChanged: true }],
            ["new statistics alone", { scored: 0, stateChanged: true }],
        ])("drops every cached mix after %s", async (_what, result) => {
            mockBuildMoods.mockResolvedValue(result);
            mockRedisScan
                .mockResolvedValueOnce(["7", ["mixes:u1"]])
                .mockResolvedValueOnce(["0", ["mixes:u2"]]);

            expect(await executeMoodPhase()).toBe(result.scored);

            expect(mockRedisScan).toHaveBeenCalledWith("0", "MATCH", "mixes:*", "COUNT", 100);
            expect(mockRedisDel).toHaveBeenCalledWith("mixes:u1", "mixes:u2");
        });

        it("keeps the cached mixes when nothing changed", async () => {
            expect(await executeMoodPhase()).toBe(0);
            expect(mockRedisScan).not.toHaveBeenCalled();
            expect(mockRedisDel).not.toHaveBeenCalled();
        });

        it("scores nothing and writes no tags while analysis or sound vectors are still being made", async () => {
            // Every track still owes its stage: the moods' inputs have not settled.
            mockQueryRaw.mockImplementation(async (...args: unknown[]) =>
                String(args[0]).includes('LEFT JOIN "TrackStage"')
                    ? [{ total: 10n, completed: 0n, working: 0n, retryable_failed: 0n, terminal_failed: 0n, file_missing: 0n }]
                    : [{ total: 0, completed: 0 }],
            );
            invalidateEnrichmentProgress();
            expect(await executeMoodPhase()).toBe(0);
            expect(mockBuildMoods).not.toHaveBeenCalled();
            expect(mockWriteMoodTags).not.toHaveBeenCalled();
            expect(mockRedisScan).not.toHaveBeenCalled();
        });

        it("writes down a drop it cannot make, and makes it after a restart", async () => {
            const OWED = "enrichment:mood-mixes-owed";
            mockBuildMoods.mockResolvedValue({ scored: 3, stateChanged: true });
            mockRedisScan.mockRejectedValueOnce(new Error("redis busy"));
            await executeMoodPhase();
            expect(mockRedisSet).toHaveBeenCalledWith(OWED, "1");
            expect(mockRedisDel).not.toHaveBeenCalledWith(OWED);

            // The server restarts: nothing is held in memory, only the note in Redis is left.
            mockRedisGet.mockImplementation(async (key: string) => (key === OWED ? "1" : null));
            mockQueryRaw.mockImplementation(async () => [{ total: 0, completed: 0 }]);
            invalidateEnrichmentProgress();
            mockBuildMoods.mockResolvedValue({ scored: 0, stateChanged: false });
            mockRedisScan.mockResolvedValueOnce(["0", ["mixes:u1"]]);
            await executeMoodPhase();
            expect(mockRedisDel).toHaveBeenCalledWith("mixes:u1");
            expect(mockRedisDel).toHaveBeenCalledWith(OWED);
        });

        it("still writes the mood tags when Redis fails, and logs that the drop is owed", async () => {
            mockBuildMoods.mockResolvedValue({ scored: 2, stateChanged: true });
            mockRedisSet.mockRejectedValue(new Error("redis down"));
            mockWriteMoodTags.mockResolvedValue(1);
            expect(await executeMoodPhase()).toBe(2);
            expect(mockWriteMoodTags).toHaveBeenCalledTimes(1);
            expect(logger.error).toHaveBeenCalledWith(
                expect.stringContaining("the drop is still owed"),
                expect.objectContaining({ message: "redis down" }),
            );

            // Redis is back on a cycle that changed nothing: the note that could not be written is written now.
            mockRedisSet.mockReset();
            mockRedisSet.mockResolvedValue("OK");
            mockBuildMoods.mockResolvedValue({ scored: 0, stateChanged: false });
            await executeMoodPhase();
            expect(mockRedisSet).toHaveBeenCalledWith("enrichment:mood-mixes-owed", "1");
        });

        it("drops only the cached mix lists, not the familiarity results, scan locks or the energy band", async () => {
            invalidateEnrichmentProgress();
            mockBuildMoods.mockResolvedValue({ scored: 1, stateChanged: false });
            mockRedisScan.mockResolvedValueOnce([
                "0",
                ["mixes:u1", "mixes:familiar:u1", "mixes:familiar-lock:u1", "mixes:energy-band", "mixes:u2"],
            ]);
            await executeMoodPhase();
            expect(mockRedisDel).toHaveBeenCalledWith("mixes:u1", "mixes:u2");
        });

        it("rewrites the mood tags on every pass, after the scores and statistics", async () => {
            mockWriteMoodTags.mockResolvedValue(4);
            expect(await executeMoodPhase()).toBe(0);
            expect(mockWriteMoodTags).toHaveBeenCalledTimes(1);
            expect(mockBuildMoods.mock.invocationCallOrder[0]).toBeLessThan(
                mockWriteMoodTags.mock.invocationCallOrder[0],
            );
            // No mix reads the tags, so changed tags alone keep the cached mixes.
            expect(mockRedisScan).not.toHaveBeenCalled();
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

        it("logs a failure to write the tags and returns", async () => {
            mockWriteMoodTags.mockRejectedValue(new Error("connection lost"));
            expect(await executeMoodPhase()).toBe(0);
            expect(logger.error).toHaveBeenCalledWith(
                "[Enrichment] Mood step failed; the cycle goes on without it:",
                expect.objectContaining({ message: "connection lost" }),
            );
        });
    });

    describe("progress readout reflects the stage records", () => {
        it("computes progress from the TrackStage records, not the columns", async () => {
            // The record owns the answer: each stage's counts come from
            // TrackStage, and no stage checks track_embeddings to decide
            // whether an answer exists.
            mockQueryRaw.mockImplementation(async (...args: unknown[]) => {
                const sql = String(args[0]); const stage = args[1];
                if (sql.includes("FROM \"Track\"") && sql.includes("count(*) FILTER")) {
                    if (stage === "recording") return progressRow(5n);
                    if (stage === "analysis") return progressRow(8n);
                    return progressRow(6n, 2n);
                }
                return [{ count: 8n }];
            });

            // The progress readout is memoized for PROGRESS_MEMO_MS so the
            // settings UI's polling does not re-scan Track every call; drop it
            // so this test reads its own shaped rows rather than a cached value.
            invalidateEnrichmentProgress();

            const progress = await getEnrichmentProgress();

            expect(progress.audioAnalysis.completed).toBe(8);
            expect(progress.clapEmbeddings.completed).toBe(6);
            expect(progress.coreComplete).toBe(false);
        });
    });
});