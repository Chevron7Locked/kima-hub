/**
 * The settings pages that delete a user or revoke a token put the row's id in the request path. An id holding `/`, `?`
 * or `#` must reach the server as one path segment, as `lib/api.ts` sends its own ids.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { mountHost } from "./helpers/dom";

const ODD_ID = "a/b?c#d";
const ENCODED = "a%2Fb%3Fc%23d";

const { api, auth } = vi.hoisted(() => ({
    api: { get: vi.fn(), post: vi.fn(), delete: vi.fn(async () => ({})), setToken: vi.fn() },
    auth: { user: { id: "me", username: "me", role: "admin" } },
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/hooks/useQueries", () => ({ usePublicConfig: () => ({ publicUrl: "http://kima.test", settled: true }) }));

import { UserManagementSection } from "@/features/settings/components/sections/UserManagementSection";
import { SubsonicSection } from "@/features/settings/components/sections/SubsonicSection";
import type { SystemSettings } from "@/features/settings/types";

const dom = mountHost();
const button = (name: string) => [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === name).at(-1)!;

beforeEach(() => {
    api.delete.mockClear();
});

describe("delete user", () => {
    it("sends the user's id as one path segment", async () => {
        api.get.mockResolvedValue([{ id: ODD_ID, username: "odd", role: "user", createdAt: "2026-01-01" }]);
        const settings = { registrationOpen: false } as SystemSettings;
        await act(async () => dom.root.render(<UserManagementSection settings={settings} onUpdate={vi.fn()} />));

        await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="delete odd"]')!.click());
        await act(async () => button("Delete").click());

        expect(api.delete).toHaveBeenCalledWith(`/auth/users/${ENCODED}`);
    });
});

describe("revoke token", () => {
    it("sends the token's id as one path segment", async () => {
        api.get.mockResolvedValue({ apiKeys: [{ id: ODD_ID, name: "phone", createdAt: "2026-01-01", lastUsed: null }] });
        await act(async () => dom.root.render(<SubsonicSection />));

        await act(async () => button("Revoke").click());
        await act(async () => button("Revoke").click());

        expect(api.delete).toHaveBeenCalledWith(`/api-keys/${ENCODED}`);
    });
});
