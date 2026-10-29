/**
 * MusiCNN and CLAP run one at a time across the library: no sound vector is offered while any track's analysis is
 * owed, in flight or due a retry, and no analysis while CLAP is working on a track. An analysis waiting out a retry
 * delay, a paused analyzer, or an analyzer that is not running holds nothing back. Real test database.
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
import { getNextWork, vectorsInFlight } from "../unifiedEnrichment";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";

// The key the CLAP worker publishes its running-job count to; written here the
// same way the analyzer writes it (plain SET on the shared Redis).
const inflightRedis = new Redis(config.redisUrl);
const INFLIGHT_KEY = "clap:worker:inflight";

const P = "onehm";
const A = `${P}_a`;
const B = `${P}_b`;

const analysis = (trackId: string, data: Record<string, unknown>) =>
    prisma.trackStage.upsert({
        where: { trackId_stage: { trackId, stage: "analysis" } },
        create: { trackId, stage: "analysis", ...data },
        update: data,
    });
const offered = async (stage: "analysis" | "embedding") =>
    (await getNextWork(50, stage)).map((w) => w.trackId).filter((id) => id.startsWith(P)).sort();

beforeAll(async () => {
    await prisma.artist.create({ data: { id: `${P}_art`, name: "One Heavy", identityKey: `${P}_ak` } });
    await prisma.album.create({ data: { id: `${P}_alb`, rgMbid: `${P}_rg`, artistId: `${P}_art`, title: "One Heavy", primaryType: "Album" } });
    for (const id of [A, B]) {
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
    // A worker that published no running jobs starts every test, whatever a
    // previous one left on the shared key.
    await inflightRedis.set(INFLIGHT_KEY, "0");
    // Only this file's tracks: every other track in the database counts as analysed.
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage" (id, "trackId", stage, status) SELECT '${P}_ts_' || id, id, 'analysis', 'done' FROM "Track" t
          WHERE id NOT LIKE '${P}_%' AND NOT EXISTS (SELECT 1 FROM "TrackStage" s WHERE s."trackId" = t.id AND s.stage = 'analysis')`,
    );
    await prisma.trackStage.deleteMany({ where: { trackId: { in: [A, B] } } });
    await analysis(A, { status: "done" });
});

const bothAtOnce = async (on: boolean) => {
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default", analysisAndVectorsTogether: on },
        update: { analysisAndVectorsTogether: on },
    });
    invalidateSystemSettingsCache();
};

afterEach(() => bothAtOnce(false));

// Leave the published count at zero when the file's tests are done (an afterEach, not an
// afterAll: the shared ioredis clients are closed before the file's afterAll hooks run).
afterEach(() => inflightRedis.set(INFLIGHT_KEY, "0"));

afterAll(async () => {
    await prisma.trackStage.deleteMany({ where: { OR: [{ trackId: { startsWith: P } }, { id: { startsWith: `${P}_ts_` } }] } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: `${P}_alb` } });
    await prisma.artist.deleteMany({ where: { id: `${P}_art` } });
    await closeEngineConnections();
});

it("offers no sound vector while another track's analysis is owed or in flight", async () => {
    expect(await offered("embedding")).toEqual([]); // B never asked
    await analysis(B, { status: "working" });
    expect(await offered("embedding")).toEqual([]);
    await analysis(B, { status: "failed", retryable: true, nextRetryAt: null });
    expect(await offered("embedding")).toEqual([]);
});

it("starts the vectors once every analysis is answered", async () => {
    await analysis(B, { status: "done" });
    expect(await offered("embedding")).toEqual([A, B]);
});

it("does not wait on an analysis that failed for good, waits out a retry delay, or cannot run", async () => {
    await analysis(B, { status: "failed", retryable: false });
    expect(await offered("embedding")).toEqual([A]);

    await analysis(B, { status: "failed", retryable: true, nextRetryAt: new Date(Date.now() + 3_600_000) });
    expect(await offered("embedding")).toEqual([A]);

    await analysis(B, { status: "pending" });
    (sourcePauseController.isPaused as jest.Mock).mockImplementation(async (source: string) => source === "analyzer");
    expect(await offered("embedding")).toEqual([A]);

    (sourcePauseController.isPaused as jest.Mock).mockResolvedValue(false);
    (featureDetection.analyzerRunning as jest.Mock).mockResolvedValue(false);
    expect(await offered("embedding")).toEqual([A]);
});

it("holds analysis while CLAP is working on a track, unless CLAP is not running", async () => {
    await analysis(B, { status: "pending" });
    await prisma.trackStage.create({
        data: { trackId: A, stage: "embedding", status: "working", startedAt: new Date(), nextRetryAt: new Date(Date.now() + 900_000) },
    });
    expect(await offered("analysis")).toEqual([]);
    // A claim whose lease ran out died without answering: it holds nothing.
    await prisma.trackStage.update({
        where: { trackId_stage: { trackId: A, stage: "embedding" } },
        data: { nextRetryAt: new Date(Date.now() - 1000) },
    });
    expect(await offered("analysis")).toEqual([B]);
    await prisma.trackStage.update({
        where: { trackId_stage: { trackId: A, stage: "embedding" } },
        data: { nextRetryAt: new Date(Date.now() + 900_000) },
    });
    (featureDetection.clapRunning as jest.Mock).mockResolvedValue(false);
    expect(await offered("analysis")).toEqual([B]);
    (featureDetection.clapRunning as jest.Mock).mockResolvedValue(true);
    await prisma.trackStage.update({ where: { trackId_stage: { trackId: A, stage: "embedding" } }, data: { status: "done" } });
    expect(await offered("analysis")).toEqual([B]);
});

it("runs both side by side when an admin chose that", async () => {
    await bothAtOnce(true);
    await analysis(B, { status: "pending" });
    expect(await offered("embedding")).toEqual([A]);
    await prisma.trackStage.create({
        data: { trackId: A, stage: "embedding", status: "working", startedAt: new Date(), nextRetryAt: new Date(Date.now() + 900_000) },
    });
    expect(await offered("analysis")).toEqual([B]);
});

it("holds analysis while CLAP reports running jobs, with no embedding rows left", async () => {
    // A re-run resets the embedding stage rows to pending, so the claim-row
    // check sees nothing; the worker's published count is all that is left.
    await analysis(B, { status: "pending" });
    await inflightRedis.set(INFLIGHT_KEY, "2");
    expect(await vectorsInFlight()).toBe(true);
    expect(await offered("analysis")).toEqual([]);

    // The count falls to zero when the jobs finish: analysis goes first again.
    await inflightRedis.set(INFLIGHT_KEY, "0");
    expect(await vectorsInFlight()).toBe(false);
    expect(await offered("analysis")).toEqual([B]);
});

it("ignores the running-job count when the CLAP heartbeat is stale", async () => {
    // A worker that died mid-batch leaves its count published; the stale
    // heartbeat says no CLAP is running, so analysis must not wait for it.
    await analysis(B, { status: "pending" });
    await inflightRedis.set(INFLIGHT_KEY, "3");
    (featureDetection.clapRunning as jest.Mock).mockResolvedValue(false);
    expect(await vectorsInFlight()).toBe(false);
    expect(await offered("analysis")).toEqual([B]);
});
