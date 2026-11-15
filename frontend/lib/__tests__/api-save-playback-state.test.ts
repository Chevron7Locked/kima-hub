import { it, expect, vi, afterEach } from "vitest";
import { api } from "../api";

// A save is kept alive, so the browser finishes it when the page closes right after (see audio-state-context). A kept
// alive request may carry about 64 KB; a bigger body would be refused outright, so a save that big goes without it.

const ok = (body: unknown) =>
    ({ ok: true, status: 200, headers: { entries: () => [] }, json: async () => body }) as unknown as Response;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const sentWith = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls[0][1] as RequestInit;

it("sends a save kept alive when asked to, as the page goes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ updatedAt: "2026-01-01T00:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);
    await api.savePlaybackState({ playbackType: "track", trackId: "a", queue: [], currentIndex: 0 }, { keepalive: true });
    expect(sentWith(fetchMock).keepalive).toBe(true);
});

it("sends a save in the ordinary way when not asked to keep it alive", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ updatedAt: "2026-01-01T00:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);
    await api.savePlaybackState({ playbackType: "track", trackId: "a", queue: [], currentIndex: 0 });
    expect(sentWith(fetchMock).keepalive).toBeFalsy();
});

it("sends a save too big to be kept alive without it, rather than have it refused", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ updatedAt: "2026-01-01T00:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);
    const queue = Array.from({ length: 400 }, (_, i) => ({ id: `song-${i}`, title: "x".repeat(200) }));
    await api.savePlaybackState({ playbackType: "track", trackId: "a", queue, currentIndex: 0 }, { keepalive: true });
    expect(sentWith(fetchMock).keepalive).toBe(false);
});

it("counts the size in bytes, not characters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ updatedAt: "2026-01-01T00:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);
    const queue = [{ id: "a", title: "ö".repeat(40_000) }];
    await api.savePlaybackState({ playbackType: "track", trackId: "a", queue, currentIndex: 0 }, { keepalive: true });
    expect(sentWith(fetchMock).keepalive).toBe(false);
});

it("sends the time the save saw when it names one, and nothing when it does not", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ updatedAt: "2026-01-01T00:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);
    await api.savePlaybackState({ playbackType: "track", trackId: "a", expectedUpdatedAt: "2026-01-01T00:00:00.000Z" });
    expect(JSON.parse(String(sentWith(fetchMock).body)).expectedUpdatedAt).toBe("2026-01-01T00:00:00.000Z");
    fetchMock.mockClear();
    await api.savePlaybackState({ playbackType: "track", trackId: "a" });
    expect("expectedUpdatedAt" in JSON.parse(String(sentWith(fetchMock).body))).toBe(false);
});

it("throws a refused save with its status and the state the server holds", async () => {
    const held = { trackId: "z", updatedAt: "2026-01-01T00:00:05.000Z" };
    vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "changed", state: held }) }),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(api.savePlaybackState({ playbackType: "track", expectedUpdatedAt: "x" })).rejects.toMatchObject({
        status: 409,
        data: { state: held },
    });
    // A refusal and a gone item are expected answers to a save, so they are not logged as failures.
    expect(logged).not.toHaveBeenCalled();
});

it("does not log a 404 to a save, and still logs any other failure", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const answer = (status: number) =>
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, statusText: "x", json: async () => ({ error: "x" }) }));
    answer(404);
    await expect(api.savePlaybackState({ playbackType: "track" })).rejects.toMatchObject({ status: 404 });
    expect(logged).not.toHaveBeenCalled();
    answer(500);
    await expect(api.savePlaybackState({ playbackType: "track" })).rejects.toMatchObject({ status: 500 });
    expect(logged).toHaveBeenCalled();
});
