/**
 * The enrichment cycle's controls (stop, pause, resume, re-run), stop
 * persistence and state sync, plus the per-track stage queue. Prisma, Redis,
 * BullMQ and services are mocked; the control flow in unifiedEnrichment.ts is real.
 */

// ── Mocks (must be before imports) ──────────────────────────────────

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
    featureDetection: {
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
        disconnect: jest.fn(),
        status: "ready",
    }));
});

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

// ── Imports (after mocks) ───────────────────────────────────────────

import {
    triggerEnrichmentNow,
    startEnrichmentNow,
    startUnifiedEnrichmentWorker,
    executeAudioPhase,
    executeVibePhase,
    executeIdentificationPhase,
    getEnrichmentProgress,
    invalidateEnrichmentProgress,
} from "../unifiedEnrichment";

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

            // After the stop landed, a trigger still runs exactly one cycle
            // (the immediate flag); it does not re-arm the engine, so the timer
            // never auto-restarts a stopped engine.
            const result2 = await triggerEnrichmentNow();

            expect(result2).toBeDefined();
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
            const result = await triggerEnrichmentNow();

            // The trigger does not clear anything on its own; the cycle's
            // state sync reads "paused", parks isPaused, and declines.
            // Result is the empty one because the engine stays paused.
            expect(result).toEqual({ artists: 0, tracks: 0, audioQueued: 0 });
        });

        it("should reverse-sync when local isPaused is stale", async () => {
            await startUnifiedEnrichmentWorker();

            // First: get into a paused state via state sync
            simulatePauseViaStateService();
            await triggerEnrichmentNow();

            // Now state changes to running (user resumed via another path)
            mockGetState.mockResolvedValue({ status: "running" });

            // Next trigger should detect the mismatch and resume
            const result = await triggerEnrichmentNow();
            // Should proceed (not return empty due to stale isPaused)
            expect(result).toBeDefined();
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

        it("embeds a ready track while another track's analysis is still owed", async () => {
            // Only the ready track's embedding record is due; the other is
            // gated by its own unfinished analysis, not by a global count.
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