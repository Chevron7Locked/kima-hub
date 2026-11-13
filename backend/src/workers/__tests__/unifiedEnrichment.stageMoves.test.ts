/**
 * The scheduler changes a stage record only through the stage-record module: the claim it hands out, the columns that
 * show it, and the whole-library reopen. Real test database; queues and Redis are observed, never reached.
 */

jest.mock("../../workers/enrichmentQueues", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentQueuesMock);
jest.mock("ioredis", () => require("../../__tests__/helpers/enrichmentMocks").ioredisMock);
jest.mock("../../config", () => require("../../__tests__/helpers/enrichmentMocks").configMock);
jest.mock("../../utils/logger", () => require("../../__tests__/helpers/enrichmentMocks").loggerMock);
jest.mock("../../services/enrichmentState", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentStateMock);
jest.mock("../../services/enrichmentFailureService", () => require("../../__tests__/helpers/enrichmentMocks").enrichmentFailureServiceMock);
jest.mock("../../services/featureDetection", () => require("../../__tests__/helpers/enrichmentMocks").featureDetectionMock);
jest.mock("../../services/trackIdentity", () => require("../../__tests__/helpers/enrichmentMocks").trackIdentityMock);
jest.mock("../../services/musicbrainz", () => require("../../__tests__/helpers/enrichmentMocks").musicBrainzMock);
jest.mock("../../services/acoustidIdentification", () => require("../../__tests__/helpers/enrichmentMocks").acoustidIdentificationMock);
jest.mock("../../services/sourcePauseController", () => require("../../__tests__/helpers/enrichmentMocks").sourcePauseControllerMock);
jest.mock("../../workers/audioCompletionSubscriber", () => require("../../__tests__/helpers/enrichmentMocks").audioCompletionSubscriberMock);
jest.mock("../../workers/artistEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").artistEnrichmentWorkerMock);
jest.mock("../../workers/trackEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").trackEnrichmentWorkerMock);
jest.mock("../../workers/podcastEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").podcastEnrichmentWorkerMock);

import { mockQueueAdd, mockRedis } from "../../__tests__/helpers/enrichmentMocks";
import { prisma } from "../../utils/db";
import {
    executeAudioPhase,
    executeFingerprintPhase,
    executeVibePhase,
    reconcileStaleStageRecords,
    redecideEverything,
    waitForFingerprintWork,
} from "../unifiedEnrichment";
import * as stageRecords from "../../services/stages/stageRecords";

const PREFIX = "smv";
const id = (n: string) => `${PREFIX}_${n}`;
const T = id("t");

async function seedTrack(columns: Record<string, unknown> = {}): Promise<void> {
    await prisma.track.create({
        data: {
            id: T, albumId: id("alb"), title: "Stage Moves", trackNo: 1, duration: 180,
            filePath: `/tmp/${T}.flac`, fileModified: new Date(), fileSize: 1000,
            analysisStatus: "pending", ...columns,
        },
    });
}

async function put(stage: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
    await prisma.trackStage.create({
        data: { id: `${T}__${stage}`, trackId: T, stage, status, source: "test", attempt: 1, retryable: true, evidence: {}, ...extra },
    });
}

const columns = () =>
    prisma.track.findUniqueOrThrow({
        where: { id: T },
        select: { analysisStatus: true, vibeAnalysisStatus: true },
    });
const record = (stage: string) => prisma.trackStage.findUniqueOrThrow({ where: { trackId_stage: { trackId: T, stage } } });

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis.rpush.mockResolvedValue(1);
    mockQueueAdd.mockResolvedValue({ id: "job-1" });
    await wipe();
    await prisma.artist.create({ data: { id: id("art"), name: "Stage Moves", identityKey: id("a") } });
    await prisma.album.create({ data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Stage Moves", primaryType: "Album" } });
});

afterAll(wipe);

describe("a claim the scheduler hands out", () => {
    it("shows on the song's columns before the job is queued, and a fast report is not overwritten", async () => {
        await seedTrack();
        await put("analysis", "pending");
        let seenAtQueueing: string | null | undefined;
        mockRedis.rpush.mockImplementationOnce(async (_key: string, payload: string) => {
            seenAtQueueing = (await columns()).analysisStatus;
            // The analyzer answers before dispatch has returned.
            const { trackId, jobId } = JSON.parse(payload);
            await stageRecords.answer(trackId, "analysis", "analyzer", {}, jobId);
            return 1;
        });

        expect(await executeAudioPhase()).toBe(1);

        expect(seenAtQueueing).toBe("processing");
        expect((await record("analysis")).status).toBe("done");
        expect((await columns()).analysisStatus).toBe("completed");
    });

    it("does the same for an embedding", async () => {
        await seedTrack({ analysisStatus: "completed" });
        await put("analysis", "done");
        await put("embedding", "pending");
        let seenAtQueueing: string | null | undefined;
        mockQueueAdd.mockImplementationOnce(async (_name: string, data: { trackId: string }, opts: { jobId: string }) => {
            seenAtQueueing = (await columns()).vibeAnalysisStatus;
            await stageRecords.answer(data.trackId, "embedding", "clap", {}, opts.jobId);
            return { id: opts.jobId };
        });

        expect(await executeVibePhase()).toBe(1);

        expect(seenAtQueueing).toBe("processing");
        expect((await record("embedding")).status).toBe("done");
        expect((await columns()).vibeAnalysisStatus).toBe("completed");
    });

    it("is handed back when the job cannot be queued, and the columns say pending again", async () => {
        await seedTrack();
        await put("analysis", "pending");
        mockRedis.rpush.mockRejectedValueOnce(new Error("redis down"));

        expect(await executeAudioPhase()).toBe(0);

        const row = await record("analysis");
        expect(row.status).toBe("pending");
        expect(row.startedAt).toBeNull();
        expect((await columns()).analysisStatus).toBe("pending");
    });

    it("closes a record whose lease ran out for the last time, and the columns follow", async () => {
        await seedTrack({ analysisStatus: "processing" });
        await put("analysis", "working", {
            startedAt: new Date(Date.now() - 20 * 60_000),
            nextRetryAt: new Date(Date.now() - 5 * 60_000),
            redelivered: stageRecords.STAGE_REDELIVERY_CAP,
        });

        expect(await executeAudioPhase()).toBe(0);

        const row = await record("analysis");
        expect(row.status).toBe("failed");
        expect(row.retryable).toBe(false);
        expect(row.lastErrorCode).toBe("LOST_WORKER");
        expect((await columns()).analysisStatus).toBe("permanently_failed");
    });
});

describe("re-deciding everything", () => {
    it("reopens the records and puts both status columns back to pending", async () => {
        await seedTrack({ analysisStatus: "completed", vibeAnalysisStatus: "completed" });
        await put("analysis", "done");
        await put("embedding", "done");

        const { reopened } = await redecideEverything();

        expect(reopened).toBeGreaterThanOrEqual(2);
        expect((await record("analysis")).status).toBe("pending");
        expect((await record("embedding")).status).toBe("pending");
        const after = await columns();
        expect(after.analysisStatus).toBe("pending");
        expect(after.vibeAnalysisStatus).toBe("pending");
    });
});

describe("reading the analyzers' answers back", () => {
    it("does not close a freshly claimed embedding because of the failure its previous attempt left on the columns", async () => {
        await seedTrack({ analysisStatus: "completed", vibeAnalysisStatus: "failed" });
        await put("analysis", "done");
        await put("embedding", "failed", { failures: 1, lastErrorCode: "REQUEST_FAILED", lastErrorMessage: "earlier attempt" });
        await stageRecords.claim(T, "embedding", { jobKey: "k" });

        await reconcileStaleStageRecords("embedding");

        expect((await record("embedding")).status).toBe("working");
        expect((await columns()).vibeAnalysisStatus).toBe("processing");
    });

    it("closes a working embedding whose analyzer wrote a failure after the claim", async () => {
        await seedTrack({ analysisStatus: "completed" });
        await put("analysis", "done");
        await put("embedding", "pending");
        await stageRecords.claim(T, "embedding", { jobKey: "k" });
        await prisma.track.update({
            where: { id: T },
            data: { vibeAnalysisStatus: "permanently_failed", vibeAnalysisError: "decode failed", vibeAnalysisStatusUpdatedAt: new Date(Date.now() + 1000) },
        });

        await reconcileStaleStageRecords("embedding");

        const row = await record("embedding");
        expect(row.status).toBe("failed");
        expect(row.failures).toBe(1);
        expect(row.lastErrorMessage).toBe("decode failed");
    });
});

describe("a fingerprint that lands", () => {
    it("lets a recording that closed without asking AcoustID ask now", async () => {
        await seedTrack({ analysisStatus: "completed", acoustidFingerprint: "AQAA" });
        await put("fingerprint", "pending");
        await put("recording", "done", { evidence: { acoustid: "not asked: the file's fingerprint question closed" } });

        await executeFingerprintPhase();
        await waitForFingerprintWork();

        expect((await record("fingerprint")).status).toBe("done");
        const recording = await record("recording");
        expect(recording.status).toBe("pending");
        expect(recording.evidence).toEqual({ reason: "fingerprint landed" });
    });
});
