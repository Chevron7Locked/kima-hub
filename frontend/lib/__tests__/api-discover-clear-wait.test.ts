import { it, expect, vi, afterEach } from "vitest";
import { api } from "../api";

// Clearing Discover deletes albums in Lidarr and on disk, which can take longer than the 30 seconds other calls wait.
// The page waits for the server's real answer, so the clear is not cut off when the usual timeout fires.

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

it("clearDiscoverPlaylist keeps waiting past the usual 30 second cut-off and gets the server's answer", async () => {
    const usualTimeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(usualTimeout.signal);
    let answer: (r: Response) => void = () => {};
    const fetchStub = vi.fn(
        (_url: string, init: RequestInit) =>
            new Promise<Response>((resolve, reject) => {
                answer = resolve;
                init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
            }),
    );
    vi.stubGlobal("fetch", fetchStub);

    const result = api.clearDiscoverPlaylist();
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalled());
    usualTimeout.abort(new DOMException("timed out", "TimeoutError"));

    answer({ ok: true, status: 200, json: async () => ({ success: true, likedMoved: 0, activeDeleted: 2, lidarrFailed: [] }) } as unknown as Response);
    await expect(result).resolves.toMatchObject({ activeDeleted: 2 });
});
