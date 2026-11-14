/**
 * The library-changed marker a Subsonic client's `lastModified` reads (services/libraryChanged.ts) moves when a scan added,
 * changed, flagged missing, retired or flagged corrupt any song, and not when the scan found nothing to change. The
 * scanner is faked; the marker is the real one on the suite database.
 */
const mockScanLibrary = jest.fn();
jest.mock("../../../services/musicScanner", () => ({
    MusicScannerService: jest.fn().mockImplementation(() => ({ scanLibrary: (...a: unknown[]) => mockScanLibrary(...a) })),
}));
jest.mock("../../../services/spotifyImport", () => ({
    spotifyImportService: { reconcilePendingTracks: jest.fn().mockResolvedValue({ tracksAdded: 0, playlistsUpdated: 0 }), buildPlaylistAfterScan: jest.fn() },
}));
jest.mock("../../../services/discoverWeekly", () => ({
    discoverWeeklyService: { reconcileDiscoveryTracks: jest.fn().mockResolvedValue({ tracksAdded: 0, batchesChecked: 0 }), buildFinalPlaylist: jest.fn() },
}));
jest.mock("../../../jobs/queueCleaner", () => ({ queueCleaner: { reconcileWithLocalLibrary: jest.fn().mockResolvedValue(undefined) } }));
jest.mock("../../../services/eventBus", () => ({ eventBus: { emit: jest.fn() } }));
jest.mock("../../../services/notificationService", () => ({ notificationService: { create: jest.fn().mockResolvedValue(undefined) } }));
jest.mock("../../../utils/logger", () => ({ logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import type { Job } from "bullmq";
import { prisma } from "../../../utils/db";
import { libraryChangedAt, markLibraryChanged } from "../../../services/libraryChanged";
import { processScan, type ScanJobData } from "../scanProcessor";

const counts = { tracksAdded: 0, tracksUpdated: 0, tracksMissing: 0, tracksRemoved: 0, tracksCorrupt: 0 };
const job = (data: ScanJobData = {}) => ({ id: "j1", data, updateProgress: jest.fn().mockResolvedValue(undefined) }) as unknown as Job<ScanJobData>;
const tick = () => new Promise((r) => setTimeout(r, 15));

afterAll(async () => {
    await prisma.$disconnect();
});

it.each([
    ["added", { tracksAdded: 1 }],
    ["updated", { tracksUpdated: 1 }],
    ["flagged missing", { tracksMissing: 1 }],
    ["retired", { tracksRemoved: 1 }],
    ["flagged corrupt", { tracksCorrupt: 1 }],
])("moves the marker when a scan %s songs", async (_what, changed) => {
    const before = (await markLibraryChanged()).getTime();
    await tick();
    mockScanLibrary.mockResolvedValue({ ...counts, ...changed });
    await processScan(job());
    expect(await libraryChangedAt()).toBeGreaterThan(before);
});

it("leaves the marker alone when a scan changed nothing, even one asked for by hand", async () => {
    const before = (await markLibraryChanged()).getTime();
    await tick();
    mockScanLibrary.mockResolvedValue(counts);
    await processScan(job({ source: "manual-scan", userId: "u1" }));
    expect(await libraryChangedAt()).toBe(before);
});

it("moves the marker when the scan fails part-way, since songs it filed are skipped by the next scan", async () => {
    const before = (await markLibraryChanged()).getTime();
    await tick();
    mockScanLibrary.mockRejectedValue(new Error("disk gone"));
    await expect(processScan(job())).rejects.toThrow("disk gone");
    expect(await libraryChangedAt()).toBeGreaterThan(before);
});
