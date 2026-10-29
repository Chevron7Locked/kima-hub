/**
 * A `rateLimited` answer parks the record until its `retryAfter`, uses no
 * attempt and records no failure. A no-match from every source closes the
 * record `done` with the asked sources as evidence.
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

import {
    mockRecordFailure,
    noData,
    mockIdentifyRecording,
    mockIdentifyTrackByAcoustid,
    mockReadIdentityTags,
    mockHandleRateLimit,
    mockGetPause,
} from "../../__tests__/helpers/enrichmentMocks";
import { prisma } from "../../utils/db";
import { enrichSingleTrack } from "../../workers/unifiedEnrichment";

const PREFIX = "mb429";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedTrack(
    trackId: string,
    opts: { isrc?: string | null; attempt?: number } = {},
) {
    await prisma.artist.create({
        data: { id: id(trackId + "art"), name: "MB429 Artist", identityKey: id(trackId + "a") },
    });
    await prisma.album.create({
        data: { id: id(trackId + "alb"), rgMbid: id(trackId + "rg"), artistId: id(trackId + "art"), title: "MB429 Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id(trackId + "alb"),
            title: "Rate Limited Song",
            trackNo: 1,
            duration: 180,
            filePath: `/music/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            isrc: opts.isrc ?? null,
        } as never,
    });
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, retryable, evidence)
         VALUES ($1, $2, 'recording', 'working', 'musicbrainz', $3, true, $4::jsonb)`,
        `${trackId}__recording`,
        trackId,
        opts.attempt ?? 2,
        JSON.stringify({ question: "recording" }),
    );
}

async function stageRow(trackId: string) {
    const rows = await prisma.$queryRawUnsafe<Array<{
        status: string; attempt: number; retryable: boolean;
        nextRetryAt: Date | null; lastErrorCode: string | null;
        failureClass: string | null; evidence: { reason?: string };
    }>>(
        `SELECT status, attempt, retryable, "nextRetryAt", "lastErrorCode",
                "failureClass", evidence
           FROM "TrackStage" WHERE "trackId" = $1 AND stage = 'recording'`,
        trackId,
    );
    return rows[0];
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${PREFIX}_%`);
}

beforeEach(async () => {
    jest.clearAllMocks();
    mockHandleRateLimit.mockResolvedValue(false);
    mockGetPause.mockResolvedValue(null);
    mockRecordFailure.mockResolvedValue({});
    mockReadIdentityTags.mockResolvedValue({
        recordingMbid: null,
        fingerprint: null,
        duration: 200,
    });
    mockIdentifyTrackByAcoustid.mockResolvedValue({
        kind: "permanent",
        error: {
            code: "NO_FINGERPRINT",
            message: "no fingerprint on hand — the step refuses",
        },
    });
    await wipe();
});

afterAll(async () => {
    await wipe();
});

describe("a rate-limited answer parks the question at its own deadline", () => {
    it("keeps the record pending until retryAfter, consumes no attempt, and reports deferral", async () => {
        const trackId = id("t1");
        await seedTrack(trackId); // attempt 2, already spent once
        const retryAfter = new Date(Date.now() + 60_000);
        mockIdentifyRecording.mockResolvedValue({
            kind: "rateLimited",
            retryAfter,
            evidence: { status: 429, source: "mocked" },
        });

        const outcome = await enrichSingleTrack(trackId);

        const stage = await stageRow(trackId);
        // Parked, not failed: the same attempt it was dispatched with, due
        // again exactly when the answer said to come back.
        expect(stage.status).toBe("pending");
        expect(stage.attempt).toBe(2);
        expect(stage.retryable).toBe(true);
        expect(stage.lastErrorCode).toBe("RATE_LIMITED");
        expect(new Date(stage.nextRetryAt!).getTime()).toBe(retryAfter.getTime());

        // The work reported deferral, so no queue-side settlement can
        // clobber the parked record into done/failed.
        expect(outcome).toBe("deferred");
    });
});

describe("an honest no-match", () => {
    it("answers the question as Absent with no attempt consumed", async () => {
        const trackId = id("t2");
        await seedTrack(trackId, { attempt: 1 });
        // Every source answered "nothing there", which is an answer: the
        // record closes `done` and the retry ladder is untouched.
        mockReadIdentityTags.mockResolvedValue({
            recordingMbid: null,
            fingerprint: "TAGFP",
            duration: 200,
        });
        mockIdentifyRecording.mockResolvedValue(noData);
        mockIdentifyTrackByAcoustid.mockResolvedValue({
            kind: "absent",
            evidence: { fingerprint: "TAGFP", reason: "nothing matched" },
        });

        const outcome = await enrichSingleTrack(trackId);

        expect(outcome).toBe("no_match");

        const stage = await stageRow(trackId);
        expect(stage.status).toBe("done");
        expect(stage.attempt).toBe(1); // an answer is not a failed attempt
        expect(stage.failureClass).toBeNull();
        expect(stage.nextRetryAt).toBeNull();
        expect(stage.evidence.reason).toBe(
            "no source has a recording that is this track",
        );
    });
});