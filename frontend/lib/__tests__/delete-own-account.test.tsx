/**
 * Anyone signed in, a member as much as an admin, can delete their own account from Settings → You → Account
 * (DELETE /api/auth/account, as the iOS app does). It asks first; the last admin is refused by the server and the
 * reason shows on the row; a deletion that went through signs the person out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { mountHost } from "./helpers/dom";

// A plain stand-in, not a spy: the refusal must reach the component's own catch untouched.
const { auth } = vi.hoisted(() => {
    const auth = { calls: 0, refuse: null as string | null, user: { id: "u1", username: "someone", role: "user" } };
    return { auth };
});
vi.mock("@/lib/auth-context", () => ({
    useAuth: () => ({
        user: auth.user,
        deleteAccount: async () => {
            auth.calls++;
            if (auth.refuse) throw new Error(auth.refuse);
        },
    }),
}));
vi.mock("@/lib/api", () => ({ api: { get: vi.fn(async () => ({})), post: vi.fn(async () => ({})) } }));
vi.mock("@/features/settings/hooks/useTwoFactor", () => ({
    useTwoFactor: () => ({ twoFactorEnabled: false, recoveryCodes: [], showRecoveryCodes: false, load2FAStatus: vi.fn(), setup2FA: vi.fn() }),
}));

import { AccountSection } from "@/features/settings/components/sections/AccountSection";

const dom = mountHost();
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);

beforeEach(() => {
    auth.calls = 0;
    auth.refuse = null;
});

describe("deleting your own account", () => {
    it("is offered to a member, and asks before deleting", async () => {
        act(() => dom.root.render(<AccountSection />));
        expect(dom.host.textContent).toContain("Delete account");
        await act(async () => button("Delete")!.click());
        expect(auth.calls).toBe(0);
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain("can't be undone");
        await act(async () => button("Delete account")!.click());
        expect(auth.calls).toBe(1);
    });

    it("shows the server's reason when it refuses, such as for the last admin", async () => {
        auth.refuse = "Cannot delete the only administrator account";
        act(() => dom.root.render(<AccountSection />));
        await act(async () => button("Delete")!.click());
        await act(async () => button("Delete account")!.click());
        expect(auth.calls).toBe(1);
        expect(dom.host.textContent).toContain("Cannot delete the only administrator account");
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
});
