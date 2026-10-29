/**
 * The CLAP analyzer reports vibe outcomes over these endpoints and writes no
 * state itself; the record ladder and the vibe status mirror are settled here.
 */

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
    optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    authed: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        getFailures: jest.fn().mockResolvedValue({ failures: [], total: 0 }),
        recordFailure: jest.fn().mockResolvedValue({}),
    },
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({}),
    invalidateSystemSettingsCache: jest.fn(),
}));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../../workers/enrichmentQueues", () => {
    const queueStub = () => ({
        add: jest.fn(async () => ({ id: "job-1" })),
        clean: jest.fn(async () => []),
        getJob: jest.fn(async () => null),
        resume: jest.fn(async () => undefined),
        pause: jest.fn(async () => undefined),
    });
    return {
        QUEUE_NAMES: { ARTISTS: "a", TRACKS: "t", VIBE: "v", PODCASTS: "p" },
        artistQueue: queueStub(),
        trackQueue: queueStub(),
        vibeQueue: queueStub(),
        podcastQueue: queueStub(),
        createWorkerConnection: () => ({ host: "localhost", port: 6379 }),
        closeEnrichmentQueues: jest.fn(async () => undefined),
    };
});
// The real scheduler is the point of these tests; the podcast worker it boots
// pulls the podcast routes and their rate limiters, which are not under test.
jest.mock("../../workers/podcastEnrichmentWorker", () => ({
    startPodcastEnrichmentWorker: jest.fn(),
}));

import express from "express";
import request from "supertest";

import { prisma } from "../../utils/db";
import analysisRouter from "../analysis";
import { internalSecret } from "../../utils/internalSecret";
import { waitForRedisReady } from "../../utils/redis";

jest.setTimeout(30_000);

// This server's secret, the one the analyzers read from the same Redis.
let secret = "";
beforeAll(async () => {
    await waitForRedisReady();
    secret = await internalSecret();
});
const PREFIX = "vrep";
const id = (n: string) => `${PREFIX}_${n}`;

const app = express();
app.use(express.json());
app.use("/api/analysis", analysisRouter);

async function seedTrack(n: string) {
    const trackId = id(n);
    const artist = await prisma.artist.create({ data: { id: id(`art_${n}`), name: "R", identityKey: id(`k_${n}`) } });
    const album = await prisma.album.create({
        data: { id: id(`alb_${n}`), rgMbid: id(`rg_${n}`), artistId: artist.id, title: "R", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: trackId, albumId: album.id, title: "R", trackNo: 1, duration: 200,
            filePath: `/tmp/${trackId}.flac`, fileModified: new Date(), fileSize: 1000,
            analysisStatus: "completed", vibeAnalysisStatus: "processing",
        },
    });
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, "startedAt")
         VALUES ($1, $2, 'embedding', 'working', 'clap', 1, now() - interval '1 minute')`,
        `${trackId}__embedding`, trackId,
    );
    return trackId;
}

async function unseed(n: string) {
    const trackId = id(n);
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" = $1`, trackId);
    await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id = $1`, trackId);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id = $1`, trackId);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id(`alb_${n}`));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id(`art_${n}`));
}

describe("vibe report endpoints", () => {
    it("a success report closes the record and mirrors completed", async () => {
        const trackId = await seedTrack("ok");
        const res = await request(app)
            .post("/api/analysis/vibe/success")
            .set("x-internal-secret", secret)
            .send({ trackId });
        expect(res.status).toBe(200);

        const record = await prisma.trackStage.findFirst({ where: { trackId, stage: "embedding" } });
        expect(record?.status).toBe("done");
        const track = await prisma.track.findUnique({ where: { id: trackId } });
        expect(track?.vibeAnalysisStatus).toBe("completed");
        expect(track?.vibeAnalysisError).toBeNull();
        await unseed("ok");
    });

    it("an inconclusive failure report mirrors failed and keeps the ladder", async () => {
        const trackId = await seedTrack("retry");
        const res = await request(app)
            .post("/api/analysis/vibe/failure")
            .set("x-internal-secret", secret)
            .send({ trackId, errorMessage: "onnx runtime aborted", errorCode: "VIBE_EMBEDDING_FAILED" });
        expect(res.status).toBe(200);

        const record = await prisma.trackStage.findFirst({ where: { trackId, stage: "embedding" } });
        expect(record?.status).toBe("failed");
        expect(record?.retryable).toBe(true);
        const track = await prisma.track.findUnique({ where: { id: trackId } });
        expect(track?.vibeAnalysisStatus).toBe("failed");
        expect(track?.vibeAnalysisError).toBe("onnx runtime aborted");
        await unseed("retry");
    });

    it("a corruption failure closes the record and mirrors permanently_failed", async () => {
        const trackId = await seedTrack("dmg");
        await request(app)
            .post("/api/analysis/vibe/failure")
            .set("x-internal-secret", secret)
            .send({ trackId, errorMessage: "corrupted audio data in decode", errorCode: "VIBE_EMBEDDING_FAILED" });

        const record = await prisma.trackStage.findFirst({ where: { trackId, stage: "embedding" } });
        expect(record?.status).toBe("failed");
        expect(record?.retryable).toBe(false);
        expect(record?.failureClass).toBe("DAMAGED");
        const track = await prisma.track.findUnique({ where: { id: trackId } });
        expect(track?.vibeAnalysisStatus).toBe("permanently_failed");
        await unseed("dmg");
    });

    it("reports without this server's secret are refused and write nothing", async () => {
        const trackId = await seedTrack("guard");
        for (const wrong of ["wrong", "kima-internal-aio", "kima-internal-secret-change-me"]) {
            const res = await request(app)
                .post("/api/analysis/vibe/failure")
                .set("x-internal-secret", wrong)
                .send({ trackId, errorMessage: "anything" });
            expect(res.status).toBe(403);
        }

        const record = await prisma.trackStage.findFirst({ where: { trackId, stage: "embedding" } });
        expect(record?.status).toBe("working");
        const track = await prisma.track.findUnique({ where: { id: trackId } });
        expect(track?.vibeAnalysisStatus).toBe("processing");
        await unseed("guard");
    });

    it("both reports refuse a missing song id, and a wrong secret first", async () => {
        for (const path of ["/api/analysis/vibe/failure", "/api/analysis/vibe/success"]) {
            const noId = await request(app).post(path).set("x-internal-secret", secret).send({ errorMessage: "x" });
            expect([path, noId.status, noId.body.error]).toEqual([path, 400, "trackId is required"]);
            const wrong = await request(app).post(path).set("x-internal-secret", "wrong").send({});
            expect([path, wrong.status]).toEqual([path, 403]);
        }
    });
});
