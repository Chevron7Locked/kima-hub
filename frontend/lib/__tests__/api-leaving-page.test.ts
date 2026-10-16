import { it, expect, vi, afterEach } from "vitest";
import { api } from "../api";

// Leaving the page cancels its open requests just after pagehide (measured in Chromium: about a millisecond
// later). Those cancellations must not reject into the console; a page that comes back from the back/forward
// cache asks a read again and reports a cancelled write.

const ok = (body: unknown) =>
    ({ ok: true, status: 200, headers: { entries: () => [] }, json: async () => body }) as unknown as Response;
const cancelled = () => Promise.reject(new TypeError("Failed to fetch"));
const settledSoon = async (p: Promise<unknown>) => {
    let done = false;
    p.then(() => (done = true), () => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    return done;
};

afterEach(() => {
    window.dispatchEvent(new Event("pageshow"));
    vi.unstubAllGlobals();
});

it("rejects as before while the page is not being left", async () => {
    vi.stubGlobal("fetch", vi.fn(cancelled));
    await expect(api.request("/podcasts/x/similar")).rejects.toThrow("Failed to fetch");
});

it("does not reject a read cancelled by leaving the page, and asks it again if the page comes back", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(cancelled).mockResolvedValueOnce(ok({ again: true }));
    vi.stubGlobal("fetch", fetchMock);
    window.dispatchEvent(new Event("pagehide"));
    const read = api.request("/podcasts/x/similar");
    expect(await settledSoon(read)).toBe(false);
    window.dispatchEvent(new Event("pageshow"));
    await expect(read).resolves.toEqual({ again: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not reject a write cancelled by leaving the page, and reports it without resending if the page comes back", async () => {
    const fetchMock = vi.fn(cancelled);
    vi.stubGlobal("fetch", fetchMock);
    window.dispatchEvent(new Event("pagehide"));
    const write = api.request("/podcasts/x/episodes/y/progress", { method: "POST", body: "{}" });
    expect(await settledSoon(write)).toBe(false);
    window.dispatchEvent(new Event("pageshow"));
    await expect(write).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("treats an app resumed from the background (visible again, no pageshow) as back", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(cancelled).mockResolvedValueOnce(ok({ resumed: true }));
    vi.stubGlobal("fetch", fetchMock);
    window.dispatchEvent(new Event("pagehide"));
    const read = api.request("/podcasts/x/similar");
    expect(await settledSoon(read)).toBe(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await expect(read).resolves.toEqual({ resumed: true });
    // And the page is no longer treated as leaving: a later real failure rejects.
    vi.stubGlobal("fetch", vi.fn(cancelled));
    await expect(api.request("/podcasts/x/similar")).rejects.toThrow("Failed to fetch");
});

it("sends progress saves kept alive, so closing the page does not cancel them", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({}));
    vi.stubGlobal("fetch", fetchMock);
    await api.updatePodcastEpisodeProgress("p", "e", 120, 600);
    await api.updateAudiobookProgress("b", 120, 600);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).keepalive)).toEqual([true, true]);
});

it("does not reject when leaving the page cuts off an answer whose body was still arriving", async () => {
    // The answer's headers arrived; leaving the page then fails the body read (measured in Chromium:
    // "TypeError: Failed to fetch", just after pagehide).
    let cutOff!: (e: unknown) => void;
    const answer = {
        ok: true,
        status: 200,
        headers: { entries: () => [] },
        json: () => new Promise((_ok, fail) => (cutOff = fail)),
    } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer));
    const save = api.request("/podcasts/x/episodes/y/progress", { method: "POST", body: "{}" });
    await new Promise((r) => setTimeout(r, 0));
    window.dispatchEvent(new Event("pagehide"));
    cutOff(new TypeError("Failed to fetch"));
    expect(await settledSoon(save)).toBe(false);
});
