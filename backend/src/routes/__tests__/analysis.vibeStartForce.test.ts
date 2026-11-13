/**
 * POST /api/analysis/vibe/start with force=true reopens every embedding question
 * and deletes nothing: existing embeddings stay readable until each new one
 * replaces them, and no failures or statuses are cleared.
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

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import fs from "fs";
import path from "path";

import express from "express";
import request from "supertest";

import { prisma } from "../../utils/db";
import analysisRouter from "../analysis";

const PREFIX = "vforce";
const id = (n: string) => `${PREFIX}_${n}`;
const app = express();
app.use(express.json());
app.use("/api/analysis", analysisRouter);

async function seedAnalysedTrack(
    trackId: string,
    opts: { withEmbedding: boolean },
): Promise<void> {
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id("alb"),
            title: `Track ${trackId}`,
            trackNo: 1,
            duration: 200,
            filePath: `artist/album/${trackId}.mp3`,
            fileModified: new Date(),
            fileSize: 1000,
            analysisStatus: "completed",
            vibeAnalysisStatus: "completed",
            vibeAnalysisRetryCount: 0,
        } as never,
    });
    await putStage(trackId, "analysis", "done", 1);
    if (opts.withEmbedding) {
        await seedEmbedding(trackId, "old-model");
        // An ANSWERED embedding record: attempt 2, finished at, done.
        await putStage(trackId, "embedding", "done", 2);
    }
}

async function putStage(
    trackId: string,
    stage: string,
    status: string,
    attempt: number,
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, retryable, evidence, "startedAt", "finishedAt")
         VALUES ($1, $2, $3, $4, $5, $6, true, $7::jsonb, now(), $8)
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status, attempt = EXCLUDED.attempt,
                evidence = EXCLUDED.evidence, "startedAt" = now(),
                "finishedAt" = EXCLUDED."finishedAt"`,
        `${trackId}__${stage}`, trackId, stage, status, "analyzer", attempt,
        JSON.stringify({ probe: "seeded" }),
        status === "done" ? new Date() : null,
    );
}

async function seedEmbedding(trackId: string, modelVersion: string): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
         VALUES ($1, $2::vector, $3, now())
         ON CONFLICT (track_id) DO NOTHING`,
        trackId,
        `[${Array.from({ length: 512 }, (_, i) => ((i + 1) % 5) / 5).join(",")}]`,
        modelVersion,
    );
}

async function embeddingRows(trackId: string): Promise<{ model_version: string }[]> {
    return prisma.$queryRawUnsafe<{ model_version: string }[]>(
        `SELECT model_version FROM track_embeddings WHERE track_id = $1`,
        trackId,
    );
}

async function embeddingStageRows(): Promise<
    { trackId: string; status: string; attempt: number; failures: number; finishedAt: Date | null; retryable: boolean }[]
> {
    return prisma.$queryRawUnsafe<
        { trackId: string; status: string; attempt: number; failures: number; finishedAt: Date | null; retryable: boolean }[]
    >(
        `SELECT ts."trackId" AS "trackId", ts.status, ts.attempt, ts.failures, ts."finishedAt", ts.retryable
           FROM "TrackStage" ts WHERE ts.stage = 'embedding' AND ts."trackId" LIKE $1
          ORDER BY ts."trackId"`,
        `${PREFIX}_%`,
    );
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "track_embeddings" WHERE track_id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await prisma.artist.create({
        data: { id: id("art"), name: "Vibe Force Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Vibe Force Album", primaryType: "Album" },
    });
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("POST /api/analysis/vibe/start force=true re-decides without deleting", () => {
    it("reopens every embedding question and keeps the existing embeddings readable", async () => {
        const kept = id("kept");
        const kept2 = id("kept2");
        await seedAnalysedTrack(kept, { withEmbedding: true });
        await seedAnalysedTrack(kept2, { withEmbedding: true });

        const res = await request(app)
            .post("/api/analysis/vibe/start")
            .send({ force: true });

        expect(res.status).toBe(200);

        // 1. The DATA is still there, readable, unchanged — the vibe map
        //    keeps working while the re-embed is in flight.
        const emb1 = await embeddingRows(kept);
        const emb2 = await embeddingRows(kept2);
        expect(emb1).toHaveLength(1);
        expect(emb2).toHaveLength(1);
        expect(emb1[0].model_version).toBe("old-model");

        // 2. The QUESTIONS were re-opened, not deleted: same records, back to
        //    pending, fresh attempt, no finish stamp.
        const rows = await embeddingStageRows();
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.status).toBe("pending");
            expect(row.failures).toBe(0);
            expect(row.finishedAt).toBeNull();
            expect(row.retryable).toBe(true);
        }

        // 3. The answer is owed NOW: even though an embedding row exists,
        //    the reopened questions are what the count reports.
        expect(res.body.queued).toBe(2);
        expect(res.body.message).not.toBe("All tracks have vibe embeddings");

        // 4. The song's status column shows its record (pending), and the
        //    worker was told to start.
        const tracks = await prisma.track.findMany({
            where: { id: { startsWith: PREFIX } },
            select: { vibeAnalysisStatus: true },
        });
        for (const track of tracks) {
            expect(track.vibeAnalysisStatus).toBe("pending");
        }
        expect(mockTriggerEnrichmentNow).toHaveBeenCalledTimes(1);
    });

    it("does not contain any embedding-data deletion in the route source", () => {
        const source = fs.readFileSync(path.join(__dirname, "..", "analysis.ts"), "utf8");
        expect(source).not.toMatch(/DELETE\s+FROM\s+track_embeddings/i);
        expect(source).not.toMatch(/DELETE\s+FROM\s+"TrackStage"[\s\S]*?stage\s*=\s*'embedding'/i);
    });
});

describe("POST /api/analysis/vibe/start without force re-opens missing answers", () => {
    it("reopens the embedding question for an analysed track whose row is missing, without deleting answered records", async () => {
        const hasRow = id("hasrow");
        const noRow = id("norow");
        await seedAnalysedTrack(hasRow, { withEmbedding: true });
        await seedAnalysedTrack(noRow, { withEmbedding: false });
        // A record with no answer row means the answer is missing.
        await putStage(noRow, "embedding", "done", 1);

        const res = await request(app)
            .post("/api/analysis/vibe/start")
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.queued).toBe(1);

        // The answered record for the track that HAS its embedding is
        // untouched; the missing one is pending again with its history kept.
        const rows = await embeddingStageRows();
        const reopened = rows.find((r) => r.trackId === noRow);
        const answered = rows.find((r) => r.trackId === hasRow);
        expect(reopened?.status).toBe("pending");
        expect(answered?.status).toBe("done");
        expect(answered?.attempt).toBe(2);
    });
});
