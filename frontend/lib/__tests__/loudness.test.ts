import { describe, it, expect } from "vitest";
import { loudnessFactor, isValidLoudness, WEB_TARGET_LUFS } from "../loudness";

describe("isValidLoudness", () => {
    it("accepts real integrated loudness and rejects everything else", () => {
        expect(isValidLoudness(-9.1)).toBe(true);
        expect(isValidLoudness(-60)).toBe(false);
        expect(isValidLoudness(0)).toBe(true);
        expect(isValidLoudness(null)).toBe(false);
        expect(isValidLoudness(2868.6)).toBe(false);
        expect(isValidLoudness(NaN)).toBe(false);
    });
});

describe("loudnessFactor", () => {
    it("is a no-op multiplier when normalization is off or unmeasured", () => {
        expect(loudnessFactor(-9.1, false)).toBe(1);
        expect(loudnessFactor(null, true)).toBe(1);
        expect(loudnessFactor(undefined, true)).toBe(1);
        expect(loudnessFactor(2868.6, true)).toBe(1);
    });

    it("attenuates a loud master to the reference", () => {
        // -9.1 LUFS is 8.9 dB above the -18 target: factor 10^(-8.9/20).
        expect(loudnessFactor(-9.1, true)).toBeCloseTo(Math.pow(10, -8.9 / 20), 10);
    });

    it("leaves a reference-loudness track at full volume", () => {
        expect(loudnessFactor(WEB_TARGET_LUFS, true)).toBe(1);
    });

    it("never boosts a quiet track", () => {
        expect(loudnessFactor(-24, true)).toBe(1);
        expect(loudnessFactor(-50, true)).toBe(1);
    });

    it("attenuates an extreme but valid loud reading by the full target distance", () => {
        // 0 LUFS is the loudest valid reading: 18 dB down to the -18 target.
        expect(loudnessFactor(0, true)).toBeCloseTo(Math.pow(10, -18 / 20), 10);
    });
});
