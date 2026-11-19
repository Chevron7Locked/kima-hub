/**
 * Every way an import ends stops its work at once: the searches still running for it are aborted (so none can start a
 * download for an import that is over), and when its downloads are removed they go in the import's own lane, after the
 * completion checks already queued there have read them. Real database and Redis.
 */
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { playlistImportService, failImportJob } from "../playlistImport";
import { trackImportSearches } from "../playlistImport/jobState";
import * as downloadJobs from "../downloads/jobs";
import { connectJobOwners } from "../downloads/owners";
import { notificationService } from "../notificationService";
import { eventBus } from "../eventBus";
import { useLidarrCancelScenario } from "../../__tests__/helpers/lidarrCancelScenario";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

useLidarrCancelScenario();

const USER = "zz-end-import-user";

const importRow = (status: string, pendingTracks: unknown[] = []) =>
    prisma.spotifyImportJob.create({
        data: {
            userId: USER, spotifyPlaylistId: "37i9dQZF1DXcBWIGoYBM5M", playlistName: "Today's Top Hits",
            status, progress: 50, albumsTotal: 2, tracksTotal: 2, pendingTracks: pendingTracks as any,
        },
    });

const downloadJob = (importJobId: string, status: string) =>
    prisma.downloadJob.create({
        data: {
            userId: USER, subject: `Album ${status}`, type: "album", status,
            metadata: { downloadType: "spotify_import", spotifyImportJobId: importJobId },
        },
    });

/** What an import running in this process registers: the controller its searches listen to. */
const searching = (importJobId: string) => {
    const controller = new AbortController();
    trackImportSearches(importJobId, controller);
    return controller;
};

beforeAll(async () => {
    connectJobOwners();
    await waitForRedisReady();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

beforeEach(() => {
    jest.spyOn(notificationService, "notifyImportFailed").mockResolvedValue(undefined as never);
});

afterEach(async () => {
    jest.restoreAllMocks();
    await downloadJobs.whenIdle();
    const ids = (await prisma.spotifyImportJob.findMany({ where: { userId: USER }, select: { id: true } })).map((j) => j.id);
    await Promise.all(ids.map((id) => redisClient.del(`import:job:${id}`)));
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

describe("an import that ends aborts its searches", () => {
    it("when it is cancelled", async () => {
        const running = await importRow("downloading");
        const controller = searching(running.id);

        await playlistImportService.cancelJob(running.id);

        expect(controller.signal.aborted).toBe(true);
    });

    it("when it is failed from outside", async () => {
        const running = await importRow("downloading");
        const controller = searching(running.id);

        expect(await failImportJob(running.id, "Cleaned up as stale")).toBe(true);

        expect(controller.signal.aborted).toBe(true);
    });

    it("when its worker fails it with nothing matched", async () => {
        const running = await importRow("downloading");
        const controller = searching(running.id);

        await playlistImportService.markJobFailed(running.id, "worker gave up");

        expect(controller.signal.aborted).toBe(true);
    });

    it("even when announcing the nothing-matched failure throws", async () => {
        const running = await importRow("downloading");
        const controller = searching(running.id);
        jest.spyOn(notificationService, "notifyImportFailed").mockRejectedValue(new Error("tray down"));
        jest.spyOn(eventBus, "emit").mockImplementation(() => { throw new Error("bus down"); });

        await expect(playlistImportService.markJobFailed(running.id, "worker gave up")).rejects.toThrow("bus down");

        expect(controller.signal.aborted).toBe(true);
    });

    it("when its worker fails it with some songs matched", async () => {
        const running = await importRow("downloading", [{ preMatchedTrackId: "t1" }]);
        const controller = searching(running.id);

        await playlistImportService.markJobFailed(running.id, "worker gave up");

        expect(controller.signal.aborted).toBe(true);
    });

    it("but not when the failure is late and the import had already completed", async () => {
        const done = await importRow("completed");
        const controller = searching(done.id);

        expect(await failImportJob(done.id, "late reason")).toBe(false);

        expect(controller.signal.aborted).toBe(false);
    });
});

it("deletes an import's downloads after the completion check already queued for it has read them", async () => {
    const running = await importRow("downloading");
    const pending = await downloadJob(running.id, "pending");
    let rowsSeenByCheck = -1;
    jest.spyOn(playlistImportService, "checkImportCompletion").mockImplementation(async (id: string) => {
        await new Promise((r) => setTimeout(r, 150));
        rowsSeenByCheck = await prisma.downloadJob.count({ where: { metadata: { path: ["spotifyImportJobId"], equals: id } } });
    });

    // A download settling queues a check of its import; the import is cancelled while the check is still running.
    await downloadJobs.fail([pending], "boom");
    await playlistImportService.cancelJob(running.id);
    await downloadJobs.whenIdle();

    expect(rowsSeenByCheck).toBe(1);
    expect(await prisma.downloadJob.count({ where: { userId: USER } })).toBe(0);
    expect(await prisma.spotifyImportJob.count({ where: { id: running.id } })).toBe(0);
});
