/**
 * The feature-only similarity's spread scales are measured values (the music-switch-2026-10-17 followup.json, in the lab archive), not
 * free parameters. The formula tests multiply by the imported constant, so they would pass with any value; this pins
 * the values.
 */
import { FEATURES_ONLY_VA_SCALE } from "../hybridSimilarity";

describe("measured mood spread scales", () => {
    it("feature-only similar tracks scale valence 4.78 and arousal 2.90", () => {
        expect(FEATURES_ONLY_VA_SCALE).toEqual({ valence: 4.78, arousal: 2.9 });
    });
});
