/** The password rule the sign-up form checks before sending: 6 characters at least, 72 UTF-8 bytes at most. */
import { describe, it, expect } from "vitest";
import { passwordProblem } from "@/lib/passwordRule";

describe("passwordProblem", () => {
    it("takes 6 characters and 72 bytes", () => {
        expect(passwordProblem("abcdef")).toBeNull();
        expect(passwordProblem("a".repeat(72))).toBeNull();
        expect(passwordProblem("é".repeat(36))).toBeNull();
    });

    it("refuses fewer than 6 characters", () => {
        expect(passwordProblem("")).toBe("Password must be at least 6 characters");
        expect(passwordProblem("12345")).toBe("Password must be at least 6 characters");
    });

    it("refuses 73 bytes, counting accented letters as two and emoji as four", () => {
        const tooLong = /^Password must be at most 72 characters/;
        expect(passwordProblem("a".repeat(73))).toMatch(tooLong);
        expect(passwordProblem("é".repeat(37))).toMatch(tooLong);
        expect(passwordProblem("😀".repeat(19))).toMatch(tooLong);
        expect(passwordProblem("😀".repeat(18))).toBeNull();
    });
});
