/**
 * After a scan, songs still waiting in imported and Discover playlists are matched again when the scan added or
 * updated songs, was asked for by hand, or followed a retried download; otherwise not.
 */
const mockScanLibrary = jest.fn();
jest.mock("../../../services/musicScanner", () => ({
    MusicScannerService: jest.fn().mockImplementation(() => ({ scanLibrary: (...a: unknown[]) => mockScanLibrary(...a) })),
}));
const mockPending = jest.fn().mockResolvedValue({ tracksAdded: 0, playlistsUpdated: 0 });
jest.mock("../../../services/spotifyImport", () => ({
    spotifyImportService: { reconcilePendingTracks: () => mockPending(), buildPlaylistAfterScan: jest.fn() },
}));
const mockDiscover = jest.fn().mockResolvedValue({ tracksAdded: 0, batchesChecked: 0 });
jest.mock("../../../services/discoverWeekly", () => ({
    discoverWeeklyService: { reconcileDiscoveryTracks: () => mockDiscover(), buildFinalPlaylist: jest.fn() },
}));
jest.mock("../../../jobs/queueCleaner", () => ({ queueCleaner: { reconcileWithLocalLibrary: jest.fn().mockResolvedValue(undefined) } }));
jest.mock("../../unifiedEnrichment", () => ({ triggerEnrichmentNow: jest.fn().mockResolvedValue({ tracks: 0 }) }));
jest.mock("../../../services/eventBus", () => ({ eventBus: { emit: jest.fn() } }));
jest.mock("../../../services/notificationService", () => ({ notificationService: { create: jest.fn().mockResolvedValue(undefined) } }));
jest.mock("../../../utils/logger", () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import type { Job } from "bullmq";
import { processScan, type ScanJobData } from "../scanProcessor";

const counts = { tracksAdded: 0, tracksUpdated: 0, tracksMissing: 0, tracksRemoved: 0, tracksCorrupt: 0 };
const job = (data: ScanJobData) => ({ id: "j1", data, updateProgress: jest.fn().mockResolvedValue(undefined) }) as unknown as Job<ScanJobData>;

beforeEach(() => jest.clearAllMocks());

it.each([
    ["songs were added", { tracksAdded: 2 }, {}],
    ["songs were updated", { tracksUpdated: 1 }, {}],
    ["it was asked for by hand", {}, { source: "manual-scan", userId: "u1" }],
    ["it followed a retried download", {}, { source: "retry-pending-track" }],
])("matches waiting playlist songs again when %s", async (_why, changed, data) => {
    mockScanLibrary.mockResolvedValue({ ...counts, ...changed });
    await processScan(job(data));
    expect(mockPending).toHaveBeenCalledTimes(1);
    expect(mockDiscover).toHaveBeenCalledTimes(1);
});

it("leaves them alone after a scan that changed nothing and nobody asked for", async () => {
    mockScanLibrary.mockResolvedValue(counts);
    await processScan(job({ source: "lidarr-webhook" }));
    expect(mockPending).not.toHaveBeenCalled();
    expect(mockDiscover).not.toHaveBeenCalled();
});

it("a failed import re-match does not stop the Discover one", async () => {
    mockScanLibrary.mockResolvedValue({ ...counts, tracksAdded: 1 });
    mockPending.mockRejectedValueOnce(new Error("db down"));
    await processScan(job({}));
    expect(mockDiscover).toHaveBeenCalledTimes(1);
});
