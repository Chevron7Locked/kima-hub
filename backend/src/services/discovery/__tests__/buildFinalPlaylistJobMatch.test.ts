/**
 * buildFinalPlaylist links each Discover album to the download job that fetched it, so the suggestion records the
 * Lidarr album id Discover's clear later deletes by. Lidarr's names keep accents and typographic marks the scanned
 * names may lack (pairs recorded from a production library), so the link compares names by sameName.
 */
import { discoverWeeklyService } from "../../discoverWeekly";
import { prisma } from "../../../utils/db";

jest.mock("../../discovery/optimisticBatchUpdate", () => ({
    updateBatchStatus: jest.fn().mockResolvedValue({ success: true, retries: 0 }),
}));

jest.mock("../../../utils/db", () => ({
    prisma: {
        discoveryBatch: { findUnique: jest.fn(), update: jest.fn() },
        downloadJob: { findMany: jest.fn().mockResolvedValue([]) },
        track: { findMany: jest.fn().mockResolvedValue([]) },
        // Read before the transaction; undefined makes the service use its default exclusion window.
        userDiscoverConfig: { findUnique: jest.fn() },
        $transaction: jest.fn(),
        discoverExclusion: { upsert: jest.fn() },
    },
}));

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

const upsert = jest.fn().mockResolvedValue({ id: "da-1" });
const tx = {
    discoveryAlbum: { upsert },
    discoverExclusion: { upsert: jest.fn() },
    discoveryTrack: { create: jest.fn() },
};

/** A scanning batch with one completed job named as Lidarr named it, and one scanned track named as the files are. */
function arrange(job: { artistName: string; albumTitle: string }, scanned: { artistName: string; albumTitle: string }) {
    (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
        id: "batch-m", userId: "u1", status: "scanning", targetSongCount: 30,
        weekStart: new Date("2026-11-02T00:00:00.000Z"), jobs: [],
    });
    (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([
        {
            id: "job-m", discoveryBatchId: "batch-m", status: "completed", lidarrAlbumId: 36401,
            targetMbid: "3372b3ce-c462-4937-9da3-011e93921b6b",
            metadata: { ...job, albumMbid: "3372b3ce-c462-4937-9da3-011e93921b6b", similarity: 0.7, tier: "medium" },
        },
    ]);
    (prisma.track.findMany as jest.Mock).mockResolvedValue([
        {
            id: "t1", title: "T", filePath: "/m/t1.flac",
            album: { id: "alb-1", rgMbid: "temp-1793617784650-0.26", title: scanned.albumTitle, artist: { name: scanned.artistName } },
        },
    ]);
    (prisma.$transaction as jest.Mock).mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));
}

const recordedLidarrId = () => upsert.mock.calls[0]?.[0]?.create?.lidarrAlbumId;

describe("buildFinalPlaylist links a Discover album to its download job", () => {
    beforeEach(() => jest.clearAllMocks());

    it.each([
        ["a curly apostrophe", { artistName: "Ed O’Brien", albumTitle: "Blue Morpho" }, { artistName: "Ed O'Brien", albumTitle: "Blue Morpho" }],
        ["accents", { artistName: "Orelsan", albumTitle: "La fête est finie" }, { artistName: "Orelsan", albumTitle: "La Fete Est Finie" }],
        ["a Unicode hyphen", { artistName: "Angèle", albumTitle: "Nonante‐cinq" }, { artistName: "Angèle", albumTitle: "Nonante-Cinq" }],
        ["an ellipsis character", { artistName: "Queens of the Stone Age", albumTitle: "In Times New Roman…" }, { artistName: "Queens Of The Stone Age", albumTitle: "In Times New Roman..." }],
    ])("records the job's Lidarr id when the names differ only by %s", async (_how, job, scanned) => {
        arrange(job, scanned);
        await discoverWeeklyService.buildFinalPlaylist("batch-m");
        expect(recordedLidarrId()).toBe(36401);
    });

    it("records no Lidarr id for an album no job names", async () => {
        arrange({ artistName: "Orelsan", albumTitle: "Civilisation" }, { artistName: "Orelsan", albumTitle: "La Fete Est Finie" });
        await discoverWeeklyService.buildFinalPlaylist("batch-m");
        expect(upsert).toHaveBeenCalled();
        expect(recordedLidarrId() ?? null).toBeNull();
    });
});
