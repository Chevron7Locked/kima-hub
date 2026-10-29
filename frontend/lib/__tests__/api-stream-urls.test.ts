import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, getApiBaseUrl } from "../api";

// `<audio>` cannot send headers, so every stream and preview URL carries the access token in its query, beside any
// parameter of its own, and none carries a "?" when there is no token. `api` is built at import, so its in-memory
// token is set directly; a token with no readable expiry asks for no refresh.

type ApiClientInternals = { token: string | null };

beforeEach(() => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

afterEach(() => {
    vi.unstubAllGlobals();
    (api as unknown as ApiClientInternals).token = null;
});

const withToken = (token: string | null) => {
    (api as unknown as ApiClientInternals).token = token;
};

describe("stream and preview URLs", () => {
    it("carry the token, with their own parameters beside it", () => {
        withToken("tok.en-1");
        const base = getApiBaseUrl();
        expect(api.getStreamUrl("t1")).toBe(`${base}/api/library/tracks/t1/stream?token=tok.en-1`);
        expect(api.getAudiobookStreamUrl("b1")).toBe(`${base}/api/audiobooks/b1/stream?token=tok.en-1`);
        expect(new URL(api.getAudiobookStreamUrl("b1", 2), "http://x").searchParams.get("trackIndex")).toBe("2");
        expect(api.getTrackPreviewStreamUrl("AC/DC", "T.N.T.")).toBe(
            `${base}/api/artists/preview/AC%2FDC/T.N.T./stream?token=tok.en-1`
        );
        expect(api.getPendingTrackPreviewStreamUrl("p 1", "q1")).toBe(
            `${base}/api/playlists/p%201/pending/q1/preview/stream?token=tok.en-1`
        );
    });

    it("leave the query off when there is no token", () => {
        withToken(null);
        const base = getApiBaseUrl();
        expect(api.getStreamUrl("t1")).toBe(`${base}/api/library/tracks/t1/stream`);
        expect(api.getAudiobookStreamUrl("b1", 3)).toBe(`${base}/api/audiobooks/b1/stream?trackIndex=3`);
        expect(api.getTrackPreviewStreamUrl("a", "b")).toBe(`${base}/api/artists/preview/a/b/stream`);
    });
});
