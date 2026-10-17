/**
 * Melancholy sorts low valence, low energy and minor key first. Valence counts
 * MELANCHOLY_VALENCE_SCALE times over, so a valence gap on the stored scale
 * weighs as it did against energy before the mood mapping narrowed it.
 */
import { melancholyScore, MELANCHOLY_VALENCE_SCALE } from "../mixes/moodMixes";

describe("melancholyScore", () => {
    it("adds valence x 2 x the scale, energy, and 0.3 for a major key", () => {
        expect(melancholyScore({ valence: 0.4, energy: 0.3, keyScale: "major" })).toBeCloseTo(
            0.4 * 2 * MELANCHOLY_VALENCE_SCALE + 0.3 + 0.3,
            10
        );
        expect(melancholyScore({ valence: 0.4, energy: 0.3, keyScale: "minor" })).toBeCloseTo(
            0.4 * 2 * MELANCHOLY_VALENCE_SCALE + 0.3,
            10
        );
    });

    it("a 0.1 valence gap outweighs a 0.4 energy gap", () => {
        const sadder = { valence: 0.45, energy: 0.6, keyScale: "minor" };
        const calmer = { valence: 0.55, energy: 0.2, keyScale: "minor" };
        expect(melancholyScore(sadder)).toBeLessThan(melancholyScore(calmer));
    });

    it("reads a missing valence or energy as 0.5", () => {
        expect(melancholyScore({ valence: null, energy: undefined, keyScale: "minor" })).toBeCloseTo(
            0.5 * 2 * MELANCHOLY_VALENCE_SCALE + 0.5,
            10
        );
    });
});
