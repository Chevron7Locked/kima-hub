/**
 * A `rateLimited` answer parks the record until its `retryAfter`, uses no
 * attempt and records no failure. A no-match from every source closes the
 * record `done` with the asked sources as evidence.
 */

const noData = { kind: "absent", evidence: { mocked: true } } as const;

const mockQueueAdd = jest.fn().mockResolvedValue({ id: "job-1" });
const mockQueueClean = jest.fn().mockResolvedValue([]);
const mockQueueGetJob = jest.fn().mockResolvedValue(null);
const mockQueueResume = jest.fn().mockResolvedValue(undefined);

jest.mock("../../workers/enrichmentQueues", () => ({
    QUEUE_NAMES: {
        ARTISTS: "enrichment-artists",
        TRACKS: "enrichment-tracks",
        VIBE: "enrichment-vibe",
        PODCASTS: "enrichment-podcasts",
    },
    artistQueue: {
        add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob,
        resume: mockQueueResume, pause: jest.fn().mockResolvedValue(undefined),
    },
    trackQueue: {
        add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob,
        resume: mockQueueResume, pause: jest.fn().mockResolvedValue(undefined),
    },
    vibeQueue: {
        add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob,
        resume: mockQueueResume, pause: jest.fn().mockResolvedValue(undefined),
    },
    podcastQueue: {
        add: mockQueueAdd, clean: mockQueueClean, getJob: mockQueueGetJob,
        resume: mockQueueResume, pause: jest.fn().mockResolvedValue(undefined),
    },
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
    status: "ready",
};

jest.mock("ioredis", () => jest.fn().mockImplementation(() => mockRedis));
jest.mock("../../config", () => ({
    config: { redisUrl: "redis://localhost:6379", music: { musicPath: "/music" } },
}));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

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

const mockRecordFailure = jest.fn().mockResolvedValue({});

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        recordFailure: mockRecordFailure,
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

jest.mock("../../services/trackIdentity", () => ({
    trackIdentityService: {
        populateTrackGenres: jest.fn().mockResolvedValue(undefined),
        storeIsrc: jest.fn().mockResolvedValue(undefined),
    },
}));

const mockSearchRecording = jest.fn();
const mockLookupByIsrc = jest.fn();

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        identifyRecording: (...a: unknown[]) => mockSearchRecording(...a),
        lookupRecordingsByIsrc: (...a: unknown[]) => mockLookupByIsrc(...a),
        getRecordingGenres: jest.fn().mockResolvedValue(noData),
        getAlbumCatalogue: jest.fn().mockResolvedValue(noData),
    },
}));

const mockIdentify = jest.fn();
const mockReadTags = jest.fn();
jest.mock("../../services/acoustidIdentification", () => ({
    prefetchAcoustidReplies: jest.fn().mockResolvedValue(0),
    identifyTrackByAcoustid: (...a: unknown[]) => mockIdentify(...a),
    persistAcoustidFingerprint: jest.fn().mockResolvedValue(undefined),
    readIdentityTags: (...a: unknown[]) => mockReadTags(...a),
}));

const mockHandleRateLimit = jest.fn();
const mockGetPause = jest.fn();

jest.mock("../../services/sourcePauseController", () => ({
    sourcePauseController: {
        isPaused: jest.fn().mockResolvedValue(false),
        open: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        handleRateLimit: (...a: unknown[]) => mockHandleRateLimit(...a),
        getPause: (...a: unknown[]) => mockGetPause(...a),
        windowMs: 60_000,
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
import { enrichSingleTrack } from "../../workers/unifiedEnrichment";

const PREFIX = "mb429";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedTrack(
    trackId: string,
    opts: { isrc?: string | null; attempt?: number } = {},
) {
    await prisma.artist.create({
        data: { id: id(trackId + "art"), name: "MB429 Artist", identityKey: id(trackId + "a") },
    });
    await prisma.album.create({
        data: { id: id(trackId + "alb"), rgMbid: id(trackId + "rg"), artistId: id(trackId + "art"), title: "MB429 Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id(trackId + "alb"),
            title: "Rate Limited Song",
            trackNo: 1,
            duration: 180,
            filePath: `/music/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            isrc: opts.isrc ?? null,
        } as never,
    });
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, retryable, evidence)
         VALUES ($1, $2, 'recording', 'working', 'musicbrainz', $3, true, $4::jsonb)`,
        `${trackId}__recording`,
        trackId,
        opts.attempt ?? 2,
        JSON.stringify({ question: "recording" }),
    );
}

async function stageRow(trackId: string) {
    const rows = await prisma.$queryRawUnsafe<Array<{
        status: string; attempt: number; retryable: boolean;
        nextRetryAt: Date | null; lastErrorCode: string | null;
        failureClass: string | null; evidence: { reason?: string };
    }>>(
        `SELECT status, attempt, retryable, "nextRetryAt", "lastErrorCode",
                "failureClass", evidence
           FROM "TrackStage" WHERE "trackId" = $1 AND stage = 'recording'`,
        trackId,
    );
    return rows[0];
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${PREFIX}_%`);
}

beforeEach(async () => {
    jest.clearAllMocks();
    mockHandleRateLimit.mockResolvedValue(false);
    mockGetPause.mockResolvedValue(null);
    mockRecordFailure.mockResolvedValue({});
    mockReadTags.mockResolvedValue({
        recordingMbid: null,
        fingerprint: null,
        duration: 200,
    });
    mockIdentify.mockResolvedValue({
        kind: "permanent",
        error: {
            code: "NO_FINGERPRINT",
            message: "no fingerprint on hand — the step refuses",
        },
    });
    await wipe();
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("a rate-limited answer parks the question at its own deadline", () => {
    it("keeps the record pending until retryAfter, consumes no attempt, and reports deferral", async () => {
        const trackId = id("t1");
        await seedTrack(trackId); // attempt 2, already spent once
        const retryAfter = new Date(Date.now() + 60_000);
        mockSearchRecording.mockResolvedValue({
            kind: "rateLimited",
            retryAfter,
            evidence: { status: 429, source: "mocked" },
        });

        const outcome = await enrichSingleTrack(trackId);

        const stage = await stageRow(trackId);
        // Parked, not failed: the same attempt it was dispatched with, due
        // again exactly when the answer said to come back.
        expect(stage.status).toBe("pending");
        expect(stage.attempt).toBe(2);
        expect(stage.retryable).toBe(true);
        expect(stage.lastErrorCode).toBe("RATE_LIMITED");
        expect(new Date(stage.nextRetryAt!).getTime()).toBe(retryAfter.getTime());

        // The work reported deferral, so no queue-side settlement can
        // clobber the parked record into done/failed.
        expect(outcome).toBe("deferred");
    });
});

describe("an honest no-match", () => {
    it("answers the question as Absent with no attempt consumed", async () => {
        const trackId = id("t2");
        await seedTrack(trackId, { attempt: 1 });
        // Every source answered "nothing there", which is an answer: the
        // record closes `done` and the retry ladder is untouched.
        mockReadTags.mockResolvedValue({
            recordingMbid: null,
            fingerprint: "TAGFP",
            duration: 200,
        });
        mockSearchRecording.mockResolvedValue(noData);
        mockIdentify.mockResolvedValue({
            kind: "absent",
            evidence: { fingerprint: "TAGFP", reason: "nothing matched" },
        });

        const outcome = await enrichSingleTrack(trackId);

        expect(outcome).toBe("no_match");

        const stage = await stageRow(trackId);
        expect(stage.status).toBe("done");
        expect(stage.attempt).toBe(1); // an answer is not a failed attempt
        expect(stage.failureClass).toBeNull();
        expect(stage.nextRetryAt).toBeNull();
        expect(stage.evidence.reason).toBe(
            "no source has a recording that is this track",
        );
    });
});