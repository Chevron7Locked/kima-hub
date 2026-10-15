/**
 * The map's one-time layout waits until every input of the matching formula is settled:
 * artist genres, analysis and sound vectors, including answers still due a retry.
 */

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

jest.mock("../../services/trackIdentity", () => ({
    trackIdentityService: {
        populateTrackGenres: jest.fn().mockResolvedValue(undefined),
        storeIsrc: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchRecording: jest.fn().mockResolvedValue(null),
        getRecordingGenres: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../../services/acoustidIdentification", () => ({
    prefetchAcoustidReplies: jest.fn().mockResolvedValue(0),
    identifyTrackByAcoustid: jest.fn().mockResolvedValue(null),
    persistAcoustidFingerprint: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/sourcePauseController", () => ({
    sourcePauseController: {
        isPaused: jest.fn().mockResolvedValue(false),
        open: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
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

const mockUpdateMap = jest.fn().mockResolvedValue({ laidOut: 0, placed: 0 });
jest.mock("../../services/matching/map", () => ({
    updateMap: (settled: boolean) => mockUpdateMap(settled),
}));
jest.mock("../../services/matching/state", () => ({
    buildMatching: jest.fn().mockResolvedValue({ feelUpdated: 0 }),
    matchingProgress: jest.fn().mockResolvedValue({ total: 0, completed: 0 }),
}));

import { prisma } from "../../utils/db";
import { executeSimilarityPhase, invalidateEnrichmentProgress } from "../../workers/unifiedEnrichment";

const PREFIX = "simgate";
const id = (n: string) => `${PREFIX}_${n}`;

async function putStage(trackId: string, stage: string, status: string, retryable = true): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
         VALUES ($1, $2, $3, $4, 'test', 1, $5, '{}'::jsonb)
         ON CONFLICT ("trackId", stage) DO UPDATE SET status = EXCLUDED.status, retryable = EXCLUDED.retryable`,
        `${trackId}__${stage}`, trackId, stage, status, retryable,
    );
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${PREFIX}_%`);
}

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await prisma.artist.create({
        data: { id: id("art"), name: "Gate Artist", identityKey: id("a"), enrichmentStatus: "completed" },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Gate Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: id("t"), albumId: id("alb"), title: "Gate Track", trackNo: 1, duration: 180,
            filePath: `/tmp/${id("t")}.flac`, fileModified: new Date(), fileSize: 1000,
        },
    });
    for (const stage of ["recording", "analysis", "embedding", "fingerprint"]) await putStage(id("t"), stage, "done");
    invalidateEnrichmentProgress();
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("the map's first layout waits for the formula's inputs", () => {
    it("lays out once every input is settled", async () => {
        await executeSimilarityPhase();
        expect(mockUpdateMap).toHaveBeenCalledWith(true);
    });

    it.each(["pending", "enriching", "failed"])("waits while an artist is %s", async (status) => {
        await prisma.artist.update({ where: { id: id("art") }, data: { enrichmentStatus: status } });
        await executeSimilarityPhase();
        expect(mockUpdateMap).toHaveBeenCalledWith(false);
    });

    it("waits while a sound vector is due a retry", async () => {
        await putStage(id("t"), "embedding", "failed", true);
        await executeSimilarityPhase();
        expect(mockUpdateMap).toHaveBeenCalledWith(false);
    });

    it("does not wait on an analysis a person set aside", async () => {
        await putStage(id("t"), "analysis", "blocked", false);
        await executeSimilarityPhase();
        expect(mockUpdateMap).toHaveBeenCalledWith(true);
    });
});
