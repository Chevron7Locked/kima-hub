import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, NetworkError } from "../api";

// ---------------------------------------------------------------------------
// C6: 401 -> refresh three-way (network-error / rejected / refreshed).
//
// vitest.config.ts runs this suite under environment: "node". ApiClient reads
// `window`/`localStorage` as bare globals gated on `typeof window`, so both
// must be stubbed for the refresh-token lookup path to run at all. `api` is
// a module-level singleton constructed at import time (before any stubbing),
// so its in-memory `token` field is poked directly rather than via setToken().
// ---------------------------------------------------------------------------

type ApiClientInternals = { token: string | null };

function stubBrowserGlobals() {
    const store: Record<string, string> = {};
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
            store[k] = v;
        },
        removeItem: (k: string) => {
            delete store[k];
        },
    });
    return store;
}

function makeResponse(init: { ok: boolean; status: number; body?: unknown }): Response {
    return {
        ok: init.ok,
        status: init.status,
        statusText: init.ok ? "OK" : "Error",
        headers: { entries: () => [] } as unknown as Headers,
        json: async () => init.body ?? {},
    } as unknown as Response;
}

beforeEach(() => {
    stubBrowserGlobals();
    localStorage.setItem("auth_token", "expired-token");
    localStorage.setItem("refresh_token", "refresh-abc");
    (api as unknown as ApiClientInternals).token = "expired-token";
});

afterEach(() => {
    vi.unstubAllGlobals();
    (api as unknown as ApiClientInternals).token = null;
});

describe("ApiClient.request -- 401 refresh three-way (C6)", () => {
    it("refresh network-error -> throws a distinguishable NetworkError, tokens left intact, no retry-as-auth", async () => {
        const fetchMock = vi
            .fn()
            .mockImplementationOnce(async () => makeResponse({ ok: false, status: 401 }))
            .mockImplementationOnce(async () => {
                throw new TypeError("network down");
            });
        vi.stubGlobal("fetch", fetchMock);

        let caught: unknown;
        try {
            await api.request("/library/tracks");
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(NetworkError);
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).name).toBe("NetworkError");
        expect((caught as Error).message).not.toBe("Not authenticated");

        // Exactly the original request + the refresh attempt -- no retry.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(localStorage.getItem("auth_token")).toBe("expired-token");
        expect(localStorage.getItem("refresh_token")).toBe("refresh-abc");
    });

    it("refresh rejected -> throws 'Not authenticated', tokens cleared", async () => {
        const fetchMock = vi
            .fn()
            .mockImplementationOnce(async () => makeResponse({ ok: false, status: 401 }))
            .mockImplementationOnce(async () => makeResponse({ ok: false, status: 401 }));
        vi.stubGlobal("fetch", fetchMock);

        let caught: unknown;
        try {
            await api.request("/library/tracks");
        } catch (err) {
            caught = err;
        }

        expect(caught).not.toBeInstanceOf(NetworkError);
        expect((caught as Error).message).toBe("Not authenticated");

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(localStorage.getItem("auth_token")).toBeNull();
        expect(localStorage.getItem("refresh_token")).toBeNull();
    });

    it("refresh refreshed -> the request is retried once and succeeds", async () => {
        const fetchMock = vi
            .fn()
            .mockImplementationOnce(async () => makeResponse({ ok: false, status: 401 }))
            .mockImplementationOnce(async () =>
                makeResponse({
                    ok: true,
                    status: 200,
                    body: { token: "new-token", refreshToken: "new-refresh" },
                }),
            )
            .mockImplementationOnce(async () =>
                makeResponse({ ok: true, status: 200, body: { data: "ok" } }),
            );
        vi.stubGlobal("fetch", fetchMock);

        const result = await api.request("/library/tracks");

        expect(result).toEqual({ data: "ok" });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(localStorage.getItem("auth_token")).toBe("new-token");
        expect(localStorage.getItem("refresh_token")).toBe("new-refresh");
    });
});
