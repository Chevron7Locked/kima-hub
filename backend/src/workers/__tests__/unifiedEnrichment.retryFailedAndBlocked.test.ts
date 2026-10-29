/**
 * "Retry failed and blocked" hands out only owed questions: done, terminal and
 * blocked records stay put, and a retry not yet due waits. Dispatch claims the
 * record so the next sweep cannot hand it out twice. Real test database.
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
jest.mock("../../services/musicbrainz", () => require("../../__tests__/helpers/enrichmentMocks").musicBrainzMock);
jest.mock("../../services/acoustidIdentification", () => require("../../__tests__/helpers/enrichmentMocks").acoustidIdentificationMock);
jest.mock("../../services/sourcePauseController", () => require("../../__tests__/helpers/enrichmentMocks").sourcePauseControllerMock);
jest.mock("../../workers/audioCompletionSubscriber", () => require("../../__tests__/helpers/enrichmentMocks").audioCompletionSubscriberMock);
jest.mock("../../workers/artistEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").artistEnrichmentWorkerMock);
jest.mock("../../workers/trackEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").trackEnrichmentWorkerMock);
jest.mock("../../workers/podcastEnrichmentWorker", () => require("../../__tests__/helpers/enrichmentMocks").podcastEnrichmentWorkerMock);

// NOTE: `../../utils/db` is deliberately NOT mocked — the queue path must be
// proven against the real TrackStage table the migration creates.

import { putStage, deleteSeededRows, seedArtistAndAlbum } from "../../__tests__/helpers/trackStage";
import { mockQueueAdd, mockQueueGetJob, mockRedis } from "../../__tests__/helpers/enrichmentMocks";
import { prisma } from "../../utils/db";
import {
    waitForFingerprintWork,
    getNextWork,
    retryFailedAndBlocked,
} from "../../workers/unifiedEnrichment";

const PREFIX = "rfb";
const id = (n: string) => `${PREFIX}_${n}`;

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
    await deleteSeededRows(PREFIX);
}

beforeEach(async () => {
    jest.clearAllMocks();
    jest.mocked(mockQueueAdd).mockResolvedValue({ id: "job-1" } as never);
    jest.mocked(mockQueueGetJob).mockResolvedValue(null as never);
    jest.mocked(mockRedis.rpush).mockResolvedValue(1);
    await wipe();
    await seedArtistAndAlbum(PREFIX, "RfB");
});

afterAll(async () => {
    await waitForFingerprintWork();
    await wipe();
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
