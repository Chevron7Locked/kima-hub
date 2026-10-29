/** The enrichment controls never delete a Track row. */

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
    featureDetection: { analyzerRunning: jest.fn().mockResolvedValue(false), clapRunning: jest.fn().mockResolvedValue(false),
        getFeatures: jest.fn().mockResolvedValue({
            vibeEmbeddings: true, podcastSupport: false, fpcalc: true,
        }),
    },
}));

jest.mock("../../services/trackIdentity", () => ({
    trackIdentityService: {
        populateTrackGenres: jest.fn().mockResolvedValue(undefined),
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
        // recordStageFailure consults the pause controller on every failure
        // (a fingerprint run against this suite's fake files fails and is
        // classified); a local fpcalc error is never source-caused.
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

// Services the control routes reach through to the network.
jest.mock("../../services/imageBackfill", () => ({ repairBrokenCovers: jest.fn() }));
jest.mock("../../services/mbidReassign", () => ({
    DuplicateMbidError: class extends Error {},
    reassignAlbumRgMbid: jest.fn(),
    reassignArtistMbid: jest.fn(),
}));
jest.mock("../../services/artistIdentity", () => ({ artistSortName: jest.fn() }));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({}),
    invalidateSystemSettingsCache: jest.fn(),
}));
jest.mock("../../services/rateLimiter", () => ({ rateLimiter: {} }));
jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn(), setex: jest.fn(), del: jest.fn(), set: jest.fn() },
}));

import request from "supertest";
import express from "express";

import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import enrichmentRouter from "../../routes/enrichment";
import { waitForFingerprintWork } from "../../workers/unifiedEnrichment";

const PREFIX = "nodelete";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedLibrary(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "NoDelete Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "NoDelete Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: id("t1"),
            albumId: id("alb"),
            title: "Owed track",
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${id("t1")}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            analysisStatus: "pending" as never,
            analysisRetryCount: 0,
        } as never,
    });
    // The migration seeds every track's stage rows; the harness DB may or
    // may not have them for a hand-seeded track, so create them explicitly.
    for (const [stage, status] of [
        ["recording", "failed"],
        ["analysis", "pending"],
        ["embedding", "pending"],
    ] as const) {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt, "lastErrorCode",
                 "lastErrorMessage", "failureClass", retryable, "nextRetryAt", evidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
             ON CONFLICT ("trackId", stage) DO NOTHING`,
            `${id("t1")}__${stage}`, id("t1"), stage, status,
            stage === "recording" ? "musicbrainz" : stage === "analysis" ? "analyzer" : "clap",
            1, "TEST_SEED", "seeded by test", "INCONCLUSIVE", true, null,
            JSON.stringify({ probe: "ffmpeg -i", rc: 1 }),
        );
    }
}

async function stageRow(trackId: string, stage: string) {
    const rows = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM "TrackStage" WHERE "trackId" = $1 AND stage = $2`,
        trackId, stage,
    );
    return rows[0];
}

async function wipe(): Promise<void> {
    // The controls dispatch fingerprint work detached: drain before wiping.
    await waitForFingerprintWork();
    // The retry control offers every owed record in the database, so the
    // queued-count assertions need a library with only this suite's rows
    // (each suite seeds its own fixtures).
    await prisma.$executeRawUnsafe(`DELETE FROM "Track"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "track_embeddings" WHERE track_id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE $1`, `${PREFIX}_%`);
}

let app: express.Express;

async function makeAdmin(userId: string): Promise<string> {
    await prisma.user.create({
        data: { id: userId, username: userId, passwordHash: "x", role: "admin", tokenVersion: 0 },
    });
    return generateToken({ id: userId, username: userId, role: "admin", tokenVersion: 0 });
}

beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(mockQueueAdd).mockResolvedValue({ id: "job-1" } as never);
    await wipe();
    await seedLibrary();
    app = express();
    app.use(express.json());
    app.use("/enrichment", enrichmentRouter);
});

afterAll(async () => {
    await wipe();
});

describe("enrichment controls never delete Track rows", () => {
    it("POST /retry-failed-and-blocked keeps the Track and its records, and reflects the true state", async () => {
        const token = await makeAdmin(id("boss2"));

        const res = await request(app)
            .post("/enrichment/retry-failed-and-blocked")
            .set("Authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
        // Fingerprint and analysis are handed out. Recording waits behind the
        // fingerprint gate, embedding behind analysis; nothing is deleted.
        expect(res.body.queued).toBe(2);

        // The Track row persists, with its true state reflected: the due
        // record was claimed to `working`, not deleted, and the recording
        // question is exactly as it was — waiting on its unsettled gate.
        const track = await prisma.track.findUnique({ where: { id: id("t1") } });
        expect(track).not.toBeNull();
        expect((await stageRow(id("t1"), "recording"))?.status).toBe("failed");
        expect((await stageRow(id("t1"), "analysis"))?.status).toBe("working");
        expect((await stageRow(id("t1"), "embedding"))?.status).toBe("pending");
    });

    it("POST /re-decide-everything keeps the Track and its records", async () => {
        const token = await makeAdmin(id("boss3"));

        const res = await request(app)
            .post("/enrichment/re-decide-everything")
            .set("Authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.reopened).toBeGreaterThanOrEqual(3);

        // Nothing was deleted: all three stage records still exist, back at
        // `pending` — the queue's state moved, no answer row was removed.
        expect((await stageRow(id("t1"), "recording"))?.status).toBe("pending");
        expect((await stageRow(id("t1"), "analysis"))?.status).toBe("pending");
        expect((await stageRow(id("t1"), "embedding"))?.status).toBe("pending");
        expect(await prisma.track.findUnique({ where: { id: id("t1") } })).not.toBeNull();
    });
});