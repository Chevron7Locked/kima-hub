/**
 * Each pass of the mood snapshot worker also brings the public library export up to date when the public feed is
 * on, so the first request after a library change gets the new export, not the one from before it.
 */
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockRefreshMoodSnapshot = jest.fn();
jest.mock("../../services/moodBucketService", () => ({
    NO_STATISTICS: "none",
    refreshMoodSnapshot: (...a: unknown[]) => mockRefreshMoodSnapshot(...a),
}));
const mockRefreshLibraryExport = jest.fn();
jest.mock("../../services/publicLibraryExport", () => ({
    refreshLibraryExport: (...a: unknown[]) => mockRefreshLibraryExport(...a),
}));
const mockConfig: { publicVibe: unknown } = { publicVibe: null };
jest.mock("../../config", () => ({ config: mockConfig }));

import { moodSnapshotPass } from "../moodSnapshotWorker";

beforeEach(() => {
    jest.clearAllMocks();
    mockRefreshMoodSnapshot.mockResolvedValue({ snapshot: { signature: "none", views: new Map(), pending: 0 }, changed: false });
    mockRefreshLibraryExport.mockResolvedValue({});
});

it("brings the public export up to date on every pass while the public feed is on", async () => {
    mockConfig.publicVibe = { username: "kima", token: "x".repeat(32) };
    await moodSnapshotPass();
    expect(mockRefreshLibraryExport).toHaveBeenCalledTimes(1);
});

it("leaves the export alone when the public feed is off", async () => {
    mockConfig.publicVibe = null;
    await moodSnapshotPass();
    expect(mockRefreshLibraryExport).not.toHaveBeenCalled();
});

it("keeps going when the export build fails, and waits ten minutes before building it again", async () => {
    mockConfig.publicVibe = { username: "kima", token: "x".repeat(32) };
    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
        mockRefreshLibraryExport.mockRejectedValue(new Error("database gone"));
        await expect(moodSnapshotPass()).resolves.toBeUndefined();
        expect(mockRefreshLibraryExport).toHaveBeenCalledTimes(1);

        now.mockReturnValue(1_000_000 + 9 * 60_000);
        await moodSnapshotPass();
        expect(mockRefreshLibraryExport).toHaveBeenCalledTimes(1);

        now.mockReturnValue(1_000_000 + 10 * 60_000);
        mockRefreshLibraryExport.mockResolvedValue({});
        await moodSnapshotPass();
        expect(mockRefreshLibraryExport).toHaveBeenCalledTimes(2);
    } finally {
        now.mockRestore();
    }
});
