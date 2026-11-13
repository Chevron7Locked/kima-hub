/**
 * The bulk re-ask buttons (retry failed analysis, rebuild sound vectors) reopen
 * only records that can be answered: never one running now, one a person
 * parked, or one whose file is missing.
 */

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
    optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    authed: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockTriggerEnrichmentNow = jest.fn().mockResolvedValue({
    artists: 0, tracks: 0, audioQueued: 0,
});
jest.mock("../../workers/unifiedEnrichment", () => ({
    startEnrichmentNow: (...a: unknown[]) => mockTriggerEnrichmentNow(...a),
    invalidateEnrichmentProgress: jest.fn(),
}));

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        getFailures: jest.fn().mockResolvedValue({ failures: [], total: 0 }),
        recordFailure: jest.fn().mockResolvedValue({}),
    },
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

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({}),
    invalidateSystemSettingsCache: jest.fn(),
}));

import express from "express";
import request from "supertest";

import { prisma } from "../../utils/db";
import analysisRouter from "../analysis";

const PREFIX = "reopenr";
const id = (n: string) => `${PREFIX}_${n}`;
const app = express();
app.use(express.json());
app.use("/api/analysis", analysisRouter);

async function seedTrack(trackId: string, missing = false): Promise<void> {
    await prisma.track.create({
        data: {
            id: trackId, albumId: id("alb"), title: trackId, trackNo: 1, duration: 200,
            filePath: `a/b/${trackId}.mp3`, fileModified: new Date(), fileSize: 1000,
            analysisStatus: "failed", ...(missing ? { missingSince: new Date() } : {}),
        } as never,
    });
}

async function putStage(trackId: string, stage: string, status: string, retryable: boolean, failureClass: string | null) {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, "failureClass", "startedAt")
         VALUES ($1, $2, $3, $4, 'analyzer', 1, $5, $6, now())`,
        `${trackId}__${stage}`, trackId, stage, status, retryable, failureClass,
    );
}

async function status(trackId: string, stage: string): Promise<string> {
    const [row] = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM "TrackStage" WHERE "trackId" = $1 AND stage = $2`, trackId, stage,
    );
    return row.status;
}

async function wipe() {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    await wipe();
    await prisma.artist.create({ data: { id: id("art"), name: "Reopen Artist", identityKey: id("a") } });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Reopen Album", primaryType: "Album" },
    });
    await seedTrack(id("open"));
    await seedTrack(id("running"));
    await seedTrack(id("parked"));
    await seedTrack(id("gone"), true);
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("retry failed analysis", () => {
    it("reopens failures it can answer and leaves running, parked and missing-file records alone", async () => {
        await putStage(id("open"), "analysis", "failed", false, "PERMANENT");
        await putStage(id("running"), "analysis", "working", true, null);
        await putStage(id("parked"), "analysis", "blocked", false, null);
        await putStage(id("gone"), "analysis", "failed", false, "FILE_MISSING");

        const res = await request(app).post("/api/analysis/retry-failed").send({});
        expect(res.status).toBe(200);

        expect(await status(id("open"), "analysis")).toBe("pending");
        expect(await status(id("running"), "analysis")).toBe("working");
        expect(await status(id("parked"), "analysis")).toBe("blocked");
        expect(await status(id("gone"), "analysis")).toBe("failed");
        const gone = await prisma.track.findUniqueOrThrow({ where: { id: id("gone") } });
        expect(gone.analysisStatus).toBe("failed");
    });
});

describe("rebuild every sound vector", () => {
    it("reopens answered records and leaves running, parked and missing-file records alone", async () => {
        await putStage(id("open"), "embedding", "done", true, null);
        await putStage(id("running"), "embedding", "working", true, null);
        await putStage(id("parked"), "embedding", "blocked", false, null);
        await putStage(id("gone"), "embedding", "failed", false, "FILE_MISSING");

        const res = await request(app).post("/api/analysis/vibe/start").send({ force: true });
        expect(res.status).toBe(200);

        expect(await status(id("open"), "embedding")).toBe("pending");
        expect(await status(id("running"), "embedding")).toBe("working");
        expect(await status(id("parked"), "embedding")).toBe("blocked");
        expect(await status(id("gone"), "embedding")).toBe("failed");
    });
});
