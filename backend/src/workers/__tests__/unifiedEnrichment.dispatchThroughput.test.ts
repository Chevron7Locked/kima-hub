/**
 * Each track phase has its own stage window, so analysis dispatches while
 * identification is still running, and no stage claims beyond its in-flight
 * cap, so a queued job never outlives its record's patience.
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

// The album step before dispatch is not what this tests, and must never reach the network.
jest.mock("../../services/albumIdentification", () => ({
    ...jest.requireActual("../../services/albumIdentification"),
    identifyAlbumsBySound: jest.fn().mockResolvedValue([]),
}));

import { mockQueueAdd, mockRedis } from "../../__tests__/helpers/enrichmentMocks";
import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import {
    executeAudioPhase,
    executeIdentificationPhase,
    executeVibePhase,
    inFlightCap,
    STAGE_IN_FLIGHT_CAP,
} from "../../workers/unifiedEnrichment";
import { prefetchAcoustidReplies } from "../../services/acoustidIdentification";
import { identifyAlbumsBySound } from "../../services/albumIdentification";

const PREFIX = "dthr";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedLibrary(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Throughput Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Throughput Album", primaryType: "Album" },
    });
}

/** Bulk inserts: the caps are hundreds of tracks, too many for a row-by-row seed. */
async function seedTracks(count: number, stages: Array<[string, string]>): Promise<void> {
    const trackIds = Array.from({ length: count }, (_, n) => id(`t${n}`));
    await prisma.track.createMany({
        data: trackIds.map((trackId, n) => ({
            id: trackId,
            albumId: id("alb"),
            title: `Track ${n}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            analysisStatus: "pending",
        })),
    });
    for (const [stage, status] of stages) {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
             SELECT t || '__' || $2, t, $2, $3, 'test', 0, true, '{}'::jsonb FROM unnest($1::text[]) AS t`,
            trackIds, stage, status,
        );
    }
}

/** `count` answers this stage closed just now, on tracks of their own: the drain rate the cap reads. */
async function seedRecentCloses(stage: string, count: number): Promise<void> {
    const trackIds = Array.from({ length: count }, (_, n) => id(`closed${n}`));
    await prisma.track.createMany({
        data: trackIds.map((trackId, n) => ({
            id: trackId, albumId: id("alb"), title: `Closed ${n}`, trackNo: 1, duration: 180,
            filePath: `/tmp/${trackId}.flac`, fileModified: new Date(), fileSize: 1000,
            analysisStatus: "completed",
        })),
    });
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence, "startedAt", "finishedAt")
         SELECT t || '__' || $2, t, $2, 'done', 'test', 1, true, '{}'::jsonb, now(), now() FROM unnest($1::text[]) AS t`,
        trackIds, stage,
    );
}

async function workingCount(stage: string): Promise<number> {
    const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "TrackStage" ts
          JOIN "Track" t ON t.id = ts."trackId"
         WHERE ts.stage = $1 AND ts.status = 'working' AND t.id LIKE $2`,
        stage, `${PREFIX}_%`,
    );
    return Number(row.n);
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await seedLibrary();
});

afterAll(async () => {
    await wipe();
});

describe("stages overlap instead of running in waves", () => {
    it("analysis dispatches while a bigger recording backlog is pending", async () => {
        // A mixed backlog: every track still owes its recording AND its
        // analysis. A single stage-ordered window would fill with recording
        // alone and starve the analyzer until identification finished.
        await seedTracks(30, [
            ["recording", "pending"],
            ["analysis", "pending"],
            ["fingerprint", "done"],
        ]);
        const cap = (await inFlightCap("analysis")) ?? 0;
        expect(cap).toBeGreaterThan(0);

        const queued = await executeAudioPhase();

        expect(queued).toBe(cap);
        expect(mockRedis.rpush).toHaveBeenCalledTimes(cap);
        expect(await workingCount("analysis")).toBe(cap);
    });

    it("claims whose lease ran out do not hold the stage's places", async () => {
        const cap = (await inFlightCap("analysis")) ?? 0;
        await seedTracks(cap, [["analysis", "working"]]);
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage" SET "startedAt" = now() - interval '16 minutes',
                    "nextRetryAt" = now() - interval '1 minute'
              WHERE stage = 'analysis' AND "trackId" LIKE $1`,
            `${PREFIX}_%`,
        );

        expect(await executeAudioPhase()).toBe(cap);
        const [reoffered] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT count(*)::bigint AS n FROM "TrackStage"
              WHERE stage = 'analysis' AND "trackId" LIKE $1 AND redelivered = 1 AND "nextRetryAt" > now()`,
            `${PREFIX}_%`,
        );
        expect(Number(reoffered.n)).toBe(cap);
    });

    it("a claimed question is not handed out again while its lease holds", async () => {
        await seedRecentCloses("analysis", 200);
        await seedTracks(25, [["analysis", "pending"]]);
        expect(await executeAudioPhase()).toBe(25);
        expect(await workingCount("analysis")).toBe(25);
        expect(await executeAudioPhase()).toBe(0);
    });
});

describe("in-flight caps keep queues inside the record's patience", () => {
    it("with no answers yet, each worker gets one track running and one queued", async () => {
        const settings = await prisma.systemSettings.findUnique({ where: { id: "default" } });
        const workers = settings?.audioAnalyzerWorkers ?? 2;
        expect(await inFlightCap("analysis")).toBe(2 * workers);
    });

    it("a slow machine holds only what it drains in half the claim lease", async () => {
        // 4 answers in the 2-minute window: 15 minutes of lease / 2 = 7.5 minutes = 15 answers.
        await seedRecentCloses("analysis", 4);
        const settings = await prisma.systemSettings.findUnique({ where: { id: "default" } });
        const workers = settings?.audioAnalyzerWorkers ?? 2;
        expect(await inFlightCap("analysis")).toBe(Math.max(2 * workers, 15));
    });

    it("identification holds two claims per worker until it has answered, then what it drains", async () => {
        // One worker (the setting at 1): two claims, not thirty queued behind one worker
        // past their lease; then what it drains in half the lease.
        const before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
        const setConcurrency = async (n: number) => {
            await prisma.systemSettings.upsert({
                where: { id: "default" },
                create: { id: "default", enrichmentConcurrency: n },
                update: { enrichmentConcurrency: n },
            });
            invalidateSystemSettingsCache();
        };
        await setConcurrency(1);
        try {
            expect(await inFlightCap("recording")).toBe(2);
            await seedRecentCloses("recording", 4);
            expect(await inFlightCap("recording")).toBe(15);
        } finally {
            await setConcurrency(before?.enrichmentConcurrency ?? 5);
        }
    });

    it("analysis claims no deeper than its ceiling on a fast machine", async () => {
        const cap = STAGE_IN_FLIGHT_CAP.analysis ?? 0;
        await seedRecentCloses("analysis", 400);
        expect(await inFlightCap("analysis")).toBe(cap);
        await seedTracks(cap + 5, [["analysis", "pending"]]);

        let queued = 0;
        for (let cycle = 0; cycle < 15; cycle++) {
            const added = await executeAudioPhase();
            queued += added;
            if (added === 0) break;
        }

        expect(queued).toBe(cap);
        expect(await workingCount("analysis")).toBe(cap);
        const [stillPending] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT count(*)::bigint AS n FROM "TrackStage" ts
              JOIN "Track" t ON t.id = ts."trackId"
             WHERE ts.stage = 'analysis' AND ts.status = 'pending' AND t.id LIKE $1`,
            `${PREFIX}_%`,
        );
        expect(Number(stillPending.n)).toBe(5);
    });

    it("embedding claims no deeper than its ceiling on a fast machine", async () => {
        const cap = STAGE_IN_FLIGHT_CAP.embedding ?? 0;
        await seedRecentCloses("embedding", 400);
        expect(await inFlightCap("embedding")).toBe(cap);
        // Embedding gates on the track's own analysis answer.
        await seedTracks(cap + 4, [
            ["analysis", "done"],
            ["embedding", "pending"],
        ]);

        const queued = await executeVibePhase();

        expect(queued).toBe(cap);
        expect(mockQueueAdd).toHaveBeenCalledTimes(cap);
        expect(await workingCount("embedding")).toBe(cap);
    });
});

describe("identification asks AcoustID ahead of the dispatch", () => {
    it("asks about the next 100 songs and hands out no more than 20", async () => {
        await seedTracks(150, [["fingerprint", "done"]]);

        const queued = await executeIdentificationPhase();

        const asked = (prefetchAcoustidReplies as jest.Mock).mock.calls[0][0] as Array<{ id: string }>;
        expect(asked).toHaveLength(100);
        expect(queued).toBeGreaterThan(0);
        expect(queued).toBeLessThanOrEqual(20);
        expect(await workingCount("recording")).toBe(queued);
    });

    it("asks the album step about the albums of the songs coming up", async () => {
        await seedTracks(30, [["fingerprint", "done"]]);

        await executeIdentificationPhase();

        expect(identifyAlbumsBySound).toHaveBeenCalledWith([id("alb")]);
    });

    it("hands the songs out even when the album step fails", async () => {
        await seedTracks(30, [["fingerprint", "done"]]);
        (identifyAlbumsBySound as jest.Mock).mockRejectedValueOnce(new Error("MusicBrainz unreachable"));

        expect(await executeIdentificationPhase()).toBeGreaterThan(0);
    });

    it("hands the songs out even when asking AcoustID fails", async () => {
        await seedTracks(30, [["fingerprint", "done"]]);
        (prefetchAcoustidReplies as jest.Mock).mockRejectedValueOnce(new Error("AcoustID unreachable"));

        const queued = await executeIdentificationPhase();

        expect(queued).toBeGreaterThan(0);
        expect(await workingCount("recording")).toBe(queued);
    });
});
