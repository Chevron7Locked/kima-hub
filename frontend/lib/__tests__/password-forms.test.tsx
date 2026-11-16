/**
 * The two settings forms that set someone's password, change-password and create-user, hold the same rule as the
 * onboarding form (`passwordProblem`): at least 6 characters and at most 72 UTF-8 bytes. A 73-byte password is
 * explained by the form, not left for the server to refuse.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { mountHost } from "./helpers/dom";

const { api, auth } = vi.hoisted(() => ({
    api: { get: vi.fn(async () => []), post: vi.fn(async () => ({ token: "t", refreshToken: "r" })), delete: vi.fn(), setToken: vi.fn() },
    auth: { user: { id: "u1", username: "someone", role: "admin" } },
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: auth.user, deleteAccount: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/features/settings/hooks/useTwoFactor", () => ({
    useTwoFactor: () => ({ twoFactorEnabled: false, recoveryCodes: [], showRecoveryCodes: false, load2FAStatus: vi.fn(), setup2FA: vi.fn() }),
}));

import { AccountSection } from "@/features/settings/components/sections/AccountSection";
import { UserManagementSection } from "@/features/settings/components/sections/UserManagementSection";
import type { SystemSettings } from "@/features/settings/types";

const dom = mountHost();
const field = (placeholder: string) => document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name)!;

function type(input: HTMLInputElement, value: string) {
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

const tooLong = "a".repeat(73);

beforeEach(() => {
    api.post.mockClear();
});

describe("change password", () => {
    async function fill(newPassword: string) {
        act(() => dom.root.render(<AccountSection />));
        await act(async () => button("Change").click());
        type(field("Current password"), "old-password");
        type(field("New password (min 6 characters)"), newPassword);
        type(field("Confirm new password"), newPassword);
    }

    it("explains a password over 72 bytes and sends nothing", async () => {
        await fill(tooLong);
        await act(async () => button("Change Password").click());
        expect(dom.host.textContent).toContain("at most 72 characters");
        expect(api.post).not.toHaveBeenCalled();
    });

    it("explains a password under 6 characters and sends nothing", async () => {
        await fill("12345");
        await act(async () => button("Change Password").click());
        expect(dom.host.textContent).toContain("at least 6 characters");
        expect(api.post).not.toHaveBeenCalled();
    });

    it("sends a password the rule accepts", async () => {
        await fill("a".repeat(72));
        await act(async () => button("Change Password").click());
        expect(api.post).toHaveBeenCalledWith("/auth/change-password", { currentPassword: "old-password", newPassword: "a".repeat(72) });
    });
});

describe("create user", () => {
    const settings = { registrationOpen: false } as SystemSettings;
    async function fill(password: string) {
        await act(async () => dom.root.render(<UserManagementSection settings={settings} onUpdate={vi.fn()} />));
        type(field("Username"), "newperson");
        type(field("Password (6+ chars)"), password);
    }

    it("keeps Create off for a password over 72 bytes", async () => {
        await fill(tooLong);
        expect((button("Create") as HTMLButtonElement).disabled).toBe(true);
    });

    it("keeps Create off for a password under 6 characters", async () => {
        await fill("12345");
        expect((button("Create") as HTMLButtonElement).disabled).toBe(true);
    });

    it("offers Create for a password the rule accepts", async () => {
        await fill("é".repeat(36));
        expect((button("Create") as HTMLButtonElement).disabled).toBe(false);
    });
});
