/**
 * Deezer answers a quota hit as an HTTP 200 carrying an error (the recorded reply in fixtures/deezer/quota.json). The
 * real rate limiter sees it as a rate limit, backs off and asks again, instead of counting it a success; and the
 * featured playlists keep a list only when every request behind it answered. Only axios and the cache are stood in.
 */
import fs from "fs";
import path from "path";

const mockGet = jest.fn();
jest.mock("axios", () => ({ __esModule: true, default: { get: (...a: unknown[]) => mockGet(...a) } }));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
const mockCache = new Map<string, string>();
jest.mock("../../utils/cacheWrapper", () => ({
    CacheWrapper: class {
        async get(key: string) {
            return mockCache.get(key) ?? null;
        }
        async set(key: string, value: string) {
            mockCache.set(key, value);
        }
    },
}));

import { deezerService } from "../deezer";

const QUOTA = JSON.parse(fs.readFileSync(path.join(__dirname, "../../__tests__/fixtures/deezer/quota.json"), "utf8")).body;
const playlist = (id: number) => ({ id, title: `List ${id}`, picture_medium: "", nb_tracks: 10, user: { name: "Deezer" }, fans: 1 });

beforeEach(() => {
    mockGet.mockReset();
    mockCache.clear();
});

it("waits out Deezer's 5-second quota window, then asks again and uses the answer", async () => {
    mockGet.mockResolvedValueOnce({ data: QUOTA }).mockResolvedValueOnce({ data: { title: "Late Night" } });

    const started = Date.now();
    expect(await deezerService.getPlaylistName("123")).toBe("Late Night");
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
}, 15_000);

it("keeps featured playlists only when every request answered", async () => {
    // The chart answers; the first genre search hits the quota every time it is asked.
    mockGet.mockImplementation(async (url: string, config: { params?: { q?: string } }) =>
        url.endsWith("/chart/0/playlists")
            ? { data: { data: [playlist(1), playlist(2)] } }
            : config?.params?.q === "pop"
              ? { data: QUOTA }
              : { data: { data: [playlist(Math.floor(Math.random() * 1e9))] } },
    );

    const partial = await deezerService.getFeaturedPlaylists(5);
    expect(partial.map((p) => p.id)).toEqual(["1", "2"]);
    expect(mockCache.size).toBe(0);
    // Still over the quota after waiting: no genre after it is asked.
    const asked = mockGet.mock.calls.map(([, config]) => (config as { params?: { q?: string } })?.params?.q).filter(Boolean);
    expect(new Set(asked)).toEqual(new Set(["pop"]));

    mockGet.mockImplementation(async (url: string) =>
        url.endsWith("/chart/0/playlists") ? { data: { data: [1, 2, 3, 4, 5].map(playlist) } } : { data: { data: [] } },
    );
    const full = await deezerService.getFeaturedPlaylists(5);
    expect(full).toHaveLength(5);
    expect(mockCache.size).toBe(1);
}, 60_000);

it("shares one lookup of an artist's popular songs between callers that ask at once", async () => {
    mockGet.mockImplementation(async (url: string) =>
        url.endsWith("/search/artist")
            ? { data: { data: [{ id: 27, name: "Daft Punk", nb_fan: 5_000_000 }] } }
            : { data: { data: [{ id: 3135556, title: "Harder, Better, Faster, Stronger", rank: 900000, preview: "https://cdn/p.mp3", artist: { name: "Daft Punk" }, album: { title: "Discovery" } }] } },
    );

    const [a, b, c] = await Promise.all([1, 2, 3].map(() => deezerService.getArtistTopTracks("Daft Punk")));

    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(mockGet.mock.calls.filter(([url]) => String(url).endsWith("/artist/27/top"))).toHaveLength(1);
});
