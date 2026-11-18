/**
 * The end of a Discover batch removes the Discover artists in Lidarr that nothing keeps, sparing the artists this batch
 * downloaded. It reads Lidarr the way the queued artist job does, so a Lidarr it cannot read, or an artist Lidarr
 * refuses, reaches every admin's tray instead of passing as "no artists". Real database and Redis; Lidarr is a mock in
 * which every artist has no files, so a removal is Lidarr forgetting it. The batch here downloaded one album of artist 1,
 * scanned into Discover, so the build makes its playlist and then goes through the artists.
 */
import { discoverWeeklyService } from "../../discoverWeekly";
import { prisma } from "../../../utils/db";
import { lidarrService } from "../../lidarr";
import { discoverBuildFixtures } from "../../../__tests__/helpers/discoverBuildFixtures";
import { discoverArtistsGroupKey } from "../discoverArtistCleanup";
import { eventBus } from "../../eventBus";

jest.mock("../../discovery", () => ({
    discoveryBatchLogger: { info: jest.fn(), error: jest.fn() },
    discoverySeeding: { getSeedArtists: jest.fn().mockResolvedValue([]) },
    discoveryAlbumLifecycle: { processBeforeGeneration: jest.fn() },
}));
jest.mock("../../lidarr", () => ({
    lidarrService: {
        readDiscoveryTaggedArtists: jest.fn(),
        getOrCreateDiscoveryTag: jest.fn(),
        getAlbumsByArtistId: jest.fn(),
        deleteArtistById: jest.fn(),
        removeDiscoveryTagByMbid: jest.fn(),
    },
}));
// cleanupOrphanedLidarrQueue reads the settings after the artists; no Lidarr queue to clean here.
jest.mock("../../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../eventBus", () => ({ eventBus: { emit: jest.fn() } }));
jest.mock("../../../workers/queues", () => ({
    scanQueue: { add: jest.fn() },
    discoverQueue: { add: jest.fn() },
    discoverArtistsQueue: { getJobs: jest.fn(), add: jest.fn() },
}));
jest.mock("../../musicbrainz", () => ({ musicBrainzService: {} }));
jest.mock("../../acquisitionService", () => ({ acquisitionService: {} }));
jest.mock("../../discoveryLogger", () => ({
    discoveryLogger: { info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../artistCountsService", () => ({ updateArtistCounts: jest.fn() }));

const P = "zz-buildArtists-";
const fx = discoverBuildFixtures(P);
const ADMIN = `${P}admin`;
const TAG = 31;
const lidarr = lidarrService as jest.Mocked<typeof lidarrService>;

const artist = (id: number, artistName: string) => ({ id, artistName, foreignArtistId: `${P}mbid-${id}`, tags: [TAG] }) as any;
const trayRow = () => prisma.notification.findUnique({ where: { userId_groupKey: { userId: ADMIN, groupKey: discoverArtistsGroupKey } } });

/** A scanning batch with one finished, scanned download of artist 1, built to its end. */
async function endBatch(batchId: string) {
    await fx.seedScanningBatch(batchId, [
        { artistName: "Interpol", albumTitle: "Antics", albumMbid: `${P}rg-1`, artistMbid: `${P}mbid-1` },
    ]);
    await fx.seedDiscoverSong(batchId, { artistName: "Interpol", albumTitle: "Antics", rgMbid: `${P}rg-1` });
    await discoverWeeklyService.buildFinalPlaylist(batchId);
}

async function wipe() {
    await fx.wipe();
    await prisma.notification.deleteMany({ where: { groupKey: discoverArtistsGroupKey } });
    await prisma.user.deleteMany({ where: { id: ADMIN } });
}

beforeAll(wipe);
afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
    lidarr.getOrCreateDiscoveryTag.mockResolvedValue(TAG);
    lidarr.getAlbumsByArtistId.mockResolvedValue([{ id: 7, artistId: 1, title: "A", foreignAlbumId: `${P}rg-x`, statistics: { trackFileCount: 0 } }] as any);
    lidarr.deleteArtistById.mockResolvedValue({ success: true, message: "Artist deleted" });
});

describe("the artists at the end of a Discover batch", () => {
    it("puts a Lidarr it could not read in the admin tray, never taking that for no artists", async () => {
        lidarr.readDiscoveryTaggedArtists.mockRejectedValue(new Error("connect ECONNREFUSED"));

        await endBatch(`${P}batch-unread`);

        expect((await fx.batch(`${P}batch-unread`))?.status).toBe("completed");
        const row = await trayRow();
        expect(row?.title).toBe("Discover's artists not removed from Lidarr");
        expect(row?.message).toContain("connect ECONNREFUSED");
    });

    it("spares the artist this batch downloaded, removes the rest, and names the one Lidarr refused in the tray", async () => {
        lidarr.readDiscoveryTaggedArtists.mockResolvedValue([artist(1, "Interpol"), artist(2, "Low"), artist(3, "Slint")]);
        lidarr.deleteArtistById.mockImplementation(async (id: number) =>
            id === 3 ? { success: false, message: "timeout of 30000ms exceeded" } : { success: true, message: "Artist deleted" },
        );

        await endBatch(`${P}batch-artists`);

        expect(lidarr.deleteArtistById.mock.calls.map(([id]) => id).sort()).toEqual([2, 3]);
        // Spared before anything was asked of Lidarr about it.
        expect(lidarr.getAlbumsByArtistId).not.toHaveBeenCalledWith(1);
        const row = await trayRow();
        expect(row?.title).toBe("1 Discover artist not removed from Lidarr");
        expect(row?.message).toContain("Slint: timeout of 30000ms exceeded");
    });

    it("removes the artists and tells the page the batch failed when the scan found no songs", async () => {
        lidarr.readDiscoveryTaggedArtists.mockResolvedValue([artist(1, "Interpol"), artist(2, "Low")]);
        const batchId = `${P}batch-nosongs`;
        await fx.seedScanningBatch(batchId, [
            { artistName: "Interpol", albumTitle: "Antics", albumMbid: `${P}rg-1`, artistMbid: `${P}mbid-1` },
        ]);

        await discoverWeeklyService.buildFinalPlaylist(batchId);

        expect((await fx.batch(batchId))?.status).toBe("failed");
        expect(lidarr.deleteArtistById.mock.calls.map(([id]) => id)).toEqual([2]);
        expect(eventBus.emit).toHaveBeenCalledWith(
            expect.objectContaining({ type: "discover:complete", payload: { batchId, status: "failed" } }),
        );
    });
});
