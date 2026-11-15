import { it, expect, vi, afterEach } from "vitest";
import { api } from "../api";

// The add-to-playlist dialog cannot close while a create or add is in flight, so both requests must give up on their
// own: they are cut off after 30 seconds and reject, which lets the dialog show its error and close again.

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** A fetch that never answers and rejects the way the browser does once its signal aborts. */
function hangingFetch() {
    return vi.fn(
        (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
            }),
    );
}

it.each([
    ["createPlaylist", () => api.createPlaylist("late night", false)],
    ["addTracksToPlaylist", () => api.addTracksToPlaylist("pl-1", ["a"])],
])("%s is cut off after 30 seconds and rejects", async (_name, ask) => {
    const timer = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);
    const fetchStub = hangingFetch();
    vi.stubGlobal("fetch", fetchStub);

    const result = ask();
    const settled = vi.fn();
    result.catch(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(timeout).toHaveBeenCalledWith(30_000);

    timer.abort(new DOMException("timed out", "TimeoutError"));
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
});

it("a token refresh that never answers is cut off too, so an add behind it still ends", async () => {
    const store: Record<string, string> = { auth_token: "expired", refresh_token: "refresh-abc" };
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => void (store[k] = v),
        removeItem: (k: string) => void delete store[k],
    });
    (api as unknown as { token: string | null }).token = "expired";
    vi.spyOn(console, "error").mockImplementation(() => {});

    const timer = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);
    const unauthorized = {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { entries: () => [] },
        json: async () => ({ error: "expired" }),
    } as unknown as Response;
    const hangs = hangingFetch();
    vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init: RequestInit) =>
            url.endsWith("/api/auth/refresh") ? hangs(url, init) : Promise.resolve(unauthorized),
        ),
    );

    const result = api.addTracksToPlaylist("pl-1", ["a"]);
    const settled = vi.fn();
    result.catch(settled);
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).not.toHaveBeenCalled();

    timer.abort(new DOMException("timed out", "TimeoutError"));
    await expect(result).rejects.toThrow();
    (api as unknown as { token: string | null }).token = null;
});
