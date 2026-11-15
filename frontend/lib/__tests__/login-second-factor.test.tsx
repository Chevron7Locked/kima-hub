/**
 * The second step of web sign-in, through the real login page: a recovery code is sixteen hex characters (lists made
 * before 1.13 hold eight), typed or pasted with spaces and dashes in any case; an authenticator code is six digits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { mountHost } from "./helpers/dom";

const { login, api } = vi.hoisted(() => ({
    login: vi.fn(),
    api: { get: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ login }) }));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

import LoginPage from "@/app/login/page";

const dom = mountHost();
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const factor = () => document.querySelector<HTMLInputElement>("#twoFactorToken")!;

function type(input: HTMLInputElement, value: string) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
        set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

/** What the page gets from a failed sign-in: an error whose `data` is the server's body, as `api.request` makes it. */
const answered = (message: string, code?: string) => Object.assign(new Error(message), { status: 401, data: code ? { error: message, code } : { error: message } });
const required = () => Object.assign(new Error("2FA token required"), { data: { requires2FA: true, code: "2FA_REQUIRED" } });
const alert = () => document.body.textContent ?? "";

async function submit() {
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

async function reachSecondStep() {
    login.mockRejectedValueOnce(required());
    await act(async () => dom.root.render(<LoginPage />));
    type(document.querySelector<HTMLInputElement>("input[type='text']")!, "someone");
    type(document.querySelector<HTMLInputElement>("input[type='password']")!, "hunter22");
    await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

beforeEach(() => {
    login.mockReset().mockResolvedValue(undefined);
    api.get.mockReset().mockResolvedValue({ hasAccount: true });
});

describe("signing in with a second factor", () => {
    it("takes a sixteen-character recovery code, pasted with spaces or dashes in lower case, and sends it upper-cased", async () => {
        await reachSecondStep();
        await act(async () => button("Use recovery code instead")!.click());

        type(factor(), "a1b2 c3d4-e5f6 0718");

        expect(factor().value).toBe("A1B2C3D4E5F60718");
        expect(factor().maxLength).toBeGreaterThanOrEqual(16);
        await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
        expect(login).toHaveBeenLastCalledWith("someone", "hunter22", "A1B2C3D4E5F60718");
    });

    it("still takes an eight-character recovery code from an older list", async () => {
        await reachSecondStep();
        await act(async () => button("Use recovery code instead")!.click());

        type(factor(), "abcd1234");

        expect(factor().value).toBe("ABCD1234");
    });

    it("keeps an authenticator code to six digits", async () => {
        await reachSecondStep();

        type(factor(), "123 4567");

        expect(factor().value).toBe("123456");
    });
});

describe("what the page reads from a failed sign-in is the code, not the words", () => {
    it("goes to the second step on 2FA_REQUIRED, whatever the message says", async () => {
        login.mockRejectedValueOnce(Object.assign(new Error("a different sentence"), { data: { code: "2FA_REQUIRED" } }));
        await act(async () => dom.root.render(<LoginPage />));
        type(document.querySelector<HTMLInputElement>("input[type='text']")!, "someone");
        type(document.querySelector<HTMLInputElement>("input[type='password']")!, "hunter22");
        await submit();

        expect(factor()).not.toBeNull();
        expect(alert()).not.toContain("a different sentence");
    });

    it("does not go to the second step because a message happens to say so", async () => {
        login.mockRejectedValueOnce(answered("2FA token required"));
        await act(async () => dom.root.render(<LoginPage />));
        type(document.querySelector<HTMLInputElement>("input[type='text']")!, "someone");
        type(document.querySelector<HTMLInputElement>("input[type='password']")!, "hunter22");
        await submit();

        expect(factor()).toBeNull();
        expect(alert()).toContain("2FA token required");
    });

    it.each([
        ["INVALID_2FA_TOKEN", "Invalid 2FA token"],
        ["INVALID_RECOVERY_CODE", "Invalid recovery code"],
    ])("stays on the second step on %s, shows the server's words, and empties the field", async (code, message) => {
        await reachSecondStep();
        type(factor(), "000000");
        login.mockRejectedValueOnce(answered(message, code));
        await submit();

        expect(factor()).not.toBeNull();
        expect(factor().value).toBe("");
        expect(alert()).toContain(message);
    });

    it("stays on the second step on INVALID_2FA_TOKEN even when the words are not the ones it knew", async () => {
        await reachSecondStep();
        type(factor(), "000000");
        login.mockRejectedValueOnce(answered("That code is not right", "INVALID_2FA_TOKEN"));
        await submit();

        expect(factor()).not.toBeNull();
        expect(alert()).toContain("That code is not right");
    });

    it("goes back to the first step on 2FA_UNAVAILABLE, with the server's words", async () => {
        await reachSecondStep();
        type(factor(), "000000");
        login.mockRejectedValueOnce(answered("Two-factor sign-in is unavailable for this account", "2FA_UNAVAILABLE"));
        await submit();

        expect(factor()).toBeNull();
        expect(alert()).toContain("Two-factor sign-in is unavailable for this account");
    });

    it("goes back to the first step on any other failure, such as a wrong password", async () => {
        await reachSecondStep();
        type(factor(), "000000");
        login.mockRejectedValueOnce(answered("Invalid credentials"));
        await submit();

        expect(factor()).toBeNull();
        expect(alert()).toContain("Invalid credentials");
    });
});
