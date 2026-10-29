/**
 * Shared jest.mock factories for the specs that load workers/unifiedEnrichment
 * against the real test database: queues, Redis, and every network-facing
 * service stood in. jest hoists jest.mock above imports, so a spec reaches a
 * mock through a factory that requires this module:
 *
 *   jest.mock("../../services/musicbrainz", () =>
 *       require("../../__tests__/helpers/enrichmentMocks").musicBrainzMock);
 *
 * and imports the observable jest.fn handles (mockQueueAdd, mockIdentifyRecording,
 * ...) from the same module; both get one instance per test file. A spec that
 * needs a different answer sets it on the handle or declares its own jest.mock.
 */

export const noData = { kind: "absent", evidence: { mocked: true } } as const;

export const mockQueueAdd = jest.fn().mockResolvedValue({ id: "job-1" });
export const mockQueueClean = jest.fn().mockResolvedValue([]);
export const mockQueueGetJob = jest.fn().mockResolvedValue(null);
export const mockQueueResume = jest.fn().mockResolvedValue(undefined);

function queueMock() {
    return {
        add: mockQueueAdd,
        clean: mockQueueClean,
        getJob: mockQueueGetJob,
        resume: mockQueueResume,
        pause: jest.fn().mockResolvedValue(undefined),
    };
}

export const enrichmentQueuesMock = {
    QUEUE_NAMES: {
        ARTISTS: "enrichment-artists",
        TRACKS: "enrichment-tracks",
        VIBE: "enrichment-vibe",
        PODCASTS: "enrichment-podcasts",
    },
    artistQueue: queueMock(),
    trackQueue: queueMock(),
    vibeQueue: queueMock(),
    podcastQueue: queueMock(),
    createWorkerConnection: () => ({ host: "localhost", port: 6379 }),
    closeEnrichmentQueues: jest.fn().mockResolvedValue(undefined),
};

export const mockRedis = {
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

/** The ioredis module: every `new Redis()` is `mockRedis`. */
export const ioredisMock = jest.fn().mockImplementation(() => mockRedis);

export const configMock = {
    config: { redisUrl: "redis://localhost:6379", music: { musicPath: "/music" } },
};

export const loggerMock = {
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
};

export const enrichmentStateMock = {
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
};

export const mockRecordFailure = jest.fn().mockResolvedValue({});

export const enrichmentFailureServiceMock = {
    enrichmentFailureService: {
        recordFailure: mockRecordFailure,
        cleanupOrphanedFailures: jest.fn().mockResolvedValue({ cleaned: 0, checked: 0 }),
        cleanupOldResolved: jest.fn().mockResolvedValue(0),
        getFailures: jest.fn().mockResolvedValue({ failures: [], total: 0 }),
        getFailure: jest.fn().mockResolvedValue(null),
        getFailureCounts: jest.fn().mockResolvedValue({}),
        resetRetryCount: jest.fn().mockResolvedValue(0),
    },
};

export const featureDetectionMock = {
    featureDetection: {
        analyzerRunning: jest.fn().mockResolvedValue(false),
        clapRunning: jest.fn().mockResolvedValue(false),
        getFeatures: jest.fn().mockResolvedValue({
            vibeEmbeddings: true, podcastSupport: false, fpcalc: true,
        }),
    },
};

export const trackIdentityMock = {
    trackIdentityService: {
        populateTrackGenres: jest.fn().mockResolvedValue(undefined),
    },
};

export const mockIdentifyRecording = jest.fn().mockResolvedValue(noData);
export const mockLookupRecordingsByIsrc = jest.fn().mockResolvedValue(noData);

export const musicBrainzMock = {
    musicBrainzService: {
        identifyRecording: (...a: unknown[]) => mockIdentifyRecording(...a),
        lookupRecordingsByIsrc: (...a: unknown[]) => mockLookupRecordingsByIsrc(...a),
        searchRecording: jest.fn().mockResolvedValue(null),
        getRecordingGenres: jest.fn().mockResolvedValue(noData),
        getAlbumCatalogue: jest.fn().mockResolvedValue(noData),
    },
};

export const mockIdentifyTrackByAcoustid = jest.fn().mockResolvedValue(noData);
export const mockReadIdentityTags = jest.fn().mockResolvedValue(null);

export const acoustidIdentificationMock = {
    prefetchAcoustidReplies: jest.fn().mockResolvedValue(0),
    identifyTrackByAcoustid: (...a: unknown[]) => mockIdentifyTrackByAcoustid(...a),
    persistAcoustidFingerprint: jest.fn().mockResolvedValue(undefined),
    readIdentityTags: (...a: unknown[]) => mockReadIdentityTags(...a),
};

export const mockHandleRateLimit = jest.fn().mockResolvedValue(false);
export const mockGetPause = jest.fn().mockResolvedValue(null);

export const sourcePauseControllerMock = {
    sourcePauseController: {
        isPaused: jest.fn().mockResolvedValue(false),
        open: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        handleRateLimit: (...a: unknown[]) => mockHandleRateLimit(...a),
        getPause: (...a: unknown[]) => mockGetPause(...a),
        windowMs: 60_000,
    },
};

export const audioCompletionSubscriberMock = {
    startAudioCompletionSubscriber: jest.fn(),
    stopAudioCompletionSubscriber: jest.fn().mockResolvedValue(undefined),
    haltVibeQueuing: jest.fn(),
    resumeVibeQueuing: jest.fn(),
};

function startedWorker() {
    return jest.fn().mockResolvedValue({
        pause: jest.fn(), resume: jest.fn(), close: jest.fn(),
    });
}

export const artistEnrichmentWorkerMock = { startArtistEnrichmentWorker: startedWorker() };
export const trackEnrichmentWorkerMock = { startTrackEnrichmentWorker: startedWorker() };
export const podcastEnrichmentWorkerMock = { startPodcastEnrichmentWorker: startedWorker() };
