import { it, expect, vi, afterEach } from "vitest";
import { api } from "../api";

// The clear deletes albums, so it reaches the server's clear code once. A 401 comes from the sign-in check that runs
// before that code, so after a sign-in refresh the clear is sent again; any other answer, or none, is never resent.

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // Drops the test's tokens so the next file starts signed out; clearToken is private to the client.
    (api as unknown as { clearToken(): void }).clearToken();
});

const reply = (status: number, body: unknown) =>
    ({ ok: status < 400, status, statusText: "", json: async () => body }) as unknown as Response;

const isClear = (url: string) => url.endsWith("/api/discover/clear");

it("sends the clear again after a 401 and a sign-in refresh", async () => {
    api.setToken("old-token", "refresh-token");
    const fetchStub = vi.fn(async (url: string) => {
        if (url.endsWith("/api/auth/refresh")) return reply(200, { token: "new-token" });
        const tries = fetchStub.mock.calls.filter(([u]) => isClear(u)).length;
        return tries === 1 ? reply(401, { error: "Not authenticated" }) : reply(200, { success: true, likedMoved: 0, activeDeleted: 1, lidarrFailed: [] });
    });
    vi.stubGlobal("fetch", fetchStub);

    await expect(api.clearDiscoverPlaylist()).resolves.toMatchObject({ activeDeleted: 1 });
    expect(fetchStub.mock.calls.filter(([u]) => isClear(u))).toHaveLength(2);
});

it.each([
    ["Kima answered with an error", () => Promise.resolve(reply(500, { error: "Lidarr is not answering" }))],
    ["no answer came", () => Promise.reject(new TypeError("Failed to fetch"))],
])("does not send the clear again when %s", async (_case, answer) => {
    api.setToken("token", "refresh-token");
    const fetchStub = vi.fn(answer);
    vi.stubGlobal("fetch", fetchStub);

    await expect(api.clearDiscoverPlaylist()).rejects.toThrow();
    expect(fetchStub).toHaveBeenCalledTimes(1);
});
