/**
 * MusiCNN and CLAP each finish their whole run before the other starts. Once CLAP has started, a song added mid-run
 * waits for analysis until CLAP has no song left; a CLAP that is not running, is paused, or has only answers waiting
 * out a retry delay holds nothing back. Real test database and Redis.
 */
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../../services/featureDetection", () => ({
    featureDetection: { getFeatures: jest.fn(), analyzerRunning: jest.fn(), clapRunning: jest.fn() },
}));
jest.mock("../../services/sourcePauseController", () => ({
    sourcePauseController: { isPaused: jest.fn() },
}));
jest.mock("../../services/gpuRuntime", () => ({
    ...jest.requireActual("../../services/gpuRuntime"),
    embeddingsDeferredForGpu: jest.fn().mockResolvedValue(false),
}));

import Redis from "ioredis";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { featureDetection } from "../../services/featureDetection";
import { sourcePauseController } from "../../services/sourcePauseController";
import { getNextWork } from "../unifiedEnrichment";

const redis = new Redis(config.redisUrl);
const RUN_KEY = "enrichment:heavy-run";
const INFLIGHT_KEY = "clap:worker:inflight";

const P = "heavyrun";
const [A, B, C] = ["a", "b", "c"].map((n) => `${P}_${n}`);

const stage = (trackId: string, name: "analysis" | "embedding", data: Record<string, unknown>) =>
    prisma.trackStage.upsert({
        where: { trackId_stage: { trackId, stage: name } },
        create: { trackId, stage: name, ...data },
        update: data,
    });
const offered = async (name: "analysis" | "embedding") =>
    (await getNextWork(50, name)).map((w) => w.trackId).filter((id) => id.startsWith(P)).sort();

beforeAll(async () => {
    await prisma.artist.create({ data: { id: `${P}_art`, name: "Heavy Run", identityKey: `${P}_ak` } });
    await prisma.album.create({ data: { id: `${P}_alb`, rgMbid: `${P}_rg`, artistId: `${P}_art`, title: "Heavy Run", primaryType: "Album" } });
    for (const id of [A, B, C]) {
        await prisma.track.create({
            data: { id, albumId: `${P}_alb`, title: id, trackNo: 1, duration: 180, filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
});

beforeEach(async () => {
    (featureDetection.getFeatures as jest.Mock).mockResolvedValue({ musicCNN: true, vibeEmbeddings: true });
    (featureDetection.analyzerRunning as jest.Mock).mockResolvedValue(true);
    (featureDetection.clapRunning as jest.Mock).mockResolvedValue(true);
    (sourcePauseController.isPaused as jest.Mock).mockResolvedValue(false);
    await redis.set(INFLIGHT_KEY, "0");
    // Every other track in the database counts as analysed and embedded.
    for (const name of ["analysis", "embedding"]) {
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage" (id, "trackId", stage, status) SELECT '${P}_${name}_' || id, id, '${name}', 'done' FROM "Track" t
              WHERE id NOT LIKE '${P}_%' AND NOT EXISTS (SELECT 1 FROM "TrackStage" s WHERE s."trackId" = t.id AND s.stage = '${name}')`,
        );
    }
    await prisma.trackStage.deleteMany({ where: { trackId: { in: [A, B, C] } } });
    // MusiCNN finished A and B, CLAP took over the run; C has just been added.
    await stage(A, "analysis", { status: "done" });
    await stage(B, "analysis", { status: "done" });
    await redis.set(RUN_KEY, "embedding");
});

// In an afterEach: the shared Redis clients are closed before the file's afterAll hooks run.
afterEach(async () => {
    await redis.del(RUN_KEY);
    await redis.set(INFLIGHT_KEY, "0");
});

afterAll(async () => {
    await prisma.trackStage.deleteMany({ where: { OR: [{ trackId: { startsWith: P } }, { id: { startsWith: `${P}_` } }] } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: `${P}_alb` } });
    await prisma.artist.deleteMany({ where: { id: `${P}_art` } });
    await closeEngineConnections();
});

it("a song added during CLAP's run waits until CLAP has no song left", async () => {
    // Between CLAP's batches: nothing in flight, A and B still owed their vectors.
    expect(await offered("analysis")).toEqual([]);
    expect(await offered("embedding")).toEqual([A, B]);
    await stage(A, "embedding", { status: "working", nextRetryAt: new Date(Date.now() + 60_000) });
    expect(await offered("analysis")).toEqual([]);
    await stage(A, "embedding", { status: "done" });
    await stage(B, "embedding", { status: "done" });
    expect(await offered("analysis")).toEqual([C]);
});

it("CLAP waits for MusiCNN's run once MusiCNN has taken it", async () => {
    await redis.set(RUN_KEY, "analysis");
    expect(await offered("embedding")).toEqual([]);
    expect(await offered("analysis")).toEqual([C]);
});

it("does not hold analysis for a vector waiting out a retry delay", async () => {
    await stage(A, "embedding", { status: "failed", retryable: true, nextRetryAt: new Date(Date.now() + 3_600_000) });
    await stage(B, "embedding", { status: "done" });
    expect(await offered("analysis")).toEqual([C]);
});

it("does not hold analysis for a vector parked until later", async () => {
    await stage(A, "embedding", { status: "pending", retryable: true, nextRetryAt: new Date(Date.now() + 3_600_000) });
    await stage(B, "embedding", { status: "done" });
    expect(await offered("embedding")).toEqual([]);
    expect(await offered("analysis")).toEqual([C]);
});

it("does not hold analysis when CLAP is not running or its source is paused", async () => {
    (featureDetection.clapRunning as jest.Mock).mockResolvedValue(false);
    expect(await offered("analysis")).toEqual([C]);
    (featureDetection.clapRunning as jest.Mock).mockResolvedValue(true);
    (sourcePauseController.isPaused as jest.Mock).mockImplementation(async (source: string) => source === "clap");
    expect(await offered("analysis")).toEqual([C]);
});
