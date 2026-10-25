import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "../api";

// Every request that can make the server build the mixes carries the browser's time zone, so Late Night and Midnight
// Drive read "after dark" in the listener's own zone.

afterEach(() => vi.restoreAllMocks());

describe("the mixes requests", () => {
    const zone = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);

    it.each([
        ["getMixes", () => api.getMixes(), "/mixes"],
        ["refreshMixes", () => api.refreshMixes(), "/mixes/refresh"],
        ["getMix", () => api.getMix("late-night-2026-03-11"), "/mixes/late-night-2026-03-11"],
        ["saveMixAsPlaylist", () => api.saveMixAsPlaylist("late-night-2026-03-11"), "/mixes/late-night-2026-03-11/save"],
    ])("%s sends ?tz=", async (_name, call, path) => {
        const request = vi.spyOn(api, "request").mockResolvedValue({} as never);
        await call();
        expect(request.mock.calls[0][0]).toBe(`${path}?tz=${zone}`);
    });
});
