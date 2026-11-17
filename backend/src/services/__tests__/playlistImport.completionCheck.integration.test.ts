/**
 * The check that an import's downloads are done writes only to an import that is still waiting for them: a person who
 * cancelled it (its row is gone) or an import another path already closed or handed on is not brought back or moved
 * by a check that read it earlier. Real database and Redis; the queue and the library scan are stubbed.
 */
jest.mock("../../workers/queues", () => ({ importQueue: { add: jest.fn().mockResolvedValue(undefined) } }));
jest.mock("../../workers/scanRequest", () => ({ requestScan: jest.fn().mockResolvedValue({ queued: true, jobId: "scan-1" }) }));
jest.mock("../notificationService", () => ({
    notificationService: { create: jest.fn(), notifyImportComplete: jest.fn(), notifyImportFailed: jest.fn().mockResolvedValue(undefined) },
}));

import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { playlistImportService } from "../playlistImport";
import { notificationService } from "../notificationService";
import { requestScan } from "../../workers/scanRequest";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(60_000);

const USER = "sicc_user";
const preview = { summary: { total: 2, inLibrary: 0 }, albumsToDownload: [], matchedTracks: [] } as never;

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterEach(async () => {
    const rows = await prisma.spotifyImportJob.findMany({ where: { userId: USER }, select: { id: true } });
    for (const { id } of rows) await redisClient.del(`import:job:${id}`, `import:preview:${id}`);
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

/** An import the check reads from its cache as downloading, with `downloads` of its album jobs. */
async function downloading(downloads: string[], albumsTotal = 1) {
    const started = await playlistImportService.startImport(USER, "pl", "Road Trip", [], preview);
    await prisma.spotifyImportJob.update({ where: { id: started.id }, data: { status: "downloading", albumsTotal } });
    await redisClient.setex(`import:job:${started.id}`, 600, JSON.stringify({ ...started, status: "downloading", albumsTotal }));
    for (const status of downloads) {
        await prisma.downloadJob.create({
            data: { userId: USER, type: "album", status, subject: "album", metadata: { spotifyImportJobId: started.id } },
        });
    }
    return started.id;
}

const row = (id: string) => prisma.spotifyImportJob.findUnique({ where: { id } });

describe("checking an import's downloads", () => {
    it("does not bring back an import a person cancelled while its downloads were still running", async () => {
        const id = await downloading(["processing"]);
        await prisma.spotifyImportJob.delete({ where: { id } });
        await playlistImportService.checkImportCompletion(id);
        expect(await row(id)).toBeNull();
    });

    it("does not bring back a cancelled import whose downloads have all finished", async () => {
        const id = await downloading(["completed"]);
        await prisma.spotifyImportJob.delete({ where: { id } });
        await playlistImportService.checkImportCompletion(id);
        expect(await row(id)).toBeNull();
    });

    it("does not bring back, or tell the person of, a cancelled import that had no download jobs", async () => {
        const id = await downloading([]);
        await prisma.spotifyImportJob.delete({ where: { id } });
        await playlistImportService.checkImportCompletion(id);
        expect(await row(id)).toBeNull();
        expect(notificationService.notifyImportFailed).not.toHaveBeenCalled();
    });

    it("leaves an import another path already completed as it is", async () => {
        const id = await downloading(["completed"]);
        await prisma.spotifyImportJob.update({ where: { id }, data: { status: "completed", progress: 100 } });
        await playlistImportService.checkImportCompletion(id);
        expect(await row(id)).toMatchObject({ status: "completed", progress: 100 });
    });

    it("moves an import that is waiting for its downloads on to scanning once they have finished", async () => {
        const id = await downloading(["completed", "failed"]);
        await playlistImportService.checkImportCompletion(id);
        expect(await row(id)).toMatchObject({ status: "scanning", progress: 75 });
    });

    it("requests no scan for an import another process settled while the check was counting", async () => {
        const id = await downloading(["completed"]);
        (requestScan as jest.Mock).mockClear();
        // The import is read from its cache; the other process writes the row, not the cache.
        const real = prisma.downloadJob.findMany.bind(prisma.downloadJob);
        const spy = jest.spyOn(prisma.downloadJob, "findMany").mockImplementation((async (args: { select?: unknown }) => {
            const found = await real(args as never);
            if (args.select) await prisma.spotifyImportJob.update({ where: { id }, data: { status: "completed", progress: 100 } });
            return found;
        }) as never);

        try {
            await playlistImportService.checkImportCompletion(id);
        } finally {
            spy.mockRestore();
        }

        expect(requestScan).not.toHaveBeenCalled();
        expect(await row(id)).toMatchObject({ status: "completed", progress: 100 });
    });

    it("has the import marked as scanning before the scan is asked for", async () => {
        const id = await downloading(["completed"]);
        let statusAtRequest: string | undefined;
        (requestScan as jest.Mock).mockImplementationOnce(async () => {
            statusAtRequest = (await row(id))?.status;
            return { queued: true, jobId: "scan-1" };
        });

        await playlistImportService.checkImportCompletion(id);

        expect(statusAtRequest).toBe("scanning");
    });

    it("asks for no scan when another process already moved the import on", async () => {
        const id = await downloading(["completed"]);
        (requestScan as jest.Mock).mockClear();
        await prisma.spotifyImportJob.update({ where: { id }, data: { status: "creating_playlist", progress: 90 } });

        await playlistImportService.checkImportCompletion(id);

        expect(requestScan).not.toHaveBeenCalled();
        expect(await row(id)).toMatchObject({ status: "creating_playlist", progress: 90 });
    });

    it("puts the import back to waiting when the scan cannot be asked for, so the next check tries again", async () => {
        const id = await downloading(["completed"]);
        (requestScan as jest.Mock).mockRejectedValueOnce(new Error("queue down"));

        await expect(playlistImportService.checkImportCompletion(id)).rejects.toThrow("queue down");
        expect(await row(id)).toMatchObject({ status: "downloading" });

        await playlistImportService.checkImportCompletion(id);
        expect(await row(id)).toMatchObject({ status: "scanning", progress: 75 });
    });
});
