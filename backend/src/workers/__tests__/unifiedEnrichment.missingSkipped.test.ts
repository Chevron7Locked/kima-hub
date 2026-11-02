/**
 * A track whose file the scan flagged missing is never offered to a stage and
 * its record is left as it was. When the file returns, the question is due again.
 */

// ── Queues + Redis + network services: observe, never hit the wire ──────────

// No library scan is running: the retry offers its work now.
jest.mock("../scanActivity", () => ({ libraryScanRunning: jest.fn().mockResolvedValue(false) }));
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

import { mockQueueAdd, mockRecordFailure } from "../../__tests__/helpers/enrichmentMocks";
import { prisma } from "../../utils/db";
import {
    waitForFingerprintWork,
    getNextWork,
    retryFailedAndBlocked,
    getEnrichmentProgress,
    invalidateEnrichmentProgress,
} from "../../workers/unifiedEnrichment";

const PREFIX = "scanmiss";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedAlbum(): Promise<string> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Scanmiss Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Scanmiss Album", primaryType: "Album" },
    });
    return id("alb");
}

async function seedTrack(
    trackId: string,
    opts: { missingSince?: Date | null } = {},
): Promise<void> {
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id("alb"),
            title: `Track ${trackId}`,
            trackNo: 1,
            duration: 180,
            filePath: `/music/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            missingSince: opts.missingSince ?? null,
        } as never,
    });
}

async function wipe(): Promise<void> {
    await waitForFingerprintWork();
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${PREFIX}%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${PREFIX}%`);
}

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await seedAlbum();
});

afterAll(async () => {
    await wipe();
});

describe("enrichment skips a track flagged missing", () => {
    it("getNextWork never offers it", async () => {
        await seedTrack(id("present"));
        await seedTrack(id("gone"), { missingSince: new Date() });
        // The fingerprint question is SETTLED for both tracks, so the
        // recording question is genuinely due for the present track — the
        // missing flag is the only difference under test.
        for (const trackId of [id("present"), id("gone")]) {
            await prisma.$executeRawUnsafe(
                `INSERT INTO "TrackStage"
                    (id, "trackId", stage, status, source, attempt, retryable, evidence)
                 VALUES ($1, $2, 'fingerprint', 'done', 'fpcalc', 1, false, $3::jsonb)`,
                `${trackId}__fingerprint`,
                trackId,
                JSON.stringify({ question: "fingerprint" }),
            );
        }

        const work = await getNextWork(10, "recording");

        expect(work.map((w) => w.trackId)).toEqual([id("present")]);
    });

    it("the control neither offers it, nor queues it, nor fails it, and its attempt is untouched", async () => {
        await seedTrack(id("gone"), { missingSince: new Date() });
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt, retryable, evidence)
             VALUES ($1, $2, 'recording', 'pending', 'musicbrainz', 2, true, $3::jsonb)`,
            `${id("gone")}__recording`,
            id("gone"),
            JSON.stringify({ question: "recording" }),
        );

        const work = await retryFailedAndBlocked();

        expect(work.map((w) => w.trackId)).not.toContain(id("gone"));
        // Nothing was queued anywhere.
        expect(mockQueueAdd).not.toHaveBeenCalled();
        // No failure was recorded for it.
        expect(mockRecordFailure).not.toHaveBeenCalled();

        // The record is exactly as it was: an attempt was not consumed.
        const stage = await prisma.$queryRawUnsafe<Array<{ status: string; attempt: number }>>(
            `SELECT status, attempt FROM "TrackStage" WHERE "trackId" = $1 AND stage = 'recording'`,
            id("gone"),
        );
        expect(stage).toEqual([{ status: "pending", attempt: 2 }]);
    });

    it("offers it again once the scan clears the flag", async () => {
        await seedTrack(id("back"), { missingSince: new Date() });
        // The fingerprint question is settled, so once the flag clears the
        // recording question is genuinely due — the flag is the only thing
        // holding it back.
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt, retryable, evidence)
             VALUES ($1, $2, 'fingerprint', 'done', 'fpcalc', 1, false, $3::jsonb)`,
            `${id("back")}__fingerprint`,
            id("back"),
            JSON.stringify({ question: "fingerprint" }),
        );
        expect(await getNextWork(10, "recording")).toEqual([]);

        await prisma.track.update({
            where: { id: id("back") },
            data: { missingSince: null },
        });

        const work = await getNextWork(10, "recording");
        expect(work.map((w) => w.trackId)).toEqual([id("back")]);
    });

    it("leaves a missing file out of a stage's percent done, and counts it as missing", async () => {
        await seedTrack(id("here"));
        await prisma.trackStage.create({ data: { trackId: id("here"), stage: "analysis", status: "done" } });
        invalidateEnrichmentProgress();
        const before = (await getEnrichmentProgress()).audioAnalysis;

        await seedTrack(id("gone"), { missingSince: new Date() });
        await prisma.trackStage.create({
            data: { trackId: id("gone"), stage: "analysis", status: "failed", retryable: false, failureClass: "FILE_MISSING" },
        });
        invalidateEnrichmentProgress();
        const after = (await getEnrichmentProgress()).audioAnalysis;

        expect(after.total).toBe(before.total + 1);
        expect(after.waitingMissing).toBe(before.waitingMissing + 1);
        expect(after.progress).toBe(before.progress);
    });
});
