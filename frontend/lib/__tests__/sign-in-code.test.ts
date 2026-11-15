/**
 * The machine code a failed sign-in carries: the server answers `code` beside its text, `api.request` keeps the body on
 * the error as `data`, and the page reads the code through one helper. A sign-in that needs a second factor answers 200,
 * so the auth context makes its own error with the same code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { SECOND_FACTOR_CODE, secondFactorRequired, signInCode } from "../second-factor";

describe("signInCode", () => {
    it("reads the code from the body an api error carries", () => {
        const err = Object.assign(new Error("Invalid 2FA token"), { status: 401, data: { error: "Invalid 2FA token", code: "INVALID_2FA_TOKEN" } });

        expect(signInCode(err)).toBe(SECOND_FACTOR_CODE.invalid);
    });

    it.each([
        ["an error with no body", new Error("Invalid 2FA token")],
        ["a body with no code", Object.assign(new Error("x"), { data: { error: "x" } })],
        ["a code that is not text", Object.assign(new Error("x"), { data: { code: 4 } })],
        ["something that is not an error", "2FA token required"],
        ["nothing", undefined],
    ])("is undefined for %s, whatever its words", (_name, err) => {
        expect(signInCode(err)).toBeUndefined();
    });
});

describe("secondFactorRequired", () => {
    it("is an error whose code says the second factor is needed", () => {
        const err = secondFactorRequired();

        expect(err).toBeInstanceOf(Error);
        expect(signInCode(err)).toBe(SECOND_FACTOR_CODE.required);
        expect(err.message).toBe("2FA token required");
    });
});

describe("a refused sign-in through the api client", () => {
    beforeEach(() => {
        vi.stubGlobal("window", {});
        vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it("keeps the server's code on the error it throws", async () => {
        const body = { error: "Invalid recovery code", code: "INVALID_RECOVERY_CODE" };
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, statusText: "Unauthorized", headers: { entries: () => [] }, json: async () => body })));

        let caught: unknown;
        try { await api.login("someone", "hunter22", "0123456789ABCDEF"); } catch (err) { caught = err; }

        expect((caught as Error).message).toBe("Invalid recovery code");
        expect(signInCode(caught)).toBe(SECOND_FACTOR_CODE.invalidRecovery);
    });
});
