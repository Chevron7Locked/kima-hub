/**
 * The /enrichment/failures routes read track-stage failures from TrackStage,
 * in the response shape the settings UI uses.
 */

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
    optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue("OK"),
        del: jest.fn().mockResolvedValue(1),
        keys: jest.fn().mockResolvedValue([]),
        publish: jest.fn().mockResolvedValue(1),
        on: jest.fn(),
        status: "ready",
    },
}));

jest.mock("../../workers/unifiedEnrichment", () => ({
    getEnrichmentProgress: jest.fn().mockResolvedValue({}),
    invalidateEnrichmentProgress: jest.fn(),
    retryFailedAndBlocked: jest.fn().mockResolvedValue({ queued: 0 }),
    redecideEverything: jest.fn().mockResolvedValue({ reopened: 0 }),
    triggerEnrichmentNow: jest.fn().mockResolvedValue({ artists: 0, tracks: 0, audioQueued: 0 }),
    startEnrichmentNow: jest.fn().mockResolvedValue({ artists: 0, tracks: 0, audioQueued: 0 }),
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
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({}),
    invalidateSystemSettingsCache: jest.fn(),
}));


jest.mock("../../services/rateLimiter", () => ({
    rateLimiter: {
        updateConcurrencyMultiplier: jest.fn(),
        checkLimit: jest.fn().mockResolvedValue(true),
    },
}));

jest.mock("../../services/imageBackfill", () => ({
    repairBrokenCovers: jest.fn().mockResolvedValue({ repaired: 0 }),
}));

jest.mock("../../services/mbidReassign", () => ({
    DuplicateMbidError: class DuplicateMbidError extends Error {},
    reassignAlbumRgMbid: jest.fn(),
    reassignArtistMbid: jest.fn(),
}));

import express from "express";
import request from "supertest";

import { prisma } from "../../utils/db";
import enrichmentRouter from "../enrichment";

const PREFIX = "frte";
const id = (n: string) => `${PREFIX}_${n}`;
const app = express();
app.use(express.json());
app.use("/api/enrichment", enrichmentRouter);

async function seedFailedRecording(trackId: string): Promise<string> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Route Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: {
            id: id("alb"), rgMbid: id("rg"), artistId: id("art"),
            title: "Route Album", primaryType: "Album",
        },
    });
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
            analysisStatus: "pending",
        },
    });
    const stageId = `${trackId}__recording`;
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt,
             "lastErrorCode", "lastErrorMessage", "failureClass",
             retryable, evidence, "startedAt", "finishedAt")
         VALUES ($1, $2, 'recording', 'failed', 'musicbrainz', 1,
                 'INCONCLUSIVE', 'No recording identified', 'INCONCLUSIVE',
                 true, $3::jsonb, now(), now())`,
        stageId,
        trackId,
        JSON.stringify({ probe: "mb-search" }),
    );
    return stageId;
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(
        `DELETE FROM "EnrichmentFailure" WHERE "entityId" LIKE $1 OR "entityName" LIKE $2`,
        `${PREFIX}_%`,
        `${PREFIX}_%`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    await wipe();
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("GET /enrichment/failures reads track stages from TrackStage", () => {
    it("lists a failed recording with the familiar EnrichmentFailure shape", async () => {
        const trackId = id("t1");
        const stageId = await seedFailedRecording(trackId);

        const res = await request(app).get("/api/enrichment/failures").query({
            entityType: "track",
        });

        expect(res.status).toBe(200);
        const entry = res.body.failures.find((f: { entityId: string }) => f.entityId === trackId);
        expect(entry).toBeDefined();
        expect(entry).toMatchObject({
            id: stageId,
            entityType: "track",
            errorMessage: "No recording identified",
            resolved: false,
        });
    });

    it("GET /enrichment/failures/counts counts the track bucket from TrackStage", async () => {
        await seedFailedRecording(id("t2"));

        const res = await request(app).get("/api/enrichment/failures/counts");

        expect(res.status).toBe(200);
        expect(res.body.track).toBe(1);
        expect(res.body.total).toBe(1);
    });

    it("does not count or list a track whose file is missing as a failure", async () => {
        await seedFailedRecording(id("t3"));
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage" SET "failureClass" = 'FILE_MISSING', retryable = false WHERE "trackId" = $1`,
            id("t3"),
        );

        const counts = await request(app).get("/api/enrichment/failures/counts");
        expect(counts.body.track).toBe(0);

        const list = await request(app).get("/api/enrichment/failures").query({ entityType: "track" });
        expect(list.body.failures.some((f: { entityId: string }) => f.entityId === id("t3"))).toBe(false);
    });
});
