/**
 * A song on a Discover album is never enriched: no stage is offered it, it never holds sound vectors back behind
 * analysis, and the enrichment page never counts it as owed. Once a like moves its album to the library, it is due.
 */

// ── Queues + Redis + network services: observe, never hit the wire ──────────

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
    featureDetection: { analyzerRunning: jest.fn().mockResolvedValue(false), clapRunning: jest.fn().mockResolvedValue(false),
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
    identifyTrackByAcoustid: jest.fn().mockResolvedValue({ kind: "absent", evidence: { mocked: true } }),
    persistAcoustidFingerprint: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/sourcePauseController", () => ({
    sourcePauseController: {
        isPaused: jest.fn().mockResolvedValue(false),
        open: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        handleRateLimit: jest.fn().mockResolvedValue(false),
        getPause: jest.fn().mockResolvedValue(null),
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
import { featureDetection } from "../../services/featureDetection";
import {
    analysisStillRunning,
    waitForFingerprintWork,
    getNextWork,
    getEnrichmentProgress,
    invalidateEnrichmentProgress,
} from "../../workers/unifiedEnrichment";

const PREFIX = "discskip";
const id = (n: string) => `${PREFIX}_${n}`;
const STAGES = ["fingerprint", "recording", "analysis", "embedding"] as const;

async function seed(): Promise<void> {
    await prisma.artist.create({ data: { id: id("art"), name: "Discskip Artist", identityKey: id("a") } });
    for (const [album, location] of [["lib", "LIBRARY"], ["disc", "DISCOVER"]] as const) {
        await prisma.album.create({
            data: { id: id(album), rgMbid: id(`rg_${album}`), artistId: id("art"), identityKey: id(`ik_${album}`), title: `Discskip ${album}`, primaryType: "Album", location },
        });
        await prisma.track.create({
            data: {
                id: id(`t_${album}`),
                albumId: id(album),
                title: `Track ${album}`,
                trackNo: 1,
                duration: 180,
                filePath: `/music/${PREFIX}_${album}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
            } as never,
        });
    }
}

/** Every earlier stage answered for both songs, so each stage's question is due but for the album. */
async function answerAllBefore(stage: (typeof STAGES)[number]): Promise<void> {
    for (const earlier of STAGES.slice(0, STAGES.indexOf(stage))) {
        for (const track of [id("t_lib"), id("t_disc")]) {
            await prisma.trackStage.create({ data: { trackId: track, stage: earlier, status: "done" } });
        }
    }
}

async function wipe(): Promise<void> {
    await waitForFingerprintWork();
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${PREFIX}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${PREFIX}%`);
}

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await seed();
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

const ours = (work: { trackId: string }[]) => work.map((w) => w.trackId).filter((t) => t.startsWith(PREFIX));

describe("enrichment leaves Discover songs alone", () => {
    it.each(STAGES)("the %s stage is offered the library song, never the Discover one", async (stage) => {
        await answerAllBefore(stage);
        expect(ours(await getNextWork(50, stage))).toEqual([id("t_lib")]);
    });

    it("a Discover song owed analysis does not hold sound vectors back", async () => {
        (featureDetection.analyzerRunning as jest.Mock).mockResolvedValue(true);
        try {
            await prisma.trackStage.create({ data: { trackId: id("t_lib"), stage: "analysis", status: "done" } });
            // Other files in the run leave no owed songs of their own behind (they wipe), so the Discover song is
            // the only one with no analysis answer.
            expect(await analysisStillRunning(new Date())).toBe(false);
        } finally {
            (featureDetection.analyzerRunning as jest.Mock).mockResolvedValue(false);
        }
    });

    it("the enrichment page does not count a Discover song as owed", async () => {
        invalidateEnrichmentProgress();
        const withBoth = (await getEnrichmentProgress()).audioAnalysis;
        await prisma.track.delete({ where: { id: id("t_disc") } });
        invalidateEnrichmentProgress();
        const withLibraryOnly = (await getEnrichmentProgress()).audioAnalysis;
        expect(withBoth.total).toBe(withLibraryOnly.total);
    });

    it("once a like moves its album to the library, the song is due", async () => {
        expect(ours(await getNextWork(50, "fingerprint"))).toEqual([id("t_lib")]);
        await prisma.album.update({ where: { id: id("disc") }, data: { location: "LIBRARY" } });
        expect(ours(await getNextWork(50, "fingerprint")).sort()).toEqual([id("t_disc"), id("t_lib")].sort());
    });
});
