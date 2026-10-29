/**
 * "Retry failed and blocked" hands out only owed questions: done, terminal and
 * blocked records stay put, and a retry not yet due waits. Dispatch claims the
 * record so the next sweep cannot hand it out twice. Real test database.
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

// NOTE: `../../utils/db` is deliberately NOT mocked — the queue path must be
// proven against the real TrackStage table the migration creates.

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
    identifyTrackByAcoustid: jest.fn().mockResolvedValue({ kind: "absent", evidence: { mocked: true } }),
    persistAcoustidFingerprint: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/sourcePauseController", () => ({
    sourcePauseController: {
        isPaused: jest.fn().mockResolvedValue(false),
        open: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        // recordStageFailure consults the pause controller on every failure
        // (rate-limited errors park a record instead of consuming an
        // attempt); a local fpcalc error is never source-caused.
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
    getNextWork,
    retryFailedAndBlocked,
} from "../../workers/unifiedEnrichment";

const PREFIX = "rfb";
const id = (n: string) => `${PREFIX}_${n}`;

/** Seed the FK chain `TrackStage.trackId` points at. */
async function seedLibrary(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "RfB Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "RfB Album", primaryType: "Album" },
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
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(mockQueueAdd).mockResolvedValue({ id: "job-1" } as never);
    jest.mocked(mockQueueGetJob).mockResolvedValue(null as never);
    jest.mocked(mockRedis.rpush).mockResolvedValue(1);
    await wipe();
    await seedLibrary();
});

afterAll(async () => {
    await waitForFingerprintWork();
    await wipe();
    await prisma.$disconnect();
});

describe("retryFailedAndBlocked — the queue-based path", () => {
    it("offers only the records that are genuinely due, and dispatching claims them", async () => {
        // A retryable failure whose backoff has elapsed — genuinely owed.
        await seedTrack(id("due"), {
            recording: "done", analysis: "failed",
            analysisRetryCount: 1,
        } as never);
        await putStage(id("due"), "analysis", "failed", {
            attempt: 1, retryable: true, nextRetryAt: new Date(Date.now() - 60_000),
        });
        // Parked for a human — a `blocked` answer is NOT re-offered by the
        // queue; only "Re-decide everything" may reopen it.
        await seedTrack(id("parked"), { recording: "done", analysis: "blocked" });
        // Terminal failure — closed until a human re-decides it.
        await seedTrack(id("terminal"), { recording: "done", analysis: "failed" });
        await putStage(id("terminal"), "analysis", "failed", { retryable: false });
        // Retry exists but its backoff has not elapsed.
        await seedTrack(id("notdue"), { recording: "done", analysis: "failed" });
        await putStage(id("notdue"), "analysis", "failed", {
            retryable: true, nextRetryAt: new Date(Date.now() + 60 * 60_000),
        });
        // Already answered — never re-asked by a retry control.
        await seedTrack(id("answered"), { recording: "done", analysis: "done", embedding: "done" });
        // A never-asked track with a done fingerprint: recording and analysis
        // are owed now, embedding waits for analysis.
        await seedTrack(id("fresh"), { recording: "pending", analysis: "pending", embedding: "pending" });
        await putStage(id("fresh"), "fingerprint", "done");

        const work = await retryFailedAndBlocked(50);
        const keys = new Set(work.map((w) => `${w.trackId}/${w.stage}`));

        // Only due rows are handed out: the elapsed retry, the fresh track's
        // recording and analysis, and every unanswered fingerprint.
        expect(keys).toEqual(new Set([
            `${id("due")}/analysis`,
            `${id("fresh")}/recording`,
            `${id("fresh")}/analysis`,
            ...[id("due"), id("parked"), id("terminal"), id("notdue"), id("answered")].map(
                (t) => `${t}/fingerprint`,
            ),
        ]));

        // The queue-based path: each stage's producer was called for its
        // owed rows — the analyzer feed gets the analysis job, the track
        // queue gets the recording job.
        expect(mockRedis.rpush).toHaveBeenCalledWith(
            "audio:analysis:queue",
            expect.stringContaining(`track-${id("due")}-analysis`),
        );
        expect(mockQueueAdd).toHaveBeenCalledWith(
            "enrich",
            { trackId: id("fresh"), trackTitle: `Track ${id("fresh")}` },
            // Per-offer jobId: first dispatch (attempt 1), no prior redelivery.
            { jobId: `track-${id("fresh")}-recording-1-r0` },
        );

        // Dispatching CLAIMS the records, so the next sweep is not handed
        // the same attempt again.
        expect((await stageRow(id("due"), "analysis"))?.status).toBe("working");
        expect((await stageRow(id("fresh"), "recording"))?.status).toBe("working");
        const next = await getNextWork(50);
        expect(next.filter((w) => w.trackId.startsWith(PREFIX)).length).toBe(0);

        // Nothing else was touched — no destructive reset happened:
        // the parked answer stays parked, the closed answer stays closed,
        // the answered questions stay answered.
        expect((await stageRow(id("parked"), "analysis"))?.status).toBe("blocked");
        expect((await stageRow(id("terminal"), "analysis"))?.status).toBe("failed");
        expect((await stageRow(id("terminal"), "analysis"))?.retryable).toBe(false);
        expect((await stageRow(id("notdue"), "analysis"))?.status).toBe("failed");
        expect((await stageRow(id("answered"), "analysis"))?.status).toBe("done");
        expect((await stageRow(id("answered"), "recording"))?.status).toBe("done");
        // The never-asked track's recording and analysis were both handed
        // out and claimed; embedding stays pending — an unanalysed track is
        // never embedded.
        expect((await stageRow(id("fresh"), "analysis"))?.status).toBe("working");
        expect((await stageRow(id("fresh"), "embedding"))?.status).toBe("pending");
    });

    it("hands out one record per track per stage and never re-creates it", async () => {
        for (let i = 0; i < 4; i++) {
            await seedTrack(id(`t${i}`), { recording: "done", analysis: "pending", embedding: "pending" });
        }

        const work = await retryFailedAndBlocked(50);
        const keys = work.map((w) => `${w.trackId}/${w.stage}`);
        expect(new Set(keys).size).toBe(keys.length);
        // 4 tracks x 1 owed stage: recording is answered, analysis is owed,
        // embedding waits for the analysis answer, and the prerequisite-free
        // fingerprint sweep is owed for every track.
        expect(keys.filter((k) => k.endsWith("/analysis"))).toHaveLength(4);
        expect(keys.filter((k) => k.endsWith("/embedding"))).toHaveLength(0);
        expect(keys.filter((k) => k.endsWith("/fingerprint"))).toHaveLength(4);
    });
});
