/**
 * "Re-decide everything" is admin-only and reopens every stage question,
 * `done` included, but never reruns AcoustID on a track that already has a
 * `recordingMbid`. Runs against the real test database and requireAdmin.
 */

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

// The database and requireAdmin are real.

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
        // recordStageFailure consults the pause controller on every failure.
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
jest.mock("../../services/enrichment", () => ({
    enrichmentService: {
        enrichArtist: jest.fn(), enrichAlbum: jest.fn(), enrichTrack: jest.fn(),
    },
}));
jest.mock("../../services/imageBackfill", () => ({ repairBrokenCovers: jest.fn() }));
jest.mock("../../services/mbidReassign", () => ({
    DuplicateMbidError: class extends Error {},
    reassignAlbumRgMbid: jest.fn(),
    reassignArtistMbid: jest.fn(),
}));
jest.mock("../../services/artistIdentity", () => ({ artistSortName: jest.fn() }));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ autoEnrichMetadata: true }),
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
import {
    getNextWork,
    redecideEverything,
    waitForFingerprintWork,
} from "../../workers/unifiedEnrichment";
import enrichmentRouter from "../../routes/enrichment";

const PREFIX = "redec";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedLibrary(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Redec Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Redec Album", primaryType: "Album" },
    });
}

async function putStage(
    trackId: string,
    stage: string,
    status: string,
    opts: { attempt?: number } = {},
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, "lastErrorCode",
             "lastErrorMessage", "failureClass", retryable, "nextRetryAt", evidence,
             "decidedAt", "decidedBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status,
                source = EXCLUDED.source,
                attempt = EXCLUDED.attempt,
                "lastErrorCode" = EXCLUDED."lastErrorCode",
                "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                "failureClass" = EXCLUDED."failureClass",
                retryable = EXCLUDED.retryable,
                "nextRetryAt" = EXCLUDED."nextRetryAt",
                evidence = EXCLUDED.evidence,
                "decidedAt" = EXCLUDED."decidedAt",
                "decidedBy" = EXCLUDED."decidedBy"`,
        `${trackId}__${stage}`, trackId, stage, status,
        "analyzer", opts.attempt ?? 3,
        status === "done" ? null : "TEST_SEED",
        status === "done" ? null : "seeded by test",
        status === "done" ? null : "INCONCLUSIVE",
        true, null,
        JSON.stringify({ probe: "ffmpeg -i", rc: 0 }),
        status === "done" ? new Date() : null,
        status === "done" ? "engine" : null,
    );
}

async function seedTrack(
    trackId: string,
    data: Partial<{
        recording: string; analysis: string; embedding: string;
        recordingMbid: string | null;
    }> = {},
): Promise<void> {
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
            recordingMbid: data.recordingMbid ?? null,
            analysisStatus: "pending" as never,
            analysisRetryCount: 0,
        } as never,
    });
    await putStage(trackId, "recording", data.recording ?? "pending");
    await putStage(trackId, "analysis", data.analysis ?? "pending");
    await putStage(trackId, "embedding", data.embedding ?? "pending");
}

async function stageRow(trackId: string, stage: string) {
    const rows = await prisma.$queryRawUnsafe<
        Array<{ status: string; failures: number; decidedBy: string | null }>
    >(
        `SELECT status, failures, "decidedBy" FROM "TrackStage"
          WHERE "trackId" = $1 AND stage = $2`,
        trackId, stage,
    );
    return rows[0];
}

async function wipe(): Promise<void> {
    await waitForFingerprintWork();
    // `redecideEverything` re-opens every matching row in the whole table,
    // so its counts can only be asserted against a globally empty one —
    // other suites in a serial run leave stage rows under other ids, and
    // those rows legitimately get counted otherwise.
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE $1`, `${PREFIX}_%`);
}

beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(mockQueueAdd).mockResolvedValue({ id: "job-1" } as never);
    await wipe();
    await seedLibrary();
});

afterAll(async () => {
    await waitForFingerprintWork();
    await wipe();
    await prisma.$disconnect();
});

// ── the function itself ──────────────────────────────────────────────────

describe("redecideEverything", () => {
    it("re-opens `done` answers — that is the control's purpose — but never the AcoustID answer", async () => {
        // Identified already — re-running AcoustID here would spend a
        // fingerprint to rediscover an answer we already hold.
        await seedTrack(id("identified"), {
            recording: "done", analysis: "done", embedding: "done",
            recordingMbid: "mbid-already-known",
        });
        // Never identified — this question is fair to re-ask.
        await seedTrack(id("unknown"), {
            recording: "done", analysis: "done", embedding: "done",
            recordingMbid: null,
        });

        const { reopened } = await redecideEverything();
        // 3 stages on the unknown track + 2 on the identified track
        // (analysis + embedding; recording is skipped).
        expect(reopened).toBe(5);

        // AcoustID guard: the identified track keeps its recording answer…
        expect((await stageRow(id("identified"), "recording"))?.status).toBe("done");
        // …and it is not offered again by the queue.
        const owed = await getNextWork(50);
        expect(
            owed.some((w) => w.trackId === id("identified") && w.stage === "recording"),
        ).toBe(false);

        // Everything else is deliberately re-asked, `done` included — this
        // is the operator override for "we know the answer was wrong".
        expect((await stageRow(id("identified"), "analysis"))?.status).toBe("pending");
        expect((await stageRow(id("identified"), "embedding"))?.status).toBe("pending");
        expect((await stageRow(id("unknown"), "recording"))?.status).toBe("pending");
        expect((await stageRow(id("unknown"), "analysis"))?.status).toBe("pending");
        expect((await stageRow(id("unknown"), "embedding"))?.status).toBe("pending");

        // Re-opened records carry no stale decision and are due immediately.
        expect((await stageRow(id("unknown"), "analysis"))?.failures).toBe(0);
        expect((await stageRow(id("unknown"), "analysis"))?.decidedBy).toBeNull();
    });

    it("leaves a missing file's status columns closed, as its records are", async () => {
        await seedTrack(id("gone"), { analysis: "done", embedding: "done" });
        await prisma.track.update({
            where: { id: id("gone") },
            data: { missingSince: new Date(), analysisStatus: "completed" } as never,
        });

        await redecideEverything();

        expect((await stageRow(id("gone"), "analysis"))?.status).toBe("failed");
        const track = await prisma.track.findUniqueOrThrow({ where: { id: id("gone") } });
        expect(track.analysisStatus).toBe("permanently_failed");
    });

    it("re-opens a record that was parked `blocked` as well as one that failed terminally", async () => {
        await seedTrack(id("parked"), { recording: "done", analysis: "blocked" });
        await seedTrack(id("closed"), { recording: "done", analysis: "done", embedding: "done" });
        await putStage(id("closed"), "analysis", "failed"); // retryable=false default seed
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage" SET retryable = false
              WHERE "trackId" = $1 AND stage = 'analysis'`,
            id("closed"),
        );

        await redecideEverything();

        // A parked answer and a closed answer are both reopened by an
        // explicit operator decision — that is the only path back from
        // `blocked` and from `retryable = false`.
        expect((await stageRow(id("parked"), "analysis"))?.status).toBe("pending");
        expect((await stageRow(id("closed"), "analysis"))?.status).toBe("pending");
    });

    it("does not dispatch: re-opened questions wait for the next scheduled sweep", async () => {
        await seedTrack(id("nodispatch"), { recording: "done", analysis: "done", embedding: "done" });

        await redecideEverything();

        // Nothing was claimed to `working` and no job was queued — the
        // records simply go back to `pending` for the next cycle.
        expect(mockQueueAdd).not.toHaveBeenCalled();
        expect(mockRedis.rpush).not.toHaveBeenCalled();
        expect((await stageRow(id("nodispatch"), "analysis"))?.status).toBe("pending");
    });
});

// ── the route is admin-only ────────────────────────────────────────────────

describe("POST /enrichment/re-decide-everything and POST /enrichment/retry-failed-and-blocked", () => {
    let app: express.Express;

    async function makeUser(userId: string, role: "admin" | "user"): Promise<string> {
        await prisma.user.create({
            data: { id: userId, username: userId, passwordHash: "x", role, tokenVersion: 0 },
        });
        return generateToken({ id: userId, username: userId, role, tokenVersion: 0 });
    }

    beforeEach(() => {
        app = express();
        app.use(express.json());
        app.use("/enrichment", enrichmentRouter);
    });

    it("answers 403 for a signed-in non-admin on both controls", async () => {
        const token = await makeUser(id("plain"), "user");

        const redecide = await request(app)
            .post("/enrichment/re-decide-everything")
            .set("Authorization", `Bearer ${token}`);
        expect(redecide.status).toBe(403);
        expect(redecide.body.error).toBe("Admin access required");

        const retry = await request(app)
            .post("/enrichment/retry-failed-and-blocked")
            .set("Authorization", `Bearer ${token}`);
        expect(retry.status).toBe(403);
        expect(retry.body.error).toBe("Admin access required");
    });

    it("answers 401 with no credential at all", async () => {
        expect((await request(app).post("/enrichment/re-decide-everything")).status).toBe(401);
        expect((await request(app).post("/enrichment/retry-failed-and-blocked")).status).toBe(401);
    });

    it("answers 200 for an admin, and the control actually runs", async () => {
        const token = await makeUser(id("boss"), "admin");
        await seedTrack(id("redecide"), { recording: "done", analysis: "done", embedding: "done" });

        const res = await request(app)
            .post("/enrichment/re-decide-everything")
            .set("Authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.reopened).toBe(3);
        expect((await stageRow(id("redecide"), "analysis"))?.status).toBe("pending");

        const retry = await request(app)
            .post("/enrichment/retry-failed-and-blocked")
            .set("Authorization", `Bearer ${token}`);
        expect(retry.status).toBe(200);
        // Analysis and fingerprint are handed out; recording waits behind the
        // fingerprint gate.
        expect(retry.body.queued).toBe(2);
    });
});