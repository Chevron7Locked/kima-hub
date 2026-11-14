/**
 * The scheduler's run state, seen from outside: a stop that lands while a cycle runs stays a stop, a restart
 * after it runs again, and stopping the worker waits for the cycle in flight. Real test database. Redis, queues
 * and the network-facing services are stood in; the scheduler and its run state are real.
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
jest.mock("../enrichment/artists", () => require("../../__tests__/helpers/enrichmentMocks").artistJobMock);
jest.mock("../trackEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").trackEnrichmentWorkerMock);
jest.mock("../enrichment/podcasts", () => require("../../__tests__/helpers/enrichmentMocks").podcastJobMock);
jest.mock("../../services/moods/state", () => ({
    buildMoods: jest.fn().mockResolvedValue({ scored: 0, stateChanged: false }),
    moodProgress: jest.fn().mockResolvedValue({ total: 0, completed: 0 }),
}));
jest.mock("../../services/moods/tags", () => ({ writeMoodTags: jest.fn().mockResolvedValue(0) }));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ audioAnalyzerWorkers: 2, clapWorkers: 2 }),
}));

import { setTimeout as realSleep } from "timers/promises";
import { mockRedis, enrichmentStateMock, artistJobMock } from "../../__tests__/helpers/enrichmentMocks";
import { prisma } from "../../utils/db";
import { putStage, deleteSeededRows, seedArtistAndAlbum } from "../../__tests__/helpers/trackStage";
import {
    triggerEnrichmentNow,
    startEnrichmentNow,
    startUnifiedEnrichmentWorker,
    stopUnifiedEnrichmentWorker,
} from "../unifiedEnrichment";

const state = enrichmentStateMock.enrichmentStateService;
const queueOwedArtists = artistJobMock.queueOwedArtists;

const P = "zz-run";
const wipe = () => deleteSeededRows(P);

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

/** Wait, in real time, for something a cycle does in the background: its database reads are not on the fake clock. */
async function until(done: () => boolean) {
    for (let i = 0; i < 300 && !done(); i++) await realSleep(10);
    expect(done()).toBe(true);
}

beforeAll(wipe);
afterAll(wipe);

beforeEach(async () => {
    await wipe();
    jest.clearAllMocks();
    // Only the clock timers are faked: the database's own I/O needs the real next-tick and immediate queues.
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "clearImmediate", "queueMicrotask"] });
    state.getState.mockResolvedValue({ status: "idle" });
    mockRedis.set.mockResolvedValue("OK");
    await startUnifiedEnrichmentWorker();
    // Starting runs a first cycle; what it did is not what the test is about.
    state.detectHang.mockClear();
    queueOwedArtists.mockClear();
});

afterEach(async () => {
    // Stopping waits for any cycle still in flight, so the next test's wipe never races one.
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
        // A song that owes its recording: a cycle that ran would claim it.
        await seedArtistAndAlbum(P, "Run");
        await prisma.track.create({
            data: {
                id: `${P}_t1`, albumId: `${P}_alb`, title: "t1", trackNo: 1, duration: 200,
                filePath: `/music/${P}/t1.flac`, fileModified: new Date(), fileSize: 1000,
            },
        });
        await putStage(`${P}_t1`, "recording", "pending");
        const stages = () => prisma.trackStage.findMany({ where: { trackId: `${P}_t1` }, orderBy: { stage: "asc" } });
        const before = await stages();
        expect(before).toHaveLength(1);

        control("stop");
        await triggerEnrichmentNow();

        expect(state.updateState).toHaveBeenCalledWith({ status: "idle", currentPhase: null });
        expect(await stages()).toEqual(before);

        // And it holds against the timer.
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(cyclesRun()).toBe(0);
        expect(await stages()).toEqual(before);
    });
});

describe("a start that lands while a stop is being settled", () => {
    it("is not undone by the settling", async () => {
        control("stop");

        // The operator's start arrives while the scheduler is writing the idle state for the stop.
        let restarted = false;
        state.updateState.mockImplementation(async (update: { status?: string; currentPhase?: string | null }) => {
            if (!restarted && update.status === "idle") {
                restarted = true;
                await startEnrichmentNow();
            }
            return {};
        });
        await triggerEnrichmentNow();
        expect(restarted).toBe(true);
        const afterRestart = cyclesRun();
        expect(afterRestart).toBeGreaterThan(0);

        // The restart holds: the timer carries on.
        state.updateState.mockImplementation(async () => ({}));
        await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
        expect(cyclesRun()).toBeGreaterThan(afterRestart);
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

describe("stopping the worker", () => {
    it("waits for the cycle in flight, and the cycle ends at its next phase", async () => {
        let release!: (queued: number) => void;
        queueOwedArtists.mockImplementationOnce(() => new Promise<number>((resolve) => { release = resolve; }));
        const order: string[] = [];
        const cycle = triggerEnrichmentNow().then(() => { order.push("cycle ended"); });
        try {
            await until(() => queueOwedArtists.mock.calls.length === 1);
            state.updateState.mockClear();

            const stopped = stopUnifiedEnrichmentWorker().then(() => { order.push("stop returned"); });
            await realSleep(100);
            expect(order).toEqual([]);

            release(0);
            await Promise.all([cycle, stopped]);

            expect(order).toEqual(["cycle ended", "stop returned"]);
            // The stop was seen at the phase boundary: no later phase started.
            expect(state.updateState).not.toHaveBeenCalledWith(expect.objectContaining({ currentPhase: "tracks" }));
        } finally {
            release?.(0);
        }
    });

    it("returns at once when no cycle is running", async () => {
        await expect(stopUnifiedEnrichmentWorker()).resolves.toBeUndefined();
    });
});

describe("a stop that lands while a cycle waits for the lock", () => {
    it("is not followed by the cycle: it starts no phase", async () => {
        let grant!: (reply: string) => void;
        mockRedis.set.mockImplementation((key: string) =>
            key.startsWith("lock:") ? new Promise<string>((resolve) => { grant = resolve; }) : Promise.resolve("OK"));
        const cycle = triggerEnrichmentNow();
        try {
            await until(() => typeof grant === "function");
            // Nothing is in flight yet, so the stop returns at once and closes the worker.
            await stopUnifiedEnrichmentWorker();
        } finally {
            grant?.("OK");
        }

        expect(await cycle).toEqual(expect.objectContaining({ declined: "stopped" }));
        expect(queueOwedArtists).not.toHaveBeenCalled();
    });
});

describe("a cycle that loses the lock", () => {
    it("leaves the wake request for the cycle that holds it", async () => {
        // The lock is held by another process.
        mockRedis.set.mockImplementation(async (key: string) => (key.startsWith("lock:") ? null : "OK"));

        const lost = await triggerEnrichmentNow();
        expect(lost).toEqual(expect.objectContaining({ declined: "already-running" }));
        expect(queueOwedArtists).not.toHaveBeenCalled();

        // The other process lets go. The trigger's request is still owed: the next tick runs past the minimum
        // interval instead of declining as too soon.
        mockRedis.set.mockResolvedValue("OK");
        await jest.advanceTimersByTimeAsync(5000);
        await until(() => queueOwedArtists.mock.calls.length === 1);
    });
});
