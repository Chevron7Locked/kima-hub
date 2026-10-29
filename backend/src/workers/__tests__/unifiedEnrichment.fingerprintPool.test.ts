/**
 * The fingerprint stage runs its own pool, sized by os.availableParallelism().
 * Dispatch returns while fpcalc runs, and a hung fpcalc is cut off by the
 * stage's own timeout and recorded as a retryable failure.
 */

const mockQueueAdd = jest.fn().mockResolvedValue({ id: "job-1" });

jest.mock("../../workers/enrichmentQueues", () => ({
    QUEUE_NAMES: {
        ARTISTS: "enrichment-artists",
        TRACKS: "enrichment-tracks",
        VIBE: "enrichment-vibe",
        PODCASTS: "enrichment-podcasts",
    },
    artistQueue: { add: mockQueueAdd },
    trackQueue: { add: mockQueueAdd },
    vibeQueue: { add: mockQueueAdd },
    podcastQueue: { add: mockQueueAdd },
    createWorkerConnection: () => ({ host: "localhost", port: 6379 }),
    closeEnrichmentQueues: jest.fn().mockResolvedValue(undefined),
}));

const mockRedis = {
    rpush: jest.fn().mockResolvedValue(1),
    llen: jest.fn().mockResolvedValue(0),
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue("OK"),
    publish: jest.fn().mockResolvedValue(1),
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    scan: jest.fn().mockResolvedValue(["0", []]),
    status: "ready",
};

jest.mock("ioredis", () => jest.fn().mockImplementation(() => mockRedis));
jest.mock("../../config", () => ({
    config: { redisUrl: "redis://localhost:6379", music: { musicPath: "/music" } },
}));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// The pool's size is read at module load: pin the machine's parallelism at 2
// so the test is deterministic on any box.
const actualOs = jest.requireActual("os");
jest.mock("os", () => {
    const withPinned = { ...actualOs, availableParallelism: () => 2 };
    return {
        __esModule: true,
        default: withPinned,
        ...withPinned,
    };
});

jest.mock("../../services/enrichmentState", () => ({
    enrichmentStateService: {
        updateState: jest.fn().mockResolvedValue({}),
        getState: jest.fn().mockResolvedValue(null),
        initializeState: jest.fn().mockResolvedValue({}),
        clear: jest.fn().mockResolvedValue(undefined),
        detectHang: jest.fn().mockResolvedValue(false),
        clearGate: jest.fn().mockResolvedValue(undefined),
        publishToChannel: jest.fn().mockResolvedValue(undefined),
        markFailed: jest.fn().mockResolvedValue(undefined),
        waitForStatus: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        recordFailure: jest.fn().mockResolvedValue({}),
        cleanupOrphanedFailures: jest.fn().mockResolvedValue({ cleaned: 0, checked: 0 }),
        cleanupOldResolved: jest.fn().mockResolvedValue(0),
        getFailures: jest.fn().mockResolvedValue({ failures: [], total: 0 }),
        getFailure: jest.fn().mockResolvedValue(null),
        getFailureCounts: jest.fn().mockResolvedValue({}),
        resetRetryCount: jest.fn().mockResolvedValue(0),
    },
}));

jest.mock("../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: jest.fn().mockResolvedValue({
            vibeEmbeddings: true, podcastSupport: false, fpcalc: true,
        }),
    },
}));

const FINGERPRINT = "AQAA0pMiRZkQJBVZCSA98NOhHT-Q44eFB0sPPsgM_3hwnDgK7Yh6FCeOxyh-HMd5pDh6NEyQaDmuSjgSH8cXHdlyBSdiETAwHd-F88h3";
const mockFingerprintFile = jest.fn();
jest.mock("../../services/fpcalc", () => ({
    fpcalcService: {
        isAvailable: jest.fn().mockResolvedValue(true),
        fingerprintFile: (...args: unknown[]) => mockFingerprintFile(...args),
    },
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchRecording: jest.fn().mockResolvedValue(null),
        getRecordingGenres: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../../workers/audioCompletionSubscriber", () => ({
    startAudioCompletionSubscriber: jest.fn(),
    stopAudioCompletionSubscriber: jest.fn().mockResolvedValue(undefined),
    haltVibeQueuing: jest.fn(),
    resumeVibeQueuing: jest.fn(),
}));

jest.mock("../../workers/artistEnrichmentWorker", () => ({
    startArtistEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../../workers/trackEnrichmentWorker", () => ({
    startTrackEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../../workers/podcastEnrichmentWorker", () => ({
    startPodcastEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));

import { prisma } from "../../utils/db";
import {
    STAGE_TIMEOUT_MS,
    executeFingerprintPhase,
    waitForFingerprintWork,
} from "../../workers/unifiedEnrichment";

const PREFIX = "fppool";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedLibrary(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "FpPool Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "FpPool Album", primaryType: "Album" },
    });
}

async function seedTrack(trackId: string): Promise<void> {
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id("alb"),
            title: `Track ${trackId}`,
            trackNo: 1,
            duration: 218,
            filePath: `artist/album/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
        } as never,
    });
}

async function stageRow(trackId: string) {
    const rows = await prisma.$queryRawUnsafe<
        { status: string; attempt: number; lastErrorCode: string | null }[]
    >(
        `SELECT status, attempt, "lastErrorCode" FROM "TrackStage"
          WHERE "trackId" = $1 AND stage = 'fingerprint'`,
        trackId,
    );
    return rows[0] ?? null;
}

async function storedFingerprint(trackId: string): Promise<string | null> {
    const rows = await prisma.$queryRawUnsafe<{ fingerprint: string | null }[]>(
        `SELECT "acoustidFingerprint" AS fingerprint FROM "Track" WHERE id = $1`,
        trackId,
    );
    return rows[0]?.fingerprint ?? null;
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "SourceAttempt"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

/** A gate: fingerprintFile hangs until released, counting live slots. */
function makeGatedFpcalc() {
    let inFlight = 0;
    const state = { maxInFlight: 0, live: 0, gates: [] as Array<() => void> };
    mockFingerprintFile.mockImplementation(async () => {
        inFlight++;
        state.live = inFlight;
        state.maxInFlight = Math.max(state.maxInFlight, inFlight);
        await new Promise<void>((resolve) => state.gates.push(resolve));
        inFlight--;
        state.live = inFlight;
        return { fingerprint: FINGERPRINT, duration: 218 };
    });
    return {
        state,
        release(n: number): void {
            for (let i = 0; i < n; i++) state.gates.shift()?.();
        },
        releaseAll(): void {
            while (state.gates.length) state.gates.shift()?.();
        },
    };
}

beforeEach(async () => {
    jest.clearAllMocks();
    mockFingerprintFile.mockReset();
    // Restore the stage timeout any previous test shortened.
    STAGE_TIMEOUT_MS.fingerprint = 30_000;
    await wipe();
    await seedLibrary();
});

afterAll(async () => {
    await wipe();
});

describe("the fingerprint stage runs in its own pool", () => {
    it("runs exactly os.availableParallelism() subprocesses at once, and the dispatch does not wait for them", async () => {
        const gate = makeGatedFpcalc();
        const tracks = [id("c1"), id("c2"), id("c3"), id("c4")];
        for (const t of tracks) await seedTrack(t);

        // The dispatch hands out ALL four claims and RETURNS while two
        // fpcalc subprocesses are still running.
        const queued = await executeFingerprintPhase();

        expect(queued).toBe(4);
        // The pool reaches its full width on its own schedule (each run
        // starts with its own DB reads): wait for both slots to be live.
        await new Promise<void>((resolve, reject) => {
            const started = Date.now();
            const poll = setInterval(() => {
                if (gate.state.live === 2) {
                    clearInterval(poll);
                    resolve();
                } else if (Date.now() - started > 5000) {
                    clearInterval(poll);
                    reject(
                        new Error(
                            `fpcalc never reached 2 in flight (live=${gate.state.live}, max=${gate.state.maxInFlight})`,
                        ),
                    );
                }
            }, 10);
        });
        // Concurrency = availableParallelism() = 2: never three at once.
        expect(gate.state.maxInFlight).toBe(2);
        expect(gate.state.live).toBe(2);

        // Let the sweep finish: everything settles done, fingerprints stored.
        // Items 3/4 open fresh gates the moment a slot frees (a few DB hops
        // later), so keep releasing while the drain is still running.
        const drain = waitForFingerprintWork();
        for (let round = 0; round < 100; round++) {
            gate.releaseAll();
            const doneNow = await Promise.race([
                drain.then(() => true),
                new Promise<boolean>((r) => setTimeout(() => r(false), 20)),
            ]);
            if (doneNow) break;
        }
        gate.releaseAll();
        await drain;
        for (const t of tracks) {
            expect((await stageRow(t))?.status).toBe("done");
            expect(await storedFingerprint(t)).toBe(FINGERPRINT);
        }
    });

    it("a hung fpcalc becomes a recorded, classified, retryable failure at the stage's own timeout — and the other slots keep working", async () => {
        // Shrink the stage's own budget: the per-call timeout must come from
        // getStageTimeoutMs('fingerprint'), not a hardcoded number.
        STAGE_TIMEOUT_MS.fingerprint = 250;
        // Only the two doomed tracks hang; anything else answers instantly.
        mockFingerprintFile.mockImplementation(async (p: string) => {
            if (p.includes("fppool_h")) {
                return new Promise<never>(() => undefined); // hang forever
            }
            return { fingerprint: FINGERPRINT, duration: 218 };
        });
        const hung1 = id("h1");
        const hung2 = id("h2");
        const quick = id("q1");
        await seedTrack(hung1);
        await seedTrack(hung2);
        await seedTrack(quick);

        await executeFingerprintPhase();

        // Two slots: both hung. The third question waits for a slot — and
        // gets it the moment a timeout frees one, without the whole loop
        // dying. The hung runs die at the stage budget; the quick one
        // completes; the drain then has nothing left to wait for.
        await waitForFingerprintWork();

        for (const t of [hung1, hung2]) {
            const row = await stageRow(t);
            expect(row?.status).toBe("failed");
            expect(row?.attempt).toBe(1);
            // Classified and retryable — asked again after the backoff,
            // never silently dropped and never parked as done.
            expect(row?.lastErrorCode).not.toBe("RATE_LIMITED");
            const retryable = await prisma.$queryRawUnsafe<{ retryable: boolean }[]>(
                `SELECT retryable FROM "TrackStage" WHERE "trackId" = $1 AND stage = 'fingerprint'`,
                t,
            );
            expect(retryable[0]?.retryable).toBe(true);
            expect(await storedFingerprint(t)).toBeNull();
        }

        // The free slot carried the third question to completion.
        expect((await stageRow(quick))?.status).toBe("done");
        expect(await storedFingerprint(quick)).toBe(FINGERPRINT);
        // And the two hang runs were bounded, not immortal: both died at
        // the stage budget, which is what freed the slot for `quick`.
        expect(mockFingerprintFile).toHaveBeenCalledWith(
            expect.stringContaining("fppool_h1"),
        );
    });
});
