/**
 * Enrichment progress counts each stage from `TrackStage`, joined from `Track`
 * so a missing record counts as owed. Seeded records contradict the Track
 * columns both ways, and progress follows the records.
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
    identifyTrackByAcoustid: jest.fn().mockResolvedValue({ kind: "absent", evidence: { mocked: true } }),
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

import { prisma } from "../../utils/db";
import { PROBE_ID } from "../../services/matching/state";
import { buildMoods } from "../../services/moods/state";
import {
    closeOrphanedDependents,
    getEnrichmentProgress,
    invalidateEnrichmentProgress,
} from "../../workers/unifiedEnrichment";

const PREFIX = "prog";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedLibrary(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Prog Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Prog Album", primaryType: "Album" },
    });
}

async function putStage(
    trackId: string,
    stage: string,
    status: string,
    opts: { retryable?: boolean; failureClass?: string } = {},
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
        status === "done" ? null : opts.failureClass ?? "INCONCLUSIVE",
        opts.retryable ?? true, null,
        JSON.stringify({ probe: "ffmpeg -i", rc: 1 }),
    );
}

async function seedTrack(
    trackId: string,
    data: Partial<{
        recording: string; analysis: string; embedding: string;
        analysisStatus: string;
    }> = {},
    opts: { missing?: boolean } = {},
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
            analysisStatus: (data.analysisStatus ?? "pending") as never,
            analysisRetryCount: 0,
            missingSince: opts.missing ? new Date() : null,
        } as never,
    });
    await putStage(trackId, "recording", data.recording ?? "pending");
    await putStage(trackId, "analysis", data.analysis ?? "pending");
    await putStage(trackId, "embedding", data.embedding ?? "pending");
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "track_embeddings" WHERE track_id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${PREFIX}_%`);
}

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await seedLibrary();
    invalidateEnrichmentProgress();
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

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

        // One more track exists and none of its three questions is
        // answered, so each stage gains exactly one owed row and no stage
        // gains a completed one — even though analysisStatus says
        // 'completed'.
        expect(after.trackTags.total - before.trackTags.total).toBe(1);
        expect(after.trackTags.enriched).toBe(before.trackTags.enriched);
        expect(after.audioAnalysis.total - before.audioAnalysis.total).toBe(1);
        expect(after.audioAnalysis.completed).toBe(before.audioAnalysis.completed);
        expect(after.audioAnalysis.pending - before.audioAnalysis.pending).toBe(1);
        expect(after.clapEmbeddings.total - before.clapEmbeddings.total).toBe(1);
        expect(after.clapEmbeddings.completed).toBe(before.clapEmbeddings.completed);
    });

    it("reports a stage as answered even when its column still says pending", async () => {
        const before = await getEnrichmentProgress();

        // The mirror image: the record is answered, the column was never
        // updated. Counting the column would under-report the answer.
        await seedTrack(id("stale"), {
            recording: "done", analysis: "done", embedding: "done",
            analysisStatus: "pending",
        });

        invalidateEnrichmentProgress();
        const after = await getEnrichmentProgress();

        expect(after.trackTags.enriched - before.trackTags.enriched).toBe(1);
        expect(after.audioAnalysis.completed - before.audioAnalysis.completed).toBe(1);
        expect(after.clapEmbeddings.completed - before.clapEmbeddings.completed).toBe(1);
    });

    it("splits retryable and terminal failures per stage from the records", async () => {
        const before = await getEnrichmentProgress();

        // Mixed states across every stage: one track with a retryable
        // analysis failure and a terminal recording failure, one with
        // everything answered.
        await seedTrack(id("mixed"), { recording: "failed", analysis: "failed", embedding: "pending" });
        await putStage(id("mixed"), "recording", "failed", { retryable: false });

        invalidateEnrichmentProgress();
        const after = await getEnrichmentProgress();

        // The terminal recording failure is NOT counted as pending — we
        // know this file's answer; it waits for a human, not a re-ask.
        expect(after.trackTags.pending - before.trackTags.pending).toBe(0);
        expect(after.trackTags.progress).toBe(0); // 0 answered of >=1 total
        // The retryable analysis failure is counted as failed, not pending.
        expect(after.audioAnalysis.failed - before.audioAnalysis.failed).toBe(1);
        expect(after.audioAnalysis.pending - before.audioAnalysis.pending).toBe(0);
        // Embedding is genuinely never asked — pending, not failed.
        expect(after.clapEmbeddings.pending - before.clapEmbeddings.pending).toBe(1);
        // And the terminal recording failure shows as permanently failed.
        expect(after.audioAnalysis.permanentlyFailed).toBe(before.audioAnalysis.permanentlyFailed);
    });

    it("declares TrackStage as the source of every number", async () => {
        invalidateEnrichmentProgress();
        const progress = await getEnrichmentProgress();
        expect(progress.source).toBe("TrackStage");
    });

    it("holds a flagged-missing file's questions as waitingMissing, not as owed work", async () => {
        const before = await getEnrichmentProgress();

        // A file the scan found missing closes as FILE_MISSING: it counts as
        // waitingMissing, not owed work and not a failure.
        await seedTrack(
            id("vanished"),
            { recording: "done", analysis: "done", embedding: "failed" },
            { missing: true },
        );
        await putStage(id("vanished"), "embedding", "failed", {
            retryable: false, failureClass: "FILE_MISSING",
        });

        invalidateEnrichmentProgress();
        const after = await getEnrichmentProgress();

        expect(after.clapEmbeddings.pending).toBe(before.clapEmbeddings.pending);
        expect(after.clapEmbeddings.failed).toBe(before.clapEmbeddings.failed);
        expect(after.clapEmbeddings.waitingMissing - before.clapEmbeddings.waitingMissing).toBe(1);
        // Answered stages gain nothing, missing or not.
        expect(after.trackTags.waitingMissing).toBe(before.trackTags.waitingMissing);
        expect(after.audioAnalysis.waitingMissing).toBe(before.audioAnalysis.waitingMissing);
    });

    it("lets the library reach fully-complete when the only open questions are missing files", async () => {
        // Every answerable question is answered and the only open ones belong
        // to files the scan flagged missing, which are closed, so nothing is owed.
        await seedTrack(
            id("ghostonly"),
            { recording: "done", analysis: "done", embedding: "failed" },
            { missing: true },
        );
        await putStage(id("ghostonly"), "embedding", "failed", {
            retryable: false, failureClass: "FILE_MISSING",
        });
        await putStage(id("ghostonly"), "fingerprint", "done");
        await prisma.artist.update({
            where: { id: id("art") },
            data: { enrichmentStatus: "completed" as never },
        });

        invalidateEnrichmentProgress();
        const progress = await getEnrichmentProgress();

        expect(progress.clapEmbeddings.pending).toBe(0);
        expect(progress.clapEmbeddings.waitingMissing).toBe(1);
        expect(progress.isFullyComplete).toBe(true);
    });

    async function settledLibrary(trackId: string): Promise<void> {
        await seedTrack(trackId, { recording: "done", analysis: "done", embedding: "done" });
        await putStage(trackId, "fingerprint", "done");
        await prisma.artist.update({ where: { id: id("art") }, data: { enrichmentStatus: "completed" as never } });
    }

    it("is not complete while an identification answer is still due a retry or in flight", async () => {
        await settledLibrary(id("retrying"));
        await putStage(id("retrying"), "recording", "failed", { retryable: true });
        invalidateEnrichmentProgress();
        let progress = await getEnrichmentProgress();
        expect(progress.coreComplete).toBe(false);
        expect(progress.isFullyComplete).toBe(false);

        await putStage(id("retrying"), "recording", "working");
        invalidateEnrichmentProgress();
        progress = await getEnrichmentProgress();
        expect(progress.coreComplete).toBe(false);
        expect(progress.isFullyComplete).toBe(false);
    });

    it("is not complete while an artist with albums is due a retry; an artist with none is not owed", async () => {
        await settledLibrary(id("artistdue"));
        await prisma.artist.create({ data: { id: id("loner"), name: "No Albums", identityKey: id("l") } });
        invalidateEnrichmentProgress();
        expect((await getEnrichmentProgress()).isFullyComplete).toBe(true);

        await prisma.artist.update({ where: { id: id("art") }, data: { enrichmentStatus: "failed" as never } });
        invalidateEnrichmentProgress();
        const progress = await getEnrichmentProgress();
        expect(progress.artists.owed).toBe(1);
        expect(progress.coreComplete).toBe(false);
    });

    it("holds fully-complete until every sound vector has current mood scores", async () => {
        await settledLibrary(id("moody"));
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
             VALUES ($1, $2::vector, 'laion-clap-music-onnx-v1', now())`,
            id("moody"), `[${Array.from({ length: 512 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`,
        );
        // The similarity step is done with it, so only the moods are owed.
        await prisma.$executeRawUnsafe(
            `INSERT INTO matching_feel (track_id, embedded_at, probe, valence, arousal)
             SELECT track_id, analyzed_at, $2, 0.5, 0.5 FROM track_embeddings WHERE track_id = $1`,
            id("moody"), PROBE_ID,
        );
        await prisma.$executeRawUnsafe(
            `INSERT INTO matching_map (track_id, embedded_at, x, y, z, colour, laid_out)
             SELECT track_id, analyzed_at, 0, 0, 0, 0.5, true FROM track_embeddings WHERE track_id = $1`,
            id("moody"),
        );
        invalidateEnrichmentProgress();
        let progress = await getEnrichmentProgress();
        expect(progress.similarity).toMatchObject({ total: 1, completed: 1 });
        expect(progress.moods).toMatchObject({ total: 1, completed: 0, pending: 1, progress: 0 });
        expect(progress.isFullyComplete).toBe(false);

        await buildMoods();
        invalidateEnrichmentProgress();
        progress = await getEnrichmentProgress();
        expect(progress.moods).toMatchObject({ total: 1, completed: 1, pending: 0, progress: 100 });
        expect(progress.isFullyComplete).toBe(true);
    });

    it("counts a record a person set aside as closed, and closes what needed its answer", async () => {
        await settledLibrary(id("dismissed"));
        await putStage(id("dismissed"), "analysis", "blocked", { retryable: false });
        await putStage(id("dismissed"), "embedding", "pending");
        await closeOrphanedDependents();
        invalidateEnrichmentProgress();
        const progress = await getEnrichmentProgress();

        expect(progress.audioAnalysis.pending).toBe(0);
        expect(progress.clapEmbeddings.pending).toBe(0);
        const embedding = await prisma.trackStage.findUnique({
            where: { trackId_stage: { trackId: id("dismissed"), stage: "embedding" } },
        });
        expect(embedding?.lastErrorCode).toBe("DEPENDENCY_CLOSED");
        expect(progress.isFullyComplete).toBe(true);
    });
});
