import { describe, it, expect } from "vitest";
import { normalizeNFC } from "@/lib/format";

describe("normalizeNFC", () => {
    it("converts decomposed (NFD) acute accent to precomposed (NFC)", () => {
        // "é" as base letter e (U+0065) + combining acute accent U+0301
        const nfd = "J" + "\u0065" + "\u0301" + "rémy";
        const result = normalizeNFC(nfd);
        expect(result).toBe("J\xe9r\xe9my");
        // Verify NFC form: the combined é is single codepoint U+00E9
        expect(result).not.toBe("Jeremy"); // not ASCII passthrough
        expect(normalizeNFC(nfd)).not.toBe(nfd);
        expect(result.charCodeAt(1)).toBe(0x00e9); // precomposed é
    });

    it("passes already-NFC strings unchanged", () => {
        const nfc = "Jérémie";
        const result = normalizeNFC(nfc);
        expect(result).toBe(nfc);
    });

    it("leaves plain ASCII strings unchanged", () => {
        const ascii = "Hello World 123";
        const result = normalizeNFC(ascii);
        expect(result).toBe(ascii);
    });

    it("handles mixed decomposed and precomposed accents", () => {
        // é (precomposed U+00E9) + é (decomposed: e + U+0301)
        const mixed = "cafe\u0301 caf\u00e9";
        const result = normalizeNFC(mixed);
        // Both should become the precomposed form
        const expected = "café café";
        expect(result).toBe(expected);
    });

    it("produces a string (not mutating the original)", () => {
        const nfd = "caf\u0065" + "\u0301"; // café NFD
        const originalRef = nfd;
        const result = normalizeNFC(nfd);
        expect(result).not.toBe(nfd);
        // Original input is unaffected (strings are immutable anyway, but assert)
        expect(originalRef.length).toBeGreaterThan(0);
    });

    it("handles empty string", () => {
        expect(normalizeNFC("")).toBe("");
    });
});
