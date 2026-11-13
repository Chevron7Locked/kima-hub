/**
 * POST /discover/retry-unavailable downloads the albums, saves the counts, then
 * hands the batch to checkBatchCompletion, which waits for Lidarr imports. It
 * never marks the batch completed itself, and any crash in the background work
 * marks it failed ("Retry processing crashed"). Real database and router; the
 * download and the completion flow are stood in for, since they talk to Lidarr.
 */

// Sign-in is passed through; the app below sets the user.
jest.mock("../../middleware/auth", () => ({
    ...jest.requireActual("../../middleware/auth"),
    requireAuthOrToken: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    requireAcquirePermission: (_req: any, _res: any, next: any) => next(),
}));

// The queues are only here to see that no scan is asked for.
jest.mock("../../workers/queues", () => require("./helpers/discoverMocks").discoverQueuesMock());

// The two services the background job imports: acquireAlbum drives the loop,
// checkBatchCompletion is where the batch is handed off.
const mockAcquireAlbum = jest.fn();
const mockCheckBatchCompletion = jest.fn();
jest.mock("../../services/acquisitionService", () => ({
    acquisitionService: { acquireAlbum: mockAcquireAlbum },
}));
jest.mock("../../services/discoverWeekly", () => ({
    discoverWeeklyService: { checkBatchCompletion: mockCheckBatchCompletion },
}));

import express from "express";
import request from "supertest";
import { addWeeks, startOfWeek } from "date-fns";
import discoverRoutes from "../discover";
import { prisma } from "../../utils/db";
import { WEEK_STARTS_ON } from "../../lib/discoveryWeek";
import { useMidWeekClock } from "./helpers/midWeekClock";
import { scanQueue } from "../../workers/queues";
import { logger } from "../../utils/logger";
import { expectLog } from "../../__tests__/helpers/expectedLogs";

const MARK = "zz-retry";
let listener: string;

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
    req.user = { id: listener, username: `${MARK}-listener`, role: "user" };
    next();
});
app.use("/discover", discoverRoutes);

useMidWeekClock();

// The listener's latest completed batch is last week's, so that is the week the retry works on.
const WEEK = addWeeks(startOfWeek(new Date(), { weekStartsOn: WEEK_STARTS_ON }), -1);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The background work runs after the response, so poll until `predicate` holds. */
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
    for (let i = 0; i < 300; i++) {
        if (await predicate()) return;
        await sleep(10);
    }
    throw new Error(`waitFor timed out: ${label}`);
}

const handedOff = () => mockCheckBatchCompletion.mock.calls.length > 0;

// The route answers, then works on in the background with nothing to await. Its last act is one of two things: the
// "handed to completion flow" line, or the crash handler's write of the failed status. Every case waits for that
// before its cleanup deletes the user and the batch, so no background write lands on a deleted batch.
let started: string | undefined;
let infoLog: jest.SpyInstance;

/** Posts the retry, checks the answer, and remembers the batch whose background work the case must outlast. */
async function retry() {
    const res = await request(app).post("/discover/retry-unavailable");
    expect(res.status).toBe(200); // response already sent before background work
    if (res.body.batchId) started = res.body.batchId;
    return res;
}

const backgroundFinished = async (batchId: string) =>
    infoLog.mock.calls.some(([line]) => String(line).includes(`Batch ${batchId} handed to completion flow`)) ||
    (await batchRow(batchId)).errorMessage === "Retry processing crashed";
const batchRow = (id: string) => prisma.discoveryBatch.findUniqueOrThrow({ where: { id } });

async function cleanup() {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

const unavailable = (albumMbid: string, albumTitle: string) =>
    prisma.unavailableAlbum.create({
        data: {
            userId: listener,
            albumMbid,
            artistMbid: `${MARK}-art-mbid`,
            artistName: `${MARK} Aphex Twin`,
            albumTitle: `${MARK} ${albumTitle}`,
            similarity: 0.88,
            tier: "core",
            weekStartDate: WEEK,
        },
    });

/** The listener, a completed batch from last week, and the albums the retry should queue. */
async function seed(albums: Array<[mbid: string, title: string]>) {
    await prisma.discoveryBatch.create({
        data: { userId: listener, weekStart: WEEK, targetSongCount: 5, status: "completed", completedAt: new Date() },
    });
    for (const [mbid, title] of albums) await unavailable(mbid, title);
}

const ONE: Array<[string, string]> = [[`${MARK}-mbid-aaa`, "Drukqs"]];
const TWO: Array<[string, string]> = [...ONE, [`${MARK}-mbid-bbb`, "Windowlicker"]];

beforeAll(cleanup);
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

beforeEach(async () => {
    await cleanup();
    listener = (await prisma.user.create({ data: { username: `${MARK}-listener`, passwordHash: "x" } })).id;
    mockAcquireAlbum.mockReset();
    mockCheckBatchCompletion.mockReset();
    (scanQueue.add as jest.Mock).mockClear();
    infoLog = jest.spyOn(logger, "info"); // not silenced: it is how the case sees the background work end
    started = undefined;
});

afterEach(async () => {
    try {
        if (started) await waitFor(() => backgroundFinished(started!), "background work finished");
    } finally {
        infoLog.mockRestore();
    }
});

describe("POST /discover/retry-unavailable -- routes through checkBatchCompletion", () => {
    it("catches a rejected checkBatchCompletion and marks the batch failed", async () => {
        const logged = expectLog("error");
        await seed(ONE);
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockRejectedValue(new Error("reconcile exploded"));

        const res = await retry();

        await waitFor(async () => (await batchRow(res.body.batchId)).status === "failed", "batch marked failed");

        const batch = await batchRow(res.body.batchId);
        expect(batch.errorMessage).toBe("Retry processing crashed");
        expect(batch.completedAt).toBeInstanceOf(Date);
        expect(logged).toHaveBeenCalledWith(expect.stringContaining("Background processing crashed"), expect.any(Error));
    });

    it("fails the album's download job through the download-job module when acquiring it throws", async () => {
        const errorLog = expectLog("error");
        await seed(ONE);
        mockAcquireAlbum.mockRejectedValue(new Error("lidarr exploded"));
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await retry();
        await waitFor(handedOff, "checkBatchCompletion invoked");

        const [job] = await prisma.downloadJob.findMany({ where: { discoveryBatchId: res.body.batchId } });
        expect(job).toMatchObject({ status: "failed", error: "lidarr exploded" });
        expect(job.metadata).toMatchObject({ statusText: "lidarr exploded", failedAt: expect.any(String), retryOfUnavailable: true });
        expect(job.completedAt).toBeInstanceOf(Date);
        // The module told the batch, and so did the route's own handoff.
        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(res.body.batchId);
        expect(errorLog).toHaveBeenCalled();
    });

    it("never sets the batch completed itself, since checkBatchCompletion owns that", async () => {
        await seed(ONE);
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await retry();

        await waitFor(handedOff, "checkBatchCompletion invoked");
        await sleep(50);

        const batch = await batchRow(res.body.batchId);
        expect(batch.status).toBe("downloading");
        expect(batch.completedAt).toBeNull();
    });

    it("never enqueues a scan with the discover-retry-unavailable source", async () => {
        // The scan processor only builds the playlist for the discover-weekly-completion source,
        // which checkBatchCompletion queues itself.
        await seed(ONE);
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        await retry();

        await waitFor(handedOff, "checkBatchCompletion invoked");

        const retrySourceScans = (scanQueue.add as jest.Mock).mock.calls.filter(
            (c) => c[1]?.source === "discover-retry-unavailable",
        );
        expect(retrySourceScans).toHaveLength(0);
    });

    it("still hands off to checkBatchCompletion when one album fails to acquire", async () => {
        // A failed acquire must not short-circuit into a self-completed batch.
        await seed(TWO);
        mockAcquireAlbum.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await retry();

        await waitFor(handedOff, "checkBatchCompletion invoked after partial failure");
        await sleep(50);

        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(res.body.batchId);
        expect((await batchRow(res.body.batchId)).status).toBe("downloading");
    });

    it("queues a batch with a download job per album, clears the week's unavailable list, and hands the batch off after the acquisitions", async () => {
        await seed(ONE);
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await retry();

        expect(res.body.success).toBe(true);
        expect(res.body.queued).toBe(1);

        const batch = await batchRow(res.body.batchId);
        expect(batch).toMatchObject({ userId: listener, targetSongCount: 1, totalAlbums: 1 });
        expect(batch.weekStart.getTime()).toBe(WEEK.getTime());

        const jobs = await prisma.downloadJob.findMany({ where: { discoveryBatchId: batch.id } });
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ userId: listener, targetMbid: ONE[0][0], status: "pending" });
        expect(jobs[0].metadata).toMatchObject({ downloadType: "discovery", albumMbid: ONE[0][0], retryOfUnavailable: true });
        expect(await prisma.unavailableAlbum.count({ where: { userId: listener } })).toBe(0);

        await waitFor(handedOff, "checkBatchCompletion invoked on happy path");

        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(batch.id);
        expect(mockAcquireAlbum).toHaveBeenCalledTimes(1);
        expect(mockAcquireAlbum.mock.calls[0][1]).toMatchObject({ userId: listener, discoveryBatchId: batch.id, existingJobId: jobs[0].id });
    });

    it("writes the completed and failed tally to the batch before handing off", async () => {
        // One success and one failure: completedAlbums 1, failedAlbums 1.
        await seed(TWO);
        mockAcquireAlbum.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
        // checkBatchCompletion would read stale counts if the tally landed after it, so read them as it would.
        let tallyAtHandoff: { completedAlbums: number; failedAlbums: number } | undefined;
        mockCheckBatchCompletion.mockImplementation(async (batchId: string) => {
            const { completedAlbums, failedAlbums } = await batchRow(batchId);
            tallyAtHandoff = { completedAlbums, failedAlbums };
        });

        await retry();

        await waitFor(() => tallyAtHandoff !== undefined, "handoff recorded");

        expect(tallyAtHandoff).toEqual({ completedAlbums: 1, failedAlbums: 1 });
    });

    it("acquires the albums before handing the batch off", async () => {
        await seed(ONE);
        const order: string[] = [];
        mockAcquireAlbum.mockImplementation(async () => {
            order.push("acquire");
            return { success: true };
        });
        mockCheckBatchCompletion.mockImplementation(async () => {
            order.push("handoff");
        });

        await retry();

        await waitFor(() => order.includes("handoff"), "handoff after acquire");

        expect(order).toEqual(["acquire", "handoff"]);
    });

    it("marks the batch failed when a failure comes before the handoff", async () => {
        expectLog("error");
        await seed(ONE);
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        // The per-job count write swallows its errors; the count write after the loop is awaited
        // unguarded. Refuse both, so the second one crashes the background work.
        const refusal = jest
            .spyOn(prisma.discoveryBatch, "update")
            .mockRejectedValueOnce(new Error("count persist exploded"))
            .mockRejectedValueOnce(new Error("count persist exploded"));
        try {
            const res = await retry();

            await waitFor(async () => (await batchRow(res.body.batchId)).status === "failed", "pre-handoff crash marks batch failed");

            expect((await batchRow(res.body.batchId)).errorMessage).toBe("Retry processing crashed");
            expect(mockCheckBatchCompletion).not.toHaveBeenCalled();
        } finally {
            refusal.mockRestore();
        }
    });

    it("hands the batch off once, not once per album", async () => {
        await seed(TWO);
        mockAcquireAlbum.mockResolvedValue({ success: true });
        mockCheckBatchCompletion.mockResolvedValue(undefined);

        const res = await retry();

        await waitFor(handedOff, "checkBatchCompletion invoked");
        await waitFor(() => mockAcquireAlbum.mock.calls.length === 2, "both albums acquired");
        // Give an extra handoff a chance to fire before asserting there was one.
        await sleep(50);

        expect(mockCheckBatchCompletion).toHaveBeenCalledTimes(1);
        expect(mockCheckBatchCompletion).toHaveBeenCalledWith(res.body.batchId);
    });

    it("does not queue again an album a download is already working on", async () => {
        await seed(ONE);
        await prisma.downloadJob.create({
            data: { userId: listener, subject: `${MARK} Aphex Twin - ${MARK} Drukqs`, type: "album", status: "processing", targetMbid: ONE[0][0] },
        });

        const res = await request(app).post("/discover/retry-unavailable");

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, queued: 0, message: "The unavailable albums are already downloading" });
        // Only the seeded completed batch; no retry batch was made, and the album stays listed.
        expect(await prisma.discoveryBatch.count({ where: { userId: listener } })).toBe(1);
        expect(await prisma.unavailableAlbum.count({ where: { userId: listener } })).toBe(1);
        expect(mockAcquireAlbum).not.toHaveBeenCalled();
    });
});
