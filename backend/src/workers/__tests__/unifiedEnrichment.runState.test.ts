/**
 * The scheduler's run state, seen from outside: a stop that lands while a cycle runs stays a stop, and a restart
 * after it runs again. Redis, queues and prisma are stood in; the scheduler and its run state are real.
 */

jest.mock("../scanActivity", () => ({ libraryScanRunning: jest.fn().mockResolvedValue(false) }));
jest.mock("../enrichmentQueues", () => {
    // The shared queue stand-in has no job counts; the artists phase asks for them.
    const queues = require("../../__tests__/helpers/enrichmentMocks").enrichmentQueuesMock;
    for (const q of [queues.artistQueue, queues.trackQueue, queues.vibeQueue, queues.podcastQueue]) {
        q.getJobCounts = jest.fn().mockResolvedValue({ active: 0, waiting: 0, completed: 0, failed: 0 });
    }
    return queues;
});
jest.mock("ioredis", () => require("../../__tests__/helpers/enrichmentMocks").ioredisMock);
jest.mock("../../config", () => require("../../__tests__/helpers/enrichmentMocks").configMock);
jest.mock("../../utils/logger", () => require("../../__tests__/helpers/enrichmentMocks").loggerMock);
jest.mock("../../services/enrichmentState", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentStateMock);
jest.mock("../../services/enrichmentFailureService", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentFailureServiceMock);
jest.mock("../../services/featureDetection", () => require("../../__tests__/helpers/enrichmentMocks").featureDetectionMock);
jest.mock("../../services/acoustidIdentification", () => ({
    ...jest.requireActual("../../services/acoustidIdentification"),
    prefetchAcoustidReplies: jest.fn().mockResolvedValue(0),
}));
jest.mock("../../services/albumIdentification", () => ({
    ...jest.requireActual("../../services/albumIdentification"),
    identifyAlbumsBySound: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../services/sourcePauseController", () => require("../../__tests__/helpers/enrichmentMocks").sourcePauseControllerMock);
jest.mock("../audioCompletionSubscriber", () => require("../../__tests__/helpers/enrichmentMocks").audioCompletionSubscriberMock);
jest.mock("../artistEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").artistEnrichmentWorkerMock);
jest.mock("../trackEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").trackEnrichmentWorkerMock);
jest.mock("../podcastEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").podcastEnrichmentWorkerMock);
jest.mock("../../services/moods/state", () => ({
    buildMoods: jest.fn().mockResolvedValue({ scored: 0, stateChanged: false }),
    moodProgress: jest.fn().mockResolvedValue({ total: 0, completed: 0 }),
}));
jest.mock("../../services/moods/tags", () => ({ writeMoodTags: jest.fn().mockResolvedValue(0) }));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ audioAnalyzerWorkers: 2, clapWorkers: 2 }),
}));

const mockQueryRaw = jest.fn().mockResolvedValue([]);
const mockExecuteRaw = jest.fn().mockResolvedValue(1);
const mockTransaction = jest.fn(async (run: (tx: unknown) => Promise<unknown>) =>
    run({ $queryRawUnsafe: mockQueryRaw, $executeRawUnsafe: mockExecuteRaw }));

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findMany: jest.fn().mockResolvedValue([]),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            count: jest.fn().mockResolvedValue(0),
            groupBy: jest.fn().mockResolvedValue([]),
        },
        track: {
            findMany: jest.fn().mockResolvedValue([]),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            count: jest.fn().mockResolvedValue(0),
            groupBy: jest.fn().mockResolvedValue([]),
        },
        trackStage: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), count: jest.fn().mockResolvedValue(0) },
        sourceAttempt: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        podcast: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
        enrichmentFailure: { findMany: jest.fn().mockResolvedValue([]) },
        notification: { findMany: jest.fn().mockResolvedValue([]) },
        $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
        $queryRawUnsafe: (...a: unknown[]) => mockQueryRaw(...a),
        $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a),
        $executeRawUnsafe: (...a: unknown[]) => mockExecuteRaw(...a),
        $transaction: (run: (tx: unknown) => Promise<unknown>) => mockTransaction(run),
    },
}));

import { mockRedis, enrichmentStateMock } from "../../__tests__/helpers/enrichmentMocks";
import {
    triggerEnrichmentNow,
    startEnrichmentNow,
    startUnifiedEnrichmentWorker,
    stopUnifiedEnrichmentWorker,
} from "../unifiedEnrichment";

const state = enrichmentStateMock.enrichmentStateService;

/** What another process publishes on the enrichment control channel. */
function control(message: "pause" | "resume" | "stop") {
    const handler = mockRedis.on.mock.calls.find(([event]) => event === "message")?.[1] as
        | ((channel: string, message: string) => void)
        | undefined;
    if (!handler) throw new Error("the control channel is not subscribed");
    handler("enrichment:control", message);
}

function cyclesRun(): number {
    return state.detectHang.mock.calls.length;
}

beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    state.getState.mockResolvedValue({ status: "idle" });
    mockQueryRaw.mockResolvedValue([]);
    await startUnifiedEnrichmentWorker();
    state.detectHang.mockClear();
});

afterEach(async () => {
    await stopUnifiedEnrichmentWorker();
    jest.useRealTimers();
});

describe("a stop during a run", () => {
    it("holds against the next timer tick", async () => {
        // The stop lands once the cycle is inside its first phase.
        let delivered = false;
        state.updateState.mockImplementation(async (update: { currentPhase?: string | null }) => {
            if (!delivered && update.currentPhase === "artists") {
                delivered = true;
                control("stop");
            }
            return {};
        });

        await triggerEnrichmentNow();
        expect(delivered).toBe(true);
        expect(state.updateState).toHaveBeenCalledWith(expect.objectContaining({ status: "idle" }));
        expect(cyclesRun()).toBe(1);

        // Ten minutes of timer ticks, with no operator action: nothing runs.
        state.updateState.mockImplementation(async () => ({}));
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(cyclesRun()).toBe(1);
    });

    it("a restart after it runs again", async () => {
        let delivered = false;
        state.updateState.mockImplementation(async (update: { currentPhase?: string | null }) => {
            if (!delivered && update.currentPhase === "artists") {
                delivered = true;
                control("stop");
            }
            return {};
        });
        await triggerEnrichmentNow();
        state.updateState.mockImplementation(async () => ({}));
        await jest.advanceTimersByTimeAsync(60_000);
        const before = cyclesRun();

        await startEnrichmentNow();
        expect(cyclesRun()).toBe(before + 1);

        // The restart holds: the stop is lifted, so the timer carries on.
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(cyclesRun()).toBeGreaterThan(before + 1);
    });
});

describe("a stop between cycles", () => {
    it("is settled by the next look and moves no stage record", async () => {
        mockQueryRaw.mockClear();
        mockExecuteRaw.mockClear();
        mockTransaction.mockClear();

        control("stop");
        await triggerEnrichmentNow();

        expect(state.updateState).toHaveBeenCalledWith({ status: "idle", currentPhase: null });
        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockExecuteRaw).not.toHaveBeenCalled();
        expect(mockTransaction).not.toHaveBeenCalled();

        // And it holds against the timer.
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(cyclesRun()).toBe(0);
    });
});

describe("a pause", () => {
    it("holds until a resume, then the timer carries on", async () => {
        control("pause");
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(cyclesRun()).toBe(0);

        control("resume");
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(cyclesRun()).toBeGreaterThan(0);
    });
});
