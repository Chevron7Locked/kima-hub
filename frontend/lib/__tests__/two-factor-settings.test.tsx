/**
 * Two-factor on the web, through the real settings hook and the screens a person uses: setup sends only the code (the
 * server kept the secret), turning it off takes an authenticator code or a recovery code, new recovery codes can be
 * made without turning it off, and an admin can turn off another person's 2FA from the users list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { mountHost } from "./helpers/dom";

const { api, auth } = vi.hoisted(() => {
    const api = {
        status: { enabled: false },
        users: [] as Array<Record<string, unknown>>,
        get: vi.fn(),
        setupTwoFactor: vi.fn(),
        enableTwoFactor: vi.fn(),
        disableTwoFactor: vi.fn(),
        newRecoveryCodes: vi.fn(),
        resetTwoFactor: vi.fn(),
    };
    const auth = { user: { id: "me", username: "me", role: "admin" } };
    return { api, auth };
});
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: auth.user, deleteAccount: vi.fn() }) }));

import { AccountSection } from "@/features/settings/components/sections/AccountSection";
import { UserManagementSection } from "@/features/settings/components/sections/UserManagementSection";

const dom = mountHost();
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const field = (placeholder: string) => document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;

function type(input: HTMLInputElement, value: string) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
        set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

async function showAccount() {
    await act(async () => dom.root.render(<AccountSection />));
}

beforeEach(() => {
    api.status = { enabled: false };
    api.users = [];
    api.get.mockReset().mockImplementation(async (path: string) => (path === "/auth/users" ? api.users : api.status));
    api.setupTwoFactor.mockReset().mockResolvedValue({ secret: "BASE32SECRET", qrCode: "" });
    api.enableTwoFactor.mockReset().mockResolvedValue(["AAAA1111"]);
    api.disableTwoFactor.mockReset().mockResolvedValue(undefined);
    api.newRecoveryCodes.mockReset().mockResolvedValue([]);
    api.resetTwoFactor.mockReset().mockResolvedValue(undefined);
    auth.user = { id: "me", username: "me", role: "admin" };
});

describe("setting 2FA up", () => {
    it("sends only the code to enable it: the server checks it against the secret it kept", async () => {
        await showAccount();
        await act(async () => button("Enable")!.click());
        type(field("Enter 6-digit code"), "123456");
        await act(async () => button("Verify")!.click());

        expect(api.setupTwoFactor).toHaveBeenCalledTimes(1);
        expect(api.enableTwoFactor).toHaveBeenCalledWith("123456");
        expect(document.querySelector('[role="dialog"]')?.textContent ?? "").toContain("AAAA1111");
    });
});

describe("turning 2FA off", () => {
    beforeEach(() => {
        api.status = { enabled: true };
    });

    it("takes a recovery code in place of an authenticator code", async () => {
        await showAccount();
        await act(async () => button("Disable")!.click());
        type(field("Password"), "hunter22");
        type(field("6-digit code or recovery code"), "a1b2c3d4");
        expect(field("6-digit code or recovery code").value).toBe("A1B2C3D4");
        await act(async () => button("Disable 2FA")!.click());

        expect(api.disableTwoFactor).toHaveBeenCalledWith("hunter22", "A1B2C3D4");
    });

    it("takes a sixteen-character recovery code, upper-cased, pasted with spaces or dashes, and no more than sixteen characters", async () => {
        await showAccount();
        await act(async () => button("Disable")!.click());
        type(field("Password"), "hunter22");

        type(field("6-digit code or recovery code"), "a1b2 c3d4-e5f6 0718 9aff");
        expect(field("6-digit code or recovery code").value).toBe("A1B2C3D4E5F60718");
        expect(button("Disable 2FA")!.hasAttribute("disabled")).toBe(false);
        await act(async () => button("Disable 2FA")!.click());

        expect(api.disableTwoFactor).toHaveBeenCalledWith("hunter22", "A1B2C3D4E5F60718");
    });

    it("holds the button back for a length between the two recovery code lengths", async () => {
        await showAccount();
        await act(async () => button("Disable")!.click());
        type(field("Password"), "hunter22");

        type(field("6-digit code or recovery code"), "A1B2C3D4E5F6");

        expect(button("Disable 2FA")!.hasAttribute("disabled")).toBe(true);
    });

    it("still takes a six-digit code, and holds the button back for anything that is neither shape", async () => {
        await showAccount();
        await act(async () => button("Disable")!.click());
        type(field("Password"), "hunter22");

        type(field("6-digit code or recovery code"), "1234567");
        expect(button("Disable 2FA")!.hasAttribute("disabled")).toBe(true);

        type(field("6-digit code or recovery code"), "123456");
        expect(button("Disable 2FA")!.hasAttribute("disabled")).toBe(false);
        await act(async () => button("Disable 2FA")!.click());
        expect(api.disableTwoFactor).toHaveBeenCalledWith("hunter22", "123456");
    });
});

describe("new recovery codes", () => {
    it("are not offered while 2FA is off", async () => {
        await showAccount();
        expect(button("New codes")).toBeUndefined();
    });

    it("are made with the password and a code, and shown once", async () => {
        api.status = { enabled: true };
        api.newRecoveryCodes.mockResolvedValue(["AAAA1111", "BBBB2222"]);
        await showAccount();
        await act(async () => button("New codes")!.click());
        type(field("Password"), "hunter22");
        type(field("6-digit code or recovery code"), "654321");
        await act(async () => button("Make new codes")!.click());

        expect(api.newRecoveryCodes).toHaveBeenCalledWith("hunter22", "654321");
        const dialog = document.querySelector('[role="dialog"]')?.textContent ?? "";
        expect(dialog).toContain("AAAA1111");
        expect(dialog).toContain("BBBB2222");
        expect(dom.host.textContent).toContain("The old ones no longer work");
    });

    it("show the server's reason on the control when it refuses, and keep the form for another try", async () => {
        api.status = { enabled: true };
        api.newRecoveryCodes.mockRejectedValue(new Error("Invalid 2FA token"));
        await showAccount();
        await act(async () => button("New codes")!.click());
        type(field("Password"), "hunter22");
        type(field("6-digit code or recovery code"), "000000");
        await act(async () => button("Make new codes")!.click());

        expect(dom.host.textContent).toContain("Invalid 2FA token");
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(button("Make new codes")).toBeDefined();
    });
});

describe("an admin turning off someone's 2FA", () => {
    const people = () => [
        { id: "me", username: "me", role: "admin", twoFactorEnabled: true, createdAt: "2026-01-01" },
        { id: "u2", username: "locked-out", role: "user", twoFactorEnabled: true, createdAt: "2026-01-02" },
        { id: "u3", username: "plain", role: "user", twoFactorEnabled: false, createdAt: "2026-01-03" },
    ];
    const showUsers = async () => {
        api.users = people();
        await act(async () =>
            dom.root.render(<UserManagementSection settings={{ registrationOpen: false } as never} onUpdate={vi.fn()} />),
        );
    };
    const resetButtons = () => [...document.querySelectorAll("button[aria-label^='reset 2fa for']")];

    it("is offered only on other people who have it on", async () => {
        await showUsers();
        expect(resetButtons().map((b) => b.getAttribute("aria-label"))).toEqual(["reset 2fa for locked-out"]);
    });

    it("asks on the first click and acts on the second, then the list is read again", async () => {
        await showUsers();
        await act(async () => resetButtons()[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(api.resetTwoFactor).not.toHaveBeenCalled();
        expect(resetButtons()[0].textContent?.trim()).toBe("Confirm reset");

        api.users = people().map((u) => (u.id === "u2" ? { ...u, twoFactorEnabled: false } : u));
        await act(async () => resetButtons()[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));

        expect(api.resetTwoFactor).toHaveBeenCalledWith("u2");
        expect(dom.host.textContent).toContain("2FA turned off");
        expect(resetButtons()).toHaveLength(0);
    });

    it("shows the server's reason on the row when it fails", async () => {
        api.resetTwoFactor.mockRejectedValue(new Error("User not found"));
        await showUsers();
        await act(async () => resetButtons()[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
        await act(async () => resetButtons()[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));

        expect(dom.host.textContent).toContain("User not found");
    });
});
