/**
 * An import whose preview cannot be kept for its worker is failed at once, with its reason, and never queued: the worker
 * would only throw "Preview not found" later. The person is told once, as for any failed import. Real database and Redis;
 * the queue is stubbed so a queued import can be seen.
 */
const mockQueueAdd = jest.fn();
jest.mock("../../workers/queues", () => ({ importQueue: { add: (...args: unknown[]) => mockQueueAdd(...args) } }));

import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { playlistImportService } from "../playlistImport";
import { notificationService } from "../notificationService";
import { eventBus, type SSEEvent } from "../eventBus";
import * as downloadJobs from "../downloads/jobs";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "zz-keep-preview-user";
const preview = {
    playlist: { id: "90210", name: "Road trip", description: null, owner: "x", imageUrl: null, trackCount: 1 },
    matchedTracks: [],
    albumsToDownload: [],
    summary: { total: 1, inLibrary: 0, downloadable: 0, notFound: 1 },
} as never;

let notifyFailed: jest.SpyInstance;
let heard: SSEEvent[];
let stop: () => void;

beforeAll(async () => {
    await waitForRedisReady();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

beforeEach(() => {
    mockQueueAdd.mockReset();
    notifyFailed = jest.spyOn(notificationService, "notifyImportFailed").mockResolvedValue(undefined as never);
    heard = [];
    stop = eventBus.subscribe(USER, { send: (event) => (heard.push(event), true) });
});

afterEach(async () => {
    stop();
    jest.restoreAllMocks();
    await downloadJobs.whenIdle();
    const ids = (await prisma.spotifyImportJob.findMany({ where: { userId: USER }, select: { id: true } })).map((j) => j.id);
    await Promise.all(ids.map((id) => redisClient.del(`import:job:${id}`, `import:preview:${id}`)));
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

/** Redis refuses only the write of the preview. */
const previewWriteFails = () => {
    const real = redisClient.setex.bind(redisClient);
    jest.spyOn(redisClient, "setex").mockImplementation(((key: string, ...rest: unknown[]) =>
        key.startsWith("import:preview:") ? Promise.reject(new Error("redis down")) : (real as any)(key, ...rest)) as never);
};

it("queues an import whose preview was kept", async () => {
    const job = await playlistImportService.startImport(USER, "90210", "Road trip", [], preview);

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(await redisClient.get(`import:preview:${job.id}`)).not.toBeNull();
    expect((await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("pending");
});

it("fails an import at once, with a reason, when its preview cannot be kept, and does not queue it", async () => {
    previewWriteFails();

    const job = await playlistImportService.startImport(USER, "90210", "Road trip", [], preview);
    await downloadJobs.whenIdle();

    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(job.status).toBe("failed");
    expect(job.error).toEqual(expect.stringContaining("preview"));
    const row = await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("failed");
    expect(row.error).toBe(job.error);
    expect(notifyFailed).toHaveBeenCalledTimes(1);
    // The page heard the import start, then fail, once.
    const statuses = heard.map((e) => (e.payload as { status: string }).status);
    expect(statuses[statuses.length - 1]).toBe("failed");
    expect(statuses.filter((s) => s === "failed")).toHaveLength(1);
});
