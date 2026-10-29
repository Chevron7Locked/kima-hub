/**
 * Recording waits on the fingerprint question through PREREQUISITE_STAGE. Once
 * it is done, AcoustID reuses the stored fingerprint; once it closes as
 * permanent, AcoustID is skipped and the skip recorded. A fingerprint that lands
 * later reopens the recording that could not ask AcoustID. Real test database.
 */

// ── Queues + Redis + network services: observe, never hit the wire ──────

jest.mock("../../workers/enrichmentQueues", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentQueuesMock);
jest.mock("ioredis", () => require("../../__tests__/helpers/enrichmentMocks").ioredisMock);
jest.mock("../../config", () => require("../../__tests__/helpers/enrichmentMocks").configMock);
jest.mock("../../utils/logger", () => require("../../__tests__/helpers/enrichmentMocks").loggerMock);
jest.mock("../../services/enrichmentState", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentStateMock);
jest.mock("../../services/enrichmentFailureService", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentFailureServiceMock);
jest.mock("../../services/featureDetection", () => require("../../__tests__/helpers/enrichmentMocks").featureDetectionMock);
jest.mock("../../services/trackIdentity", () => require("../../__tests__/helpers/enrichmentMocks").trackIdentityMock);
jest.mock("../../services/sourcePauseController", () => require("../../__tests__/helpers/enrichmentMocks").sourcePauseControllerMock);
jest.mock("../../workers/audioCompletionSubscriber", () => require("../../__tests__/helpers/enrichmentMocks").audioCompletionSubscriberMock);
jest.mock("../../workers/artistEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").artistEnrichmentWorkerMock);
jest.mock("../../workers/trackEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").trackEnrichmentWorkerMock);
jest.mock("../../workers/podcastEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").podcastEnrichmentWorkerMock);

// NOTE: `../../utils/db` is deliberately NOT mocked — the gate must be
// proven against the real TrackStage table the migration creates.

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
    // The real write: the fingerprint stage stores what fpcalc answered.
    persistAcoustidFingerprint: (trackId: string, fingerprint: string) =>
        jest.requireActual("../../services/acoustidIdentification").persistAcoustidFingerprint(trackId, fingerprint),
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

import { putStage as seedStage, type PutStageOptions, deleteSeededRows, seedArtistAndAlbum } from "../../__tests__/helpers/trackStage";
import { mockQueueAdd } from "../../__tests__/helpers/enrichmentMocks";
import { prisma } from "../../utils/db";
import {
    enrichSingleTrack,
    getNextWork,
    retryFailedAndBlocked,
    redecideEverything,
    waitForFingerprintWork,
    executeFingerprintPhase,
    invalidateEnrichmentProgress,
    getEnrichmentProgress,
} from "../../workers/unifiedEnrichment";
import { fpcalcService } from "../../services/fpcalc";
import {
    identifyTrackByAcoustid,
} from "../../services/acoustidIdentification";

const PREFIX = "fpg";
const id = (n: string) => `${PREFIX}_${n}`;

const putStage = (trackId: string, stage: string, status: string, opts: PutStageOptions = {}) =>
    seedStage(trackId, stage, status, {
        source: stage === "recording" ? "musicbrainz" : "analyzer",
        ...opts,
    });

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
    await deleteSeededRows(PREFIX);
}

beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(mockQueueAdd).mockResolvedValue({ id: "job-1" } as never);
    jest.mocked(identifyTrackByAcoustid).mockResolvedValue({
        kind: "permanent",
        error: { code: "NO_FINGERPRINT", message: "mocked: no fingerprint" },
    });
    await wipe();
    await seedArtistAndAlbum(PREFIX, "Gate");
    invalidateEnrichmentProgress();
});

afterAll(async () => {
    await waitForFingerprintWork();
    await wipe();
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

describe("only the fingerprint → recording edge settles on a closed failure; embedding waits for a done analysis", () => {
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

describe("a fingerprint that lands reopens the recording that could not ask AcoustID", () => {
    const { enrichmentFailureService: realFailures } = jest.requireActual<
        typeof import("../../services/enrichmentFailureService")
    >("../../services/enrichmentFailureService");

    /** A track whose fingerprint failed for good, its recording closed through the real path. */
    async function closedWithoutAcoustid(trackId: string): Promise<void> {
        await seedTrack(trackId, { recording: "pending" });
        await putStage(trackId, "fingerprint", "failed", { retryable: false, nextRetryAt: null });
        jest.mocked(identifyTrackByAcoustid).mockResolvedValue({ kind: "absent", evidence: {} });
        expect(await enrichSingleTrack(trackId)).toBe("no_match");
        const recording = await stageRow(trackId, "recording");
        expect(recording?.status).toBe("done");
        expect(recording?.evidence?.["acoustid"]).toBe("not asked: the file's fingerprint question closed");
    }

    it("the failures screen's fingerprint retry: once fpcalc answers, the recording asks AcoustID", async () => {
        await closedWithoutAcoustid(id("rfs"));
        // A no-match that did ask AcoustID is a different answer and stays closed.
        await seedTrack(id("asked"), { recording: "done", fingerprint: "done", acoustidFingerprint: "AQSEE_ASKED" });

        expect(await realFailures.retryStageFailures([`${id("rfs")}__fingerprint`])).toBe(1);
        // Still closed while the fingerprint is being asked again.
        expect((await stageRow(id("rfs"), "recording"))?.status).toBe("done");

        await executeFingerprintPhase();
        await waitForFingerprintWork();

        expect((await stageRow(id("rfs"), "fingerprint"))?.status).toBe("done");
        expect((await prisma.track.findUnique({ where: { id: id("rfs") } }))?.acoustidFingerprint).toBe("AQSEEFPFPCALC");
        expect((await stageRow(id("rfs"), "recording"))?.status).toBe("pending");
        const work = await getNextWork(50);
        expect(work.some((w) => w.trackId === id("rfs") && w.stage === "recording")).toBe(true);
        expect(work.some((w) => w.trackId === id("asked") && w.stage === "recording")).toBe(false);

        // Asked this time, with the new fingerprint.
        jest.mocked(identifyTrackByAcoustid).mockClear();
        await enrichSingleTrack(id("rfs"));
        expect(identifyTrackByAcoustid).toHaveBeenCalledTimes(1);
        const [, , stored] = jest.mocked(identifyTrackByAcoustid).mock.calls[0];
        expect(stored).toEqual({ fingerprint: "AQSEEFPFPCALC" });
    });

    it("re-decide everything: both reopen, and the recording waits for the fingerprint to settle again", async () => {
        await closedWithoutAcoustid(id("redec"));

        await redecideEverything();

        expect((await stageRow(id("redec"), "fingerprint"))?.status).toBe("pending");
        expect((await stageRow(id("redec"), "recording"))?.status).toBe("pending");
        // Open but blocked: no MusicBrainz searches per cycle while the fingerprint is re-asked.
        const work = await getNextWork(50);
        expect(work.some((w) => w.trackId === id("redec") && w.stage === "recording")).toBe(false);
    });

    it("retry failed and blocked leaves it closed: its fingerprint failed for good and is not retried", async () => {
        await closedWithoutAcoustid(id("nofp"));

        const work = await retryFailedAndBlocked(50);

        expect(work.some((w) => w.trackId === id("nofp") && (w.stage === "recording" || w.stage === "fingerprint"))).toBe(false);
        expect((await stageRow(id("nofp"), "recording"))?.status).toBe("done");
        expect((await stageRow(id("nofp"), "fingerprint"))?.status).toBe("failed");
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
});
