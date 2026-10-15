/**
 * Recording waits on the fingerprint question through PREREQUISITE_STAGE. Once
 * it is done, AcoustID reuses the stored fingerprint; once it closes as
 * permanent, AcoustID is skipped and the skip recorded. Reopening the
 * fingerprint reopens recordings that never ran AcoustID. Real test database.
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

// NOTE: `../../utils/db` is deliberately NOT mocked — the gate must be
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
        identifyRecording: jest.fn().mockResolvedValue({ kind: "absent", evidence: { mocked: true } }),
        lookupRecordingsByIsrc: jest.fn().mockResolvedValue({ kind: "absent", evidence: { mocked: true } }),
        getRecordingGenres: jest.fn().mockResolvedValue({ kind: "absent", evidence: { mocked: true } }),
        getRecordingIsrcAndGenres: jest.fn().mockResolvedValue({
            isrc: { kind: "absent", evidence: { mocked: true } },
            genres: { kind: "absent", evidence: { mocked: true } },
        }),
        getAlbumCatalogue: jest.fn().mockResolvedValue({ kind: "absent", evidence: { mocked: true } }),
    },
}));

// enrichSingleTrack IS called here, so the mock must cover every identity
// entry point it reaches — including the tag reader. The jest.fn lives IN
// the factory (jest hoists it above any const), so call tracking works.
jest.mock("../../services/acoustidIdentification", () => ({
    prefetchAcoustidReplies: jest.fn().mockResolvedValue(0),
    identifyTrackByAcoustid: jest.fn().mockResolvedValue({
        kind: "permanent",
        error: { code: "NO_FINGERPRINT", message: "mocked: no fingerprint" },
    }),
    persistAcoustidFingerprint: jest.fn().mockResolvedValue(undefined),
    readIdentityTags: jest.fn().mockResolvedValue(null),
}));

// fpcalc must never be reached from the recording stage: the recording
// stage's AcoustID step consumes the fingerprint stage's STORED answer.
jest.mock("../../services/fpcalc", () => ({
    fpcalcService: {
        fingerprintFile: jest.fn()
            .mockResolvedValue({ fingerprint: "AQSEEFPFPCALC", duration: 180 }),
    },
}));

// Let the (mocked) fingerprint stage resolve the seeded /tmp paths.
jest.mock("../../routes/library/trackPath", () => ({
    resolveWithinMusicRoot: (p: string) => p,
}));

jest.mock("../../services/sourcePauseController", () => ({
    sourcePauseController: {
        isPaused: jest.fn().mockResolvedValue(false),
        open: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        // recordStageFailure consults the pause controller on every failure;
        // nothing in this spec is source-caused.
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
    enrichSingleTrack,
    getNextWork,
    retryFailedAndBlocked,
    redecideEverything,
    waitForFingerprintWork,
    invalidateEnrichmentProgress,
    getEnrichmentProgress,
} from "../../workers/unifiedEnrichment";
import { fpcalcService } from "../../services/fpcalc";
import {
    identifyTrackByAcoustid,
} from "../../services/acoustidIdentification";

const PREFIX = "fpg";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedLibrary(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Gate Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Gate Album", primaryType: "Album" },
    });
}

async function putStage(
    trackId: string,
    stage: string,
    status: string,
    opts: {
        retryable?: boolean;
        nextRetryAt?: Date | null;
        evidence?: Record<string, unknown>;
    } = {},
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
        stage === "recording" ? "musicbrainz" : "analyzer", 0,
        status === "done" ? null : "TEST_SEED",
        status === "done" ? null : "seeded by test",
        status === "done" ? null : "INCONCLUSIVE",
        opts.retryable ?? true, opts.nextRetryAt ?? null,
        JSON.stringify(opts.evidence ?? { probe: "ffmpeg -i", rc: 1 }),
    );
}

async function seedTrack(
    trackId: string,
    data: Partial<{
        recording: string; analysis: string; embedding: string; fingerprint: string;
        recordingMbid: string | null; acoustidFingerprint: string | null;
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
            acoustidFingerprint: data.acoustidFingerprint ?? null,
            analysisStatus: "pending" as never,
            analysisRetryCount: 0,
        } as never,
    });
    await putStage(trackId, "recording", data.recording ?? "pending");
    await putStage(trackId, "analysis", data.analysis ?? "pending");
    await putStage(trackId, "embedding", data.embedding ?? "pending");
    if (data.fingerprint) await putStage(trackId, "fingerprint", data.fingerprint);
}

async function stageRow(trackId: string, stage: string) {
    const rows = await prisma.$queryRawUnsafe<
        Array<{
            status: string;
            retryable: boolean;
            nextRetryAt: Date | null;
            evidence: Record<string, unknown> | null;
        }>
    >(
        `SELECT status, retryable, "nextRetryAt", evidence
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
}

beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(mockQueueAdd).mockResolvedValue({ id: "job-1" } as never);
    jest.mocked(identifyTrackByAcoustid).mockResolvedValue({
        kind: "permanent",
        error: { code: "NO_FINGERPRINT", message: "mocked: no fingerprint" },
    });
    await wipe();
    await seedLibrary();
    invalidateEnrichmentProgress();
});

afterAll(async () => {
    await waitForFingerprintWork();
    await wipe();
    await prisma.$disconnect();
});

describe("the fingerprint → recording edge is a gate, not a poll", () => {
    it("does not offer the recording stage while the fingerprint question is open", async () => {
        await seedTrack(id("waiting"), { recording: "pending", fingerprint: "pending" });

        const work = await getNextWork(50);
        const forTrack = work.filter((w) => w.trackId === id("waiting"));

        // The fingerprint sweep still asks its own question...
        expect(forTrack.some((w) => w.stage === "fingerprint")).toBe(true);
        // ...but the recording stage waits for that answer instead of
        // re-reading tags and re-searching MusicBrainz every cycle.
        expect(forTrack.some((w) => w.stage === "recording")).toBe(false);
    });

    it("offers the recording stage once the fingerprint is done, reusing the stored fingerprint with no fpcalc run", async () => {
        await seedTrack(id("ready"), {
            recording: "pending",
            fingerprint: "done",
            acoustidFingerprint: "AQSEE_STORED",
        });

        const work = await getNextWork(50);
        expect(work.some((w) => w.trackId === id("ready") && w.stage === "recording")).toBe(true);

        jest.mocked(identifyTrackByAcoustid).mockResolvedValue({
            kind: "answered",
            value: {
                source: "acoustid",
                fingerprintFrom: "stored",
                recordingMbid: "mbid-from-acoustid",
            },
            evidence: { score: 0.9 },
        });

        const outcome = await enrichSingleTrack(id("ready"));
        expect(outcome).toBe("identified");

        // The AcoustID step consumed the fingerprint the fingerprint stage
        // already stored — it never recomputed one.
        expect(identifyTrackByAcoustid).toHaveBeenCalledTimes(1);
        const [, , stored] = jest.mocked(identifyTrackByAcoustid).mock.calls[0];
        expect(stored).toEqual({ fingerprint: "AQSEE_STORED" });
        expect(fpcalcService.fingerprintFile).not.toHaveBeenCalled();

        const row = await stageRow(id("ready"), "recording");
        expect(row?.status).toBe("done");
        expect(row?.evidence?.["recordingMbid"]).toBe("mbid-from-acoustid");
        expect(
            (await prisma.track.findUnique({ where: { id: id("ready") } }))?.recordingMbid,
        ).toBe("mbid-from-acoustid");

        // Answered — not owed again: the next sweep hands the recording
        // stage out no more (the track's own analysis question is a
        // different, prerequisite-free stage and may well be due).
        const next = await getNextWork(50);
        expect(
            next.some((w) => w.trackId === id("ready") && w.stage === "recording"),
        ).toBe(false);
    });

    it("offers the recording stage once the fingerprint closed as a permanent failure — AcoustID skipped, the skip recorded, no re-offer loop", async () => {
        await seedTrack(id("stuck"), { recording: "pending" });
        await putStage(id("stuck"), "fingerprint", "failed", {
            retryable: false,
            nextRetryAt: null,
            evidence: { paths: ["fpcalc"], error: "fpcalc exit 1: file damaged" },
        });

        // The fingerprint question is settled (answered failed, permanently),
        // so the recording stage may finally run.
        const work = await getNextWork(50);
        expect(work.some((w) => w.trackId === id("stuck") && w.stage === "recording")).toBe(true);

        // If this is ever called, the gate leaked an unanswerable lookup.
        jest.mocked(identifyTrackByAcoustid).mockResolvedValue({
            kind: "absent",
            evidence: { reason: "mocked: nothing to match" },
        });

        const outcome = await enrichSingleTrack(id("stuck"));
        expect(outcome).toBe("no_match");
        expect(identifyTrackByAcoustid).not.toHaveBeenCalled();
        expect(fpcalcService.fingerprintFile).not.toHaveBeenCalled();

        // Every source that can be asked said "nothing"; AcoustID cannot be asked
        // about a file whose fingerprint question closed for good. The question
        // closes as answered, saying so, and is not offered again (a changed file
        // reopens it).
        const row = await stageRow(id("stuck"), "recording");
        expect(row?.status).toBe("done");
        expect(row?.evidence?.["acoustid"]).toBe("not asked: the file's fingerprint question closed");
        expect(row?.nextRetryAt).toBeNull();
        const next = await getNextWork(50);
        expect(next.some((w) => w.trackId === id("stuck") && w.stage === "recording")).toBe(false);
    });
});

describe("only the fingerprint → recording edge settles on a closed failure", () => {
    it("embedding still waits for a DONE analysis, not a closed analysis failure", async () => {
        await seedTrack(id("closed"), { analysis: "failed", embedding: "pending" });
        await putStage(id("closed"), "analysis", "failed", { retryable: false, nextRetryAt: null });

        // analysis → embedding is an "output" edge: the blender READS the
        // valence/arousal, and a closed failure wrote none. A settled
        // question is not a usable output.
        let work = await getNextWork(50);
        expect(work.some((w) => w.trackId === id("closed") && w.stage === "embedding")).toBe(false);

        await putStage(id("closed"), "analysis", "done");
        work = await getNextWork(50);
        expect(work.some((w) => w.trackId === id("closed") && w.stage === "embedding")).toBe(true);
    });
});

describe("re-opening the fingerprint stage re-opens the no-match-without-AcoustID recordings", () => {
    it("re-decide everything: re-opens both, and the recording waits for the fingerprint to settle again", async () => {
        await seedTrack(id("redec"), { recording: "failed" });
        await putStage(id("redec"), "recording", "failed", {
            retryable: false,
            nextRetryAt: null,
            evidence: { acoustid: "skipped", error: 'No recording identified for "Track …"' },
        });
        await putStage(id("redec"), "fingerprint", "failed", { retryable: false, nextRetryAt: null });

        await redecideEverything();

        expect((await stageRow(id("redec"), "fingerprint"))?.status).toBe("pending");
        expect((await stageRow(id("redec"), "recording"))?.status).toBe("pending");

        // The recording question is open but BLOCKED again, not owed: while
        // the fingerprint is being re-asked the recording stage must not
        // burn MusicBrainz searches per cycle.
        let work = await getNextWork(50);
        expect(work.some((w) => w.trackId === id("redec") && w.stage === "recording")).toBe(false);

        // Once the re-asked fingerprint settles, the recording stage runs —
        // and can finally use the fingerprint it was waiting for.
        await putStage(id("redec"), "fingerprint", "done");
        await prisma.track.update({
            where: { id: id("redec") },
            data: { acoustidFingerprint: "AQSEE_REDECIDED" },
        });
        work = await getNextWork(50);
        expect(work.some((w) => w.trackId === id("redec") && w.stage === "recording")).toBe(true);
    });

    it("retry failed and blocked: a due fingerprint retry re-opens the recording that never asked AcoustID", async () => {
        // Fingerprint failed transiently and its backoff has elapsed — the
        // retry control hands it out again.
        await seedTrack(id("rfb"), { recording: "failed" });
        await putStage(id("rfb"), "recording", "failed", {
            retryable: false,
            nextRetryAt: null,
            evidence: { acoustid: "skipped", error: 'No recording identified for "Track …"' },
        });
        await putStage(id("rfb"), "fingerprint", "failed", {
            retryable: true,
            nextRetryAt: new Date(Date.now() - 60_000),
        });
        // A recording whose no-match DID run AcoustID (the fingerprint
        // existed, the lookup missed) is a different answer: it does not get
        // re-opened by the fingerprint retry.
        await seedTrack(id("asked"), { recording: "failed" });
        await putStage(id("asked"), "recording", "failed", {
            retryable: false,
            nextRetryAt: null,
            evidence: { paths: ["mb-search", "acoustid"], error: "No recording identified" },
        });
        await putStage(id("asked"), "fingerprint", "done");
        await prisma.track.update({
            where: { id: id("asked") },
            data: { acoustidFingerprint: "AQSEE_ASKED" },
        });

        const work = await retryFailedAndBlocked(50);
        expect(work.some((w) => w.trackId === id("rfb") && w.stage === "fingerprint")).toBe(true);

        // The recording that never asked AcoustID is re-opened alongside the
        // fingerprint question, so it can use the new fingerprint once the
        // retry lands. It is NOT offered yet — the fingerprint is still open.
        expect((await stageRow(id("rfb"), "recording"))?.status).toBe("pending");
        let next = await getNextWork(50);
        expect(next.some((w) => w.trackId === id("rfb") && w.stage === "recording")).toBe(false);

        // The no-match that DID ask AcoustID stays closed.
        expect((await stageRow(id("asked"), "recording"))?.status).toBe("failed");
        expect((await stageRow(id("asked"), "recording"))?.retryable).toBe(false);

        // When the retried fingerprint lands, the re-opened recording is due.
        await waitForFingerprintWork();
        await putStage(id("rfb"), "fingerprint", "done");
        await prisma.track.update({
            where: { id: id("rfb") },
            data: { acoustidFingerprint: "AQSEE_RETRIED" },
        });
        next = await getNextWork(50);
        expect(next.some((w) => w.trackId === id("rfb") && w.stage === "recording")).toBe(true);
    });
});

describe("progress: a recording stage parked on an unsettled fingerprint is waiting, not pending work", () => {
    it("counts it under trackTags.waiting and keeps it out of trackTags.pending", async () => {
        // Blocked: the fingerprint question is open.
        await seedTrack(id("blocked"), { recording: "pending", fingerprint: "pending" });
        // Actionable: the fingerprint answered, the recording question is due.
        await seedTrack(id("due"), { recording: "pending", fingerprint: "done" });

        invalidateEnrichmentProgress();
        const progress = await getEnrichmentProgress();

        expect(progress.trackTags.pending).toBe(1);
        expect(progress.trackTags.waiting).toBe(1);
        // Core completion must not be declared while a question is parked.
        expect(progress.coreComplete).toBe(false);
    });

    it("retry failed and blocked: leaves closed a recording whose fingerprint failed for good", async () => {
        // No fingerprint can ever arrive, so asking again would skip AcoustID and
        // close the record exactly as before.
        await seedTrack(id("nofp"), { recording: "failed" });
        await putStage(id("nofp"), "recording", "failed", {
            retryable: false,
            nextRetryAt: null,
            evidence: { acoustid: "skipped", error: 'No recording identified for "Track …"' },
        });
        await putStage(id("nofp"), "fingerprint", "failed", { retryable: false, nextRetryAt: null });

        await retryFailedAndBlocked(50);

        const recording = await stageRow(id("nofp"), "recording");
        expect(recording?.status).toBe("failed");
        expect(recording?.retryable).toBe(false);
    });
});
