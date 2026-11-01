import { it, expect, vi, afterEach } from "vitest";
import { api } from "../api";

// An artist or album page asks the library first and falls back to MusicBrainz on a 404; a 404 from both is the
// page's "not found" screen. None of those 404s is a fault, so none is logged as an error.

const notFound = () =>
    ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: { entries: () => [] },
        json: async () => ({ error: "Not found" }),
    }) as unknown as Response;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

it.each([
    ["getArtist", () => api.getArtist("nope")],
    ["getArtistDiscovery", () => api.getArtistDiscovery("nope")],
    ["getAlbum", () => api.getAlbum("nope")],
    ["getAlbumDiscovery", () => api.getAlbumDiscovery("nope")],
])("%s rejects a 404 with its status and logs nothing", async (_name, ask) => {
    vi.stubGlobal("fetch", vi.fn(async () => notFound()));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(ask()).rejects.toMatchObject({ status: 404 });
    expect(logged).not.toHaveBeenCalled();
});
