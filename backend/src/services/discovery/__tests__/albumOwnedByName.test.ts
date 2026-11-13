/**
 * Discover skips an album the user owns under another id. Owned means the same
 * artist once folded and agreeing titles; a longer artist or album name that
 * merely contains the asked one is not the same album.
 */
jest.mock("../../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockIndex = jest.fn();
jest.mock("../../discovery", () => ({
    discoveryBatchLogger: { info: jest.fn(), error: jest.fn() },
    discoverySeeding: { getOwnedAlbumIndex: () => mockIndex() },
    discoveryAlbumLifecycle: { processBeforeGeneration: jest.fn() },
}));
jest.mock("../../lidarr", () => ({ lidarrService: {} }));

import { discoverWeeklyService } from "../../discoverWeekly";

const owned = (artistName: string, albumTitle: string): Promise<boolean> =>
    (discoverWeeklyService as any).isAlbumOwnedByName(artistName, albumTitle);

const index = (albums: Array<{ title: string; artistName: string }>, refs: Array<{ rgMbid: string; artistName: string; title: string }> = []) =>
    mockIndex.mockResolvedValue({
        albums,
        ownedAlbumArtists: refs.map(({ rgMbid, artistName }) => ({ rgMbid, artistName })),
        albumTitleByRgMbid: new Map(refs.map(({ rgMbid, title }) => [rgMbid, title])),
    });

it("does not count another artist whose name contains the asked one", async () => {
    index([{ title: "Once in a Long, Long While...", artistName: "Low Roar" }]);

    expect(await owned("Low", "Once in a Long, Long While...")).toBe(false);
});

it("does not count an album whose title contains the asked one", async () => {
    index([{ title: "Trust Me", artistName: "Low" }]);

    expect(await owned("Low", "Trust")).toBe(false);
});

it("counts another edition of the same album", async () => {
    index([{ title: "Trust (Deluxe Edition)", artistName: "low" }]);

    expect(await owned("Low", "Trust")).toBe(true);
});

it("counts an album kept under its release-group id", async () => {
    index([], [{ rgMbid: "rg-1", artistName: "Low", title: "Trust" }]);

    expect(await owned("Low", "trust")).toBe(true);
});
