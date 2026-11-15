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

async function reachSecondStep() {
    login.mockRejectedValueOnce(new Error("2FA token required"));
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
