/**
 * The library-changed marker a Subsonic client's `lastModified` reads (services/libraryChanged.ts) moves when the scan says
 * it changed what a client lists (the scan result's `libraryChanged`, or the scanner's own when the scan fails
 * part-way), and not when it found nothing to change or only touched Discover songs. The scanner is faked; the
 * marker is the real one on the suite database. What counts as a library change is musicScanner.libraryChanged.test.ts.
 */
const mockScanLibrary = jest.fn();
let mockScannerChangedLibrary = false;
jest.mock("../../../services/musicScanner", () => ({
    MusicScannerService: jest.fn().mockImplementation(() => ({
        scanLibrary: (...a: unknown[]) => mockScanLibrary(...a),
        get libraryChanged() {
            return mockScannerChangedLibrary;
        },
    })),
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
import { libraryChangedAt } from "../../../services/libraryChanged";
import { markedTime } from "../../../__tests__/helpers/libraryMarker";
import { processScan, type ScanJobData } from "../scanProcessor";

const counts = { tracksAdded: 0, tracksUpdated: 0, tracksMissing: 0, tracksRemoved: 0, tracksCorrupt: 0, libraryChanged: false };
const job = (data: ScanJobData = {}) => ({ id: "j1", data, updateProgress: jest.fn().mockResolvedValue(undefined) }) as unknown as Job<ScanJobData>;
const tick = () => new Promise((r) => setTimeout(r, 15));

beforeEach(() => {
    mockScannerChangedLibrary = false;
});

afterAll(async () => {
    await prisma.$disconnect();
});

it("moves the marker when the scan says it changed the library", async () => {
    const before = (await markedTime()).getTime();
    await tick();
    mockScanLibrary.mockResolvedValue({ ...counts, tracksAdded: 1, libraryChanged: true });
    await processScan(job());
    expect(await libraryChangedAt()).toBeGreaterThan(before);
});

it("leaves the marker alone when a scan only changed Discover songs", async () => {
    const before = (await markedTime()).getTime();
    await tick();
    mockScanLibrary.mockResolvedValue({ ...counts, tracksAdded: 2, tracksMissing: 1, libraryChanged: false });
    await processScan(job());
    expect(await libraryChangedAt()).toBe(before);
});

it("leaves the marker alone when a scan changed nothing, even one asked for by hand", async () => {
    const before = (await markedTime()).getTime();
    await tick();
    mockScanLibrary.mockResolvedValue(counts);
    await processScan(job({ source: "manual-scan", userId: "u1" }));
    expect(await libraryChangedAt()).toBe(before);
});

it("moves the marker when the scan fails part-way after changing the library, since songs it filed are skipped by the next scan", async () => {
    const before = (await markedTime()).getTime();
    await tick();
    mockScannerChangedLibrary = true;
    mockScanLibrary.mockRejectedValue(new Error("disk gone"));
    await expect(processScan(job())).rejects.toThrow("disk gone");
    expect(await libraryChangedAt()).toBeGreaterThan(before);
});

it("leaves the marker alone when the scan fails before changing the library", async () => {
    const before = (await markedTime()).getTime();
    await tick();
    mockScanLibrary.mockRejectedValue(new Error("disk gone"));
    await expect(processScan(job())).rejects.toThrow("disk gone");
    expect(await libraryChangedAt()).toBe(before);
});
