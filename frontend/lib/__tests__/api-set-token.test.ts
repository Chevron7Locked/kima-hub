import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "../api";

// A stale refresh token left by an older session could let a later silent renewal resume that account.

let store: Record<string, string>;

beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
            store[k] = v;
        },
        removeItem: (k: string) => {
            delete store[k];
        },
    });
    store.auth_token = "old-token";
    store.refresh_token = "old-refresh";
});

afterEach(() => {
    vi.unstubAllGlobals();
    (api as unknown as { token: string | null }).token = null;
});

describe("ApiClient.setToken", () => {
    it("stores both tokens when a sign-in brings both", () => {
        api.setToken("new-token", "new-refresh");
        expect(store).toEqual({ auth_token: "new-token", refresh_token: "new-refresh" });
    });

    it("removes an older refresh token when a sign-in brings none", () => {
        api.setToken("new-token");
        expect(store).toEqual({ auth_token: "new-token" });
    });
});
