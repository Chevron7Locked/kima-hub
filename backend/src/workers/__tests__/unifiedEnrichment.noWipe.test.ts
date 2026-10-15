/** Running the enrichment controls leaves seeded embeddings and tags in place. */

// ── Queues + Redis + network services: observe, never hit the wire ──────

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
        // recordStageFailure consults the pause controller on every failure;
        // a local fpcalc error is never source-caused.
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
import {
    waitForFingerprintWork,
    retryFailedAndBlocked,
    redecideEverything,
} from "../../workers/unifiedEnrichment";

const PREFIX = "wipe";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedLibrary(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Wipe Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Wipe Album", primaryType: "Album" },
    });
}

async function putStage(
    trackId: string,
    stage: string,
    status: string,
    opts: { retryable?: boolean } = {},
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, "lastErrorCode",
             "lastErrorMessage", "failureClass", retryable, "nextRetryAt", evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status,
                source = EXCLUDED.source,
                attempt = EXCLUDED.attempt,
                "lastErrorCode" = EXCLUDED."lastErrorCode",
                "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                "failureClass" = EXCLUDED."failureClass",
                retryable = EXCLUDED.retryable,
                "nextRetryAt" = EXCLUDED."nextRetryAt",
                evidence = EXCLUDED.evidence`,
        `${trackId}__${stage}`, trackId, stage, status,
        "analyzer", 0,
        status === "done" ? null : "TEST_SEED",
        status === "done" ? null : "seeded by test",
        status === "done" ? null : "INCONCLUSIVE",
        opts.retryable ?? true, null,
        JSON.stringify({ probe: "ffmpeg -i", rc: 1 }),
    );
}

/** Seed a track whose questions are ALL answered, with real answers. */
async function seedAnsweredTrack(trackId: string): Promise<void> {
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id("alb"),
            title: `Track ${trackId}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            recordingMbid: "mbid-known",
            analysisStatus: "completed" as never,
            analysisRetryCount: 0,
        } as never,
    });
    await putStage(trackId, "recording", "done");
    await putStage(trackId, "analysis", "done");
    await putStage(trackId, "embedding", "done");
    // An answered track has its fingerprint too (the sweep covers every
    // track): without this record the queue would re-offer it forever.
    await putStage(trackId, "fingerprint", "done");
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
         VALUES ($1, $2::vector, 'laion-clap-htsat-unfused-v1', now())
         ON CONFLICT (track_id) DO NOTHING`,
        trackId,
        `[${Array.from({ length: 512 }, (_, i) => (i % 7) / 7).join(",")}]`,
    );
}

async function embeddingCount(trackId: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM track_embeddings WHERE track_id = $1`,
        trackId,
    );
    return Number(rows[0].n);
}

async function wipe(): Promise<void> {
    // The fingerprint pool runs detached: never let an in-flight answer
    // land after the rows it belongs to are gone.
    await waitForFingerprintWork();
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "track_embeddings" WHERE track_id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(mockQueueAdd).mockResolvedValue({ id: "job-1" } as never);
    await wipe();
    await seedLibrary();
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("re-deciding and retrying wipe nothing", () => {
    it("redecideEverything keeps every embedding", async () => {
        await seedAnsweredTrack(id("keep"));

        const { reopened } = await redecideEverything();
        expect(reopened).toBeGreaterThan(0);

        // The embedding is an ANSWER. Re-deciding re-asks the question; it
        // does not delete the answer that is already in the table.
        expect(await embeddingCount(id("keep"))).toBe(1);
    });

    it("retryFailedAndBlocked keeps every embedding", async () => {
        await seedAnsweredTrack(id("keep2"));

        const work = await retryFailedAndBlocked(50);
        // Everything is answered — nothing is handed out at all.
        expect(work.filter((w) => w.trackId.startsWith(id("keep2")))).toHaveLength(0);

        expect(await embeddingCount(id("keep2"))).toBe(1);
    });

    it("running both controls back to back still deletes nothing", async () => {
        await seedAnsweredTrack(id("keep3"));

        await redecideEverything();
        await retryFailedAndBlocked(50);

        // Even after re-deciding everything and retrying whatever is owed,
        // the answers already on disk survive untouched.
        expect(await embeddingCount(id("keep3"))).toBe(1);
        const track = await prisma.track.findUnique({ where: { id: id("keep3") } });
        expect(track).not.toBeNull();
    });
});