/**
 * buildFinalPlaylist marks the batch failed when the playlist transaction
 * throws. The fixture holds a Discover song so the build reaches the transaction.
 * Real database; the batch's stored status and message are what is checked.
 */
import { discoverWeeklyService } from "../../discoverWeekly";
import { prisma } from "../../../utils/db";
import { discoverBuildFixtures } from "../../../__tests__/helpers/discoverBuildFixtures";

// getSeedArtists returns [] so only the popular fallback runs.
jest.mock("../../discovery", () => ({
    discoveryBatchLogger: { info: jest.fn(), error: jest.fn() },
    discoverySeeding: { getSeedArtists: jest.fn().mockResolvedValue([]) },
    discoveryAlbumLifecycle: { processBeforeGeneration: jest.fn() },
}));

// cleanupFailedArtists calls lidarrService.getDiscoveryArtists after the catch
// and cleanupOrphanedLidarrQueue calls getSystemSettings. Both run on every
// buildFinalPlaylist exit path, so stub them to no-op/empty.
jest.mock("../../lidarr", () => ({
    lidarrService: {
        getDiscoveryArtists: jest.fn().mockResolvedValue([]),
    },
}));
jest.mock("../../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue(null),
}));

// eventBus.emit fires after the catch; stubbed to leave the real channel alone.
jest.mock("../../eventBus", () => ({
    eventBus: { emit: jest.fn() },
}));

// Import-time-only heavy deps (BullMQ queues instantiate at module load,
// the musicbrainz/acquisition chain pulls network clients). Stub so the module
// graph loads without opening Redis/HTTP handles.
jest.mock("../../../workers/queues", () => ({
    scanQueue: { add: jest.fn() },
    discoverQueue: { add: jest.fn() },
}));
jest.mock("../../musicbrainz", () => ({ musicBrainzService: {} }));
jest.mock("../../acquisitionService", () => ({ acquisitionService: {} }));
jest.mock("../../discoveryLogger", () => ({
    discoveryLogger: { info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../artistCountsService", () => ({
    updateArtistCounts: jest.fn(),
}));

const P = "zz-buildFail-";
const fx = discoverBuildFixtures(P);

/** A scanning batch whose one completed job has a matching Discover song, so the build reaches the playlist transaction. */
async function arrangeBatchWithOneAlbum(batchId: string) {
    await fx.seedScanningBatch(batchId, [
        { artistName: "Test Artist", albumTitle: "Test Album", albumMbid: "mbid-123" },
    ]);
    await fx.seedDiscoverSong(batchId, { artistName: "Test Artist", albumTitle: "Test Album", rgMbid: "mbid-123" });
}

const failTransaction = (message: string) =>
    jest.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error(message) as never);

describe("buildFinalPlaylist failure handling", () => {
    beforeAll(fx.wipe);
    afterAll(fx.wipe);
    beforeEach(async () => {
        jest.restoreAllMocks();
        await fx.wipe();
    });

    it("marks the batch failed when the playlist transaction throws, not through the no-tracks exit", async () => {
        const id = `${P}batch-1`;
        await arrangeBatchWithOneAlbum(id);
        failTransaction("constraint violation");

        await discoverWeeklyService.buildFinalPlaylist(id);

        const batch = await fx.batch(id);
        expect(batch?.status).toBe("failed");
        expect(batch?.errorMessage).toContain("Playlist build failed");
        expect(batch?.errorMessage).not.toBe("No tracks found after scan");
    });

    it("sets completedAt so the failed batch is a terminal state", async () => {
        const id = `${P}batch-terminal`;
        await arrangeBatchWithOneAlbum(id);
        failTransaction("constraint violation");

        await discoverWeeklyService.buildFinalPlaylist(id);

        const batch = await fx.batch(id);
        expect(batch?.status).toBe("failed");
        expect(batch?.completedAt).toBeInstanceOf(Date);
    });

    it("never marks the batch completed once the build transaction has thrown, and records the failure once", async () => {
        const id = `${P}batch-once`;
        await arrangeBatchWithOneAlbum(id);
        failTransaction("constraint violation");

        await discoverWeeklyService.buildFinalPlaylist(id);

        const batch = await fx.batch(id);
        expect(batch?.status).toBe("failed");
        expect(batch?.finalSongCount).toBe(0);
        // one write moved it from scanning: version 0 -> 1
        expect(batch?.version).toBe(1);
        expect(await prisma.discoveryAlbum.count({ where: { userId: fx.userId } })).toBe(0);
    });

    it("includes the transaction's error message in the failure reason", async () => {
        const id = `${P}batch-2`;
        await arrangeBatchWithOneAlbum(id);
        failTransaction("P2002 unique constraint failed");

        await discoverWeeklyService.buildFinalPlaylist(id);

        const batch = await fx.batch(id);
        expect(batch?.status).toBe("failed");
        expect(batch?.errorMessage).toContain("P2002 unique constraint failed");
    });

    it("a batch with no tracks fails with its own message, not the transaction failure's", async () => {
        const id = `${P}batch-3`;
        await fx.seedScanningBatch(id, []);

        await discoverWeeklyService.buildFinalPlaylist(id);

        const batch = await fx.batch(id);
        expect(batch?.status).toBe("failed");
        expect(batch?.errorMessage).toBe("No tracks found after scan");
    });

    it("completes the batch, with its album and song stored, when the transaction succeeds", async () => {
        const id = `${P}batch-4`;
        await arrangeBatchWithOneAlbum(id);

        await discoverWeeklyService.buildFinalPlaylist(id);

        const batch = await fx.batch(id);
        expect(batch?.status).toBe("completed");
        expect(batch?.errorMessage).toBeNull();
        expect(batch?.finalSongCount).toBe(1);
        const albums = await prisma.discoveryAlbum.findMany({ where: { userId: fx.userId }, include: { tracks: true } });
        expect(albums).toHaveLength(1);
        expect(albums[0].rgMbid).toBe("mbid-123");
        expect(albums[0].tracks.map((t) => t.trackId)).toEqual([`${id}-t1`]);
    });
});
