/**
 * Before acquisition starts a download for an import, it asks whether the import is still open (the caller's check of
 * its stored status), so a stop from another process holds the searches where the in-process abort cannot reach.
 * Real database; Soulseek, Lidarr and MusicBrainz are stubbed.
 */
jest.mock("../soulseek", () => ({
    soulseekService: { searchAndDownloadAlbum: jest.fn(), searchAndDownloadBatch: jest.fn(), isAvailable: jest.fn().mockResolvedValue(true) },
}));
jest.mock("../simpleDownloadManager", () => ({ simpleDownloadManager: { startDownload: jest.fn() } }));

import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { soulseekService } from "../soulseek";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { acquisitionService } from "../acquisitionService";

const USER = "acquisition_import_open_user";
const REQUEST = { artistName: "Brad Sucks", albumTitle: "Guess Who's a Mess", mbid: "d0484284-1ee7-4157-951a-50f003cbcfb4", requestedTracks: [{ title: "One" }] };
const closed = { userId: USER, spotifyImportJobId: "an-import", stillOpen: jest.fn().mockResolvedValue(false) };

const downloadJobs = () => prisma.downloadJob.count({ where: { userId: USER } });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

beforeEach(() => {
    (soulseekService.searchAndDownloadAlbum as jest.Mock).mockReset();
    (soulseekService.searchAndDownloadBatch as jest.Mock).mockReset();
    (simpleDownloadManager.startDownload as jest.Mock).mockReset();
});

describe("an import that is no longer open", () => {
    it("has no album acquired", async () => {
        const result = await acquisitionService.acquireAlbum(REQUEST, closed);

        expect(result).toMatchObject({ success: false, error: "Import cancelled" });
        expect(await downloadJobs()).toBe(0);
        expect(soulseekService.searchAndDownloadAlbum).not.toHaveBeenCalled();
        expect(simpleDownloadManager.startDownload).not.toHaveBeenCalled();
    });

    it("starts no Soulseek or Lidarr download for an album already past the queue", async () => {
        const viaSoulseek = await (acquisitionService as any).acquireAlbumViaSoulseek(REQUEST, closed);
        const viaLidarr = await (acquisitionService as any).acquireAlbumViaLidarr(REQUEST, closed);

        expect(viaSoulseek).toMatchObject({ success: false, error: "Import cancelled" });
        expect(viaLidarr).toMatchObject({ success: false, error: "Import cancelled" });
        expect(await downloadJobs()).toBe(0);
    });

    it("has no tracks acquired", async () => {
        const results = await acquisitionService.acquireTracks([{ artistName: "Brad Sucks", trackTitle: "One", albumTitle: "x" }], closed);

        expect(results).toEqual([{ success: false, error: "Import cancelled" }]);
        expect(soulseekService.searchAndDownloadBatch).not.toHaveBeenCalled();
    });
});
