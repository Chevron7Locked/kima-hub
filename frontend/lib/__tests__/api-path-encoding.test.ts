import { it, expect, vi, afterEach } from "vitest";
import { api } from "../api";

// An id is one path segment. One holding "/", "?" or "#" must not reach another route or cut the address short.

const ok = () =>
    ({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { entries: () => [], get: () => null },
        json: async () => ({}),
        text: async () => "{}",
    }) as unknown as Response;

const odd = "a/b?c#d";
const encoded = "a%2Fb%3Fc%23d";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

it.each([
    ["getAlbum", () => api.getAlbum(odd), `/api/library/albums/${encoded}`],
    ["getTrack", () => api.getTrack(odd), `/api/library/tracks/${encoded}`],
    ["getPlaylist", () => api.getPlaylist(odd), `/api/playlists/${encoded}`],
    ["getAudiobook", () => api.getAudiobook(odd), `/api/audiobooks/${encoded}`],
    ["getMix", () => api.getMix(odd), `/api/mixes/${encoded}?tz=`],
    ["getPodcast", () => api.getPodcast(odd), `/api/podcasts/${encoded}`],
    ["removeItemFromPlaylist", () => api.removeItemFromPlaylist(odd, odd), `/api/playlists/${encoded}/items/${encoded}`],
    ["retryPendingTrack", () => api.retryPendingTrack(odd, odd), `/api/playlists/${encoded}/pending/${encoded}/retry`],
    ["getMoodBucketMix", () => api.getMoodBucketMix(odd as never), `/api/mixes/mood/buckets/${encoded}`],
    ["markNotificationAsRead", () => api.markNotificationAsRead(odd), `/api/notifications/${encoded}/read`],
])("%s sends its ids as single path segments", async (_name, call, path) => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    await call().catch(() => {});
    expect(fetchMock).toHaveBeenCalled();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain(path);
});

it("builds stream addresses with encoded ids", () => {
    expect(api.getStreamUrl(odd)).toContain(`/api/library/tracks/${encoded}/stream`);
});
