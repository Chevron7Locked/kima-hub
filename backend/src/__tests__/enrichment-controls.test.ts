/**
 * The enrichment controls only move `TrackStage` rows back to `pending`; they
 * never delete data. `retryFailedAndBlocked` re-offers failed and blocked
 * questions; `redecideEverything` also reopens `done` ones, except AcoustID on
 * a track that already has a `recordingMbid`.
 */

// ── Queues + Redis + network services: observe, never hit the wire ──────

const mockQueueAdd = jest.fn().mockResolvedValue({ id: "job-1" });
const mockQueueClean = jest.fn().mockResolvedValue([]);
const mockQueueGetJob = jest.fn().mockResolvedValue(null);
const mockQueueResume = jest.fn().mockResolvedValue(undefined);

jest.mock("../workers/enrichmentQueues", () => ({
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
jest.mock("../config", () => ({ config: { redisUrl: "redis://localhost:6379", music: { musicPath: "/music" } } }));
jest.mock("../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// NOTE: `../utils/db` and `../middleware/auth` are deliberately NOT mocked —
// the gating must be proven against the real TrackStage table the migration
// creates, and "Re-decide everything is admin-only" must be proven against
// the real requireAdmin, not a stub that hands back whatever role we ask for.

jest.mock("../services/enrichmentState", () => ({
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

jest.mock("../services/enrichmentFailureService", () => ({
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

jest.mock("../services/featureDetection", () => ({
    featureDetection: { analyzerRunning: jest.fn().mockResolvedValue(false), clapRunning: jest.fn().mockResolvedValue(false),
        getFeatures: jest.fn().mockResolvedValue({
            vibeEmbeddings: true, podcastSupport: false, fpcalc: true,
        }),
    },
}));

jest.mock("../services/trackIdentity", () => ({
    trackIdentityService: {
        populateTrackGenres: jest.fn().mockResolvedValue(undefined),
        storeIsrc: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock("../services/musicbrainz", () => ({
    musicBrainzService: {
        searchRecording: jest.fn().mockResolvedValue(null),
        getRecordingGenres: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../services/acoustidIdentification", () => ({
    prefetchAcoustidReplies: jest.fn().mockResolvedValue(0),
    identifyTrackByAcoustid: jest.fn().mockResolvedValue(null),
    persistAcoustidFingerprint: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/sourcePauseController", () => ({
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

jest.mock("../workers/audioCompletionSubscriber", () => ({
    startAudioCompletionSubscriber: jest.fn(),
    stopAudioCompletionSubscriber: jest.fn().mockResolvedValue(undefined),
    haltVibeQueuing: jest.fn(),
    resumeVibeQueuing: jest.fn(),
}));

jest.mock("../workers/artistEnrichmentWorker", () => ({
    startArtistEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../workers/trackEnrichmentWorker", () => ({
    startTrackEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));
jest.mock("../workers/podcastEnrichmentWorker", () => ({
    startPodcastEnrichmentWorker: jest.fn().mockResolvedValue({ pause: jest.fn(), resume: jest.fn(), close: jest.fn() }),
}));

// Services the control routes reach through to the network.
jest.mock("../services/imageBackfill", () => ({ repairBrokenCovers: jest.fn() }));
jest.mock("../services/mbidReassign", () => ({
    DuplicateMbidError: class extends Error {},
    reassignAlbumRgMbid: jest.fn(),
    reassignArtistMbid: jest.fn(),
}));
jest.mock("../services/artistIdentity", () => ({ artistSortName: jest.fn() }));
jest.mock("../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ autoEnrichMetadata: true }),
    invalidateSystemSettingsCache: jest.fn(),
}));
jest.mock("../services/rateLimiter", () => ({ rateLimiter: {} }));
jest.mock("../utils/redis", () => ({
    redisClient: { get: jest.fn(), setex: jest.fn(), del: jest.fn(), set: jest.fn() },
}));

// The scan router's queue + organizer, so mounting it does not start BullMQ.
jest.mock("../workers/queues", () => ({
    scanQueue: {
        add: jest.fn().mockResolvedValue({ id: "scan-1" }),
        getJob: jest.fn().mockResolvedValue(null),
    },
}));
jest.mock("../workers/organizeSingles", () => ({ organizeSingles: jest.fn() }));

import request from "supertest";
import express from "express";

import { prisma } from "../utils/db";
import { generateToken } from "../middleware/auth";
import {
    getNextWork,
    getEnrichmentProgress,
    invalidateEnrichmentProgress,
    retryFailedAndBlocked,
    redecideEverything,
    waitForFingerprintWork,
} from "../workers/unifiedEnrichment";
import enrichmentRouter from "../routes/enrichment";
import scanRouter from "../routes/library/scan";

const PREFIX = "ctrl";
const id = (n: string) => `${PREFIX}_${n}`;

/** Seed the FK chain `TrackStage.trackId` points at. */
async function seedLibrary(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Ctrl Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Ctrl Album", primaryType: "Album" },
    });
}

/** Write one stage record, replacing any existing one. */
async function putStage(
    trackId: string,
    stage: string,
    status: string,
    opts: { source?: string; attempt?: number; retryable?: boolean; nextRetryAt?: Date | null } = {},
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
        opts.source ?? "analyzer", opts.attempt ?? 0,
        status === "done" ? null : "TEST_SEED",
        status === "done" ? null : "seeded by test",
        status === "done" ? null : "INCONCLUSIVE",
        opts.retryable ?? true, opts.nextRetryAt ?? null,
        JSON.stringify({ probe: "ffmpeg -i", rc: 1 }),
    );
}

async function seedTrack(
    trackId: string,
    data: Partial<{
        recording: string; analysis: string; embedding: string;
        recordingMbid: string | null;
        analysisStatus: string;
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
            analysisStatus: (data.analysisStatus ?? "pending") as never,
            analysisRetryCount: 0,
        } as never,
    });
    await putStage(trackId, "recording", data.recording ?? "pending");
    await putStage(trackId, "analysis", data.analysis ?? "pending");
    await putStage(trackId, "embedding", data.embedding ?? "pending");
}

async function stageRow(trackId: string, stage: string) {
    const rows = await prisma.$queryRawUnsafe<
        Array<{ status: string; retryable: boolean; nextRetryAt: Date | null }>
    >(
        `SELECT status, retryable, "nextRetryAt"
           FROM "TrackStage" WHERE "trackId" = $1 AND stage = $2`,
        trackId, stage,
    );
    return rows[0];
}

async function wipe(): Promise<void> {
    await waitForFingerprintWork();
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "track_embeddings" WHERE track_id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE $1`, `${PREFIX}_%`);
}

beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(mockQueueAdd).mockResolvedValue({ id: "job-1" } as never);
    jest.mocked(mockQueueGetJob).mockResolvedValue(null as never);
    jest.mocked(mockRedis.llen).mockResolvedValue(0);
    jest.mocked(mockRedis.get).mockResolvedValue(null as never);
    await wipe();
    await seedLibrary();
    invalidateEnrichmentProgress();
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

// ── (a) getNextWork: only rows whose answer is missing or due ───────────

describe("getNextWork over TrackStage", () => {
    it("never offers a `done` answer, a terminal failure, or a not-yet-due retry", async () => {
        // Answered already — must not be re-asked.
        await seedTrack(id("answered"), { recording: "done", analysis: "done", embedding: "done" });
        // Terminal: we know this file is damaged. Never re-offered.
        await seedTrack(id("terminal"), { analysis: "failed" });
        await putStage(id("terminal"), "analysis", "failed", { retryable: false });
        // Parked for a human — holds until re-decided.
        await seedTrack(id("blocked"), { analysis: "blocked" });
        // Retry exists but its backoff has not elapsed.
        await seedTrack(id("notdue"), { analysis: "failed" });
        await putStage(id("notdue"), "analysis", "failed", {
            retryable: true, nextRetryAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        // Genuinely owed. Its fingerprint question is already SETTLED (done):
        // the recording stage reads that settled answer (PREREQUISITE_STAGE:
        // fingerprint → recording), while analysis reads only the file
        // (analysis does NOT wait for the recording answer).
        await seedTrack(id("owed"), { recording: "pending", analysis: "pending", embedding: "pending" });
        await putStage(id("owed"), "fingerprint", "done");

        const work = await getNextWork(50);
        const byStage = new Map(work.map((w) => [`${w.trackId}/${w.stage}`, w]));

        // Nothing answered is re-asked.
        for (const stage of ["recording", "analysis", "embedding"]) {
            expect(byStage.has(`${id("answered")}/${stage}`)).toBe(false);
        }
        // A closed answer and a parked answer are both still closed.
        expect(byStage.has(`${id("terminal")}/analysis`)).toBe(false);
        expect(byStage.has(`${id("blocked")}/analysis`)).toBe(false);
        // A retry whose backoff has not elapsed is not due yet.
        expect(byStage.has(`${id("notdue")}/analysis`)).toBe(false);
        // Nothing answered is ever handed out, whatever the status label.
        expect(work.every((w) => w.status !== "done")).toBe(true);
        // The settled fingerprint unblocks recording; analysis needs only the
        // file; embedding still waits for the analysis answer.
        expect(byStage.get(`${id("owed")}/recording`)?.status).toBe("pending");
        expect(byStage.get(`${id("owed")}/analysis`)?.status).toBe("pending");
        expect(byStage.has(`${id("owed")}/embedding`)).toBe(false);
    });

    it("returns one record per track per stage, and dispatching it does not re-create it", async () => {
        for (let i = 0; i < 6; i++) {
            await seedTrack(id(`t${i}`), { recording: "done", analysis: "pending", embedding: "pending" });
        }

        const first = await retryFailedAndBlocked(50);

        // One per track per stage: 6 tracks x 1 owed stage (recording is
        // done, analysis is owed, and embedding waits for the analysis).
        const keys = first.map((w) => `${w.trackId}/${w.stage}`);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys.filter((k) => k.endsWith("/analysis")).length).toBe(6);

        // The records it claimed are not handed out again; the rest wait for room.
        const claimed = await prisma.$queryRawUnsafe<Array<{ trackId: string }>>(
            `SELECT "trackId" FROM "TrackStage" WHERE stage = 'analysis' AND status = 'working' AND "trackId" LIKE $1`,
            `${id("t")}%`,
        );
        expect(claimed.length).toBeGreaterThan(0);
        const second = await getNextWork(50);
        const claimedIds = new Set(claimed.map((r) => r.trackId));
        expect(second.some((w) => w.stage === "analysis" && claimedIds.has(w.trackId))).toBe(false);
    });
});

// ── (b) Re-decide everything: re-opens answers, never re-runs AcoustID ──

describe("redecideEverything", () => {
    it("re-opens a `done` answer, but skips a track whose recordingMbid is already set", async () => {
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
        expect(reopened).toBeGreaterThan(0);

        // AcoustID guard: the identified track keeps its recording answer.
        expect((await stageRow(id("identified"), "recording"))?.status).toBe("done");
        // ...and it is not offered again.
        const owed = await getNextWork(50);
        expect(owed.some((w) => w.trackId === id("identified") && w.stage === "recording")).toBe(false);

        // Everything else is deliberately re-asked, `done` included.
        expect((await stageRow(id("unknown"), "recording"))?.status).toBe("pending");
        expect((await stageRow(id("unknown"), "analysis"))?.status).toBe("pending");
        expect((await stageRow(id("unknown"), "embedding"))?.status).toBe("pending");
    });

    it("does not delete embeddings", async () => {
        await seedTrack(id("keep"), {
            recording: "done", analysis: "done", embedding: "done",
            recordingMbid: "mbid-already-known",
        });
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
             VALUES ($1, $2::vector, 'laion-clap-music-onnx-v1', now())
             ON CONFLICT (track_id) DO NOTHING`,
            id("keep"), `[${Array.from({ length: 512 }, (_, i) => (i % 7) / 7).join(",")}]`,
        );

        await redecideEverything();

        // The embedding is an ANSWER. Re-deciding re-asks the question; it
        // does not delete the answer that is already in the table.
        const embeddings = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM track_embeddings WHERE track_id = $1`, id("keep"),
        );
        expect(Number(embeddings[0].n)).toBe(1);
    });

    it("does not reset every artist's enrichmentStatus", async () => {
        await seedTrack(id("keepartist"), { recording: "done", analysis: "done", embedding: "done" });
        await prisma.artist.update({
            where: { id: id("art") },
            data: { enrichmentStatus: "completed", summary: "A real biography", heroUrl: "/art/keep.jpg" },
        });

        await redecideEverything();

        const artist = await prisma.artist.findUnique({ where: { id: id("art") } });
        // Artist enrichment is not a per-track stage; re-deciding TRACKS must
        // not silently wipe the biography and image already fetched for it.
        expect(artist?.enrichmentStatus).toBe("completed");
        expect(artist?.summary).toBe("A real biography");
        expect(artist?.heroUrl).toBe("/art/keep.jpg");
    });
});

// ── (c) "Re-decide everything" is admin-only ────────────────────────────

describe("POST /enrichment/re-decide-everything", () => {
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
        app.use("/library", scanRouter);
    });

    it("answers 403 for a signed-in non-admin", async () => {
        const token = await makeUser(id("plain"), "user");
        const res = await request(app)
            .post("/enrichment/re-decide-everything")
            .set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("Admin access required");
    });

    it("answers 401 with no credential at all", async () => {
        const res = await request(app).post("/enrichment/re-decide-everything");
        expect(res.status).toBe(401);
    });

    it("answers 200 for an admin, and re-opens the stage records", async () => {
        const token = await makeUser(id("boss"), "admin");
        await seedTrack(id("redecide"), { recording: "done", analysis: "done", embedding: "done" });

        const res = await request(app)
            .post("/enrichment/re-decide-everything")
            .set("Authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.reopened).toBeGreaterThan(0);
        expect((await stageRow(id("redecide"), "analysis"))?.status).toBe("pending");
    });
});

// ── (d) Retry offers only owed work and wipes nothing ──────────────────

describe("retryFailedAndBlocked", () => {
    it("offers only owed work and wipes nothing", async () => {
        await seedTrack(id("answered"), {
            recording: "done", analysis: "done", embedding: "done",
        });
        // A fully answered track includes its fingerprint answer.
        await putStage(id("answered"), "fingerprint", "done", {});
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
             VALUES ($1, $2::vector, 'laion-clap-music-onnx-v1', now())
             ON CONFLICT (track_id) DO NOTHING`,
            id("answered"), `[${Array.from({ length: 512 }, (_, i) => (i % 7) / 7).join(",")}]`,
        );

        const work = await retryFailedAndBlocked(50);
        expect(work.filter((w) => w.trackId === id("answered")).length).toBe(0);

        // No `DELETE FROM track_embeddings`.
        const embeddings = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM track_embeddings WHERE track_id = $1`, id("answered"),
        );
        expect(Number(embeddings[0].n)).toBe(1);
    });
});

// ── (e) Corrupt tracks: clear the flag, never delete the row ────────────

describe("DELETE /library/corrupt-tracks", () => {
    it("clears the corrupt flag and keeps the Track row", async () => {
        const app = express();
        app.use(express.json());
        app.use("/library", scanRouter);

        await seedTrack(id("corrupt"), { analysis: "failed" });
        await prisma.track.update({ where: { id: id("corrupt") }, data: { corrupt: true } });

        const token = await makeAdmin(app);
        const res = await request(app)
            .delete("/library/corrupt-tracks")
            .set("Authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.deleted).toBeUndefined();

        // The file still exists and still needs an answer: deleting the row
        // would only make the scanner re-create it and re-ask from scratch.
        const stillThere = await prisma.track.findUnique({ where: { id: id("corrupt") } });
        expect(stillThere).not.toBeNull();
        expect(stillThere?.corrupt).toBe(false);
    });

    it("lists the true state: the corrupt track shows up before the clear and not after", async () => {
        const app = express();
        app.use(express.json());
        app.use("/library", scanRouter);

        await seedTrack(id("corrupt2"), { analysis: "failed" });
        await prisma.track.update({ where: { id: id("corrupt2") }, data: { corrupt: true } });
        const token = await makeAdmin(app);

        const before = await request(app)
            .get("/library/corrupt-tracks").set("Authorization", `Bearer ${token}`);
        expect(before.status).toBe(200);
        expect(before.body.count).toBeGreaterThanOrEqual(1);

        await request(app).delete("/library/corrupt-tracks").set("Authorization", `Bearer ${token}`);
        const after = await request(app)
            .get("/library/corrupt-tracks").set("Authorization", `Bearer ${token}`);
        expect(after.body.tracks.find((t: { id: string }) => t.id === id("corrupt2"))).toBeUndefined();
    });
});

// ── (f) Progress reads TrackStage for every stage ───────────────────────

describe("getEnrichmentProgress", () => {
    it("counts every stage off the stage records, not off the Track columns", async () => {
        const before = await getEnrichmentProgress();

        // A record that CONTRADICTS the column: the column says the analysis
        // landed, the record says the question was never asked. The record
        // owns the answer, so progress must follow the record.
        await seedTrack(id("contradict"), {
            recording: "pending", analysis: "pending", embedding: "pending",
            analysisStatus: "completed",
        });

        invalidateEnrichmentProgress();
        const after = await getEnrichmentProgress();

        // One more track exists and none of its three questions is answered,
        // so each stage gains exactly one owed row and no stage gains a
        // completed one — even though analysisStatus says 'completed'.
        expect(after.trackTags.total - before.trackTags.total).toBe(1);
        expect(after.trackTags.enriched).toBe(before.trackTags.enriched);
        expect(after.audioAnalysis.total - before.audioAnalysis.total).toBe(1);
        expect(after.audioAnalysis.completed).toBe(before.audioAnalysis.completed);
        expect(after.audioAnalysis.pending - before.audioAnalysis.pending).toBe(1);
        expect(after.clapEmbeddings.total - before.clapEmbeddings.total).toBe(1);
        expect(after.clapEmbeddings.completed).toBe(before.clapEmbeddings.completed);
    });

    it("reports a stage that is answered even when its column still says pending", async () => {
        const before = await getEnrichmentProgress();

        // The mirror image: the record is answered, the column was never
        // updated. Counting the column would under-report the answer.
        await seedTrack(id("answered-but-stale"), {
            recording: "done", analysis: "done", embedding: "done",
            analysisStatus: "pending",
        });

        invalidateEnrichmentProgress();
        const after = await getEnrichmentProgress();

        expect(after.trackTags.enriched - before.trackTags.enriched).toBe(1);
        expect(after.audioAnalysis.completed - before.audioAnalysis.completed).toBe(1);
        expect(after.clapEmbeddings.completed - before.clapEmbeddings.completed).toBe(1);
    });
});

// Helper shared by the route blocks: an admin user + token, created fresh.
let adminToken: string | null = null;
async function makeAdmin(_app: express.Express): Promise<string> {
    if (adminToken) return adminToken;
    await prisma.user.create({
        data: { id: id("route_admin"), username: id("route_admin"), passwordHash: "x", role: "admin", tokenVersion: 0 },
    });
    adminToken = generateToken({
        id: id("route_admin"), username: id("route_admin"), role: "admin", tokenVersion: 0,
    });
    return adminToken;
}