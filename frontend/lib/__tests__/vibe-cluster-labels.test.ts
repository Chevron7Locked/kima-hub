import { describe, it, expect } from "vitest";
import { computeClusterLabels } from "@/features/vibe/mapUtils";
import type { MapTrack } from "@/features/vibe/types";

/**
 * The vibe map draws cluster labels through deck.gl's TextLayer, which is
 * canvas-rendered -- an e2e assertion can never see them. The label logic is
 * a pure function, so this is the layer where it is actually testable.
 *
 * This guards the regression fixed alongside the labelZoom >= 11.5 gate: at
 * one point the algorithm discarded every cell that wasn't one of the two
 * dominant moods, so the map showed two vibes or none. Every occupied cell
 * must contribute, adjacent same-mood cells merge, and the cap sorts by size.
 */

function track(id: string, x: number, y: number, mood: string): MapTrack {
    return {
        id,
        x,
        y,
        title: `Track ${id}`,
        artist: "Artist",
        artistId: "a1",
        albumId: "al1",
        coverUrl: null,
        dominantMood: mood,
        moodScore: 0.8,
        moods: { [mood]: 0.8 },
        energy: 0.5,
        valence: 0.5,
    };
}

const BOUNDS = { minX: 0, maxX: 1, minY: 0, maxY: 1 };

describe("computeClusterLabels", () => {
    it("labels a single-mood cluster", () => {
        const tracks = Array.from({ length: 6 }, (_, i) => track(`t${i}`, 0.1, 0.1 + i * 0.05, "moodHappy"));
        const labels = computeClusterLabels(tracks, BOUNDS);
        expect(labels.length).toBeGreaterThan(0);
        expect(labels[0].count).toBe(6);
        expect(labels[0].label.length).toBeGreaterThan(0);
    });

    it("keeps rare moods that the old threshold discarded", () => {
        // 10 dominant tracks and 3 of a rarer mood in their own corner. The old
        // 3-track minimum with a 5x5 grid dropped these entirely.
        const dominant = Array.from({ length: 10 }, (_, i) => track(`d${i}`, 0.1 + (i % 4) * 0.03, 0.1, "moodElectronic"));
        const rare = [track("r0", 0.9, 0.9, "moodSad"), track("r1", 0.92, 0.9, "moodSad"), track("r2", 0.9, 0.92, "moodSad")];
        const labels = computeClusterLabels([...dominant, ...rare], BOUNDS);
        const sadLabel = labels.find((l) => l.x > 0.5 && l.y > 0.5);
        expect(sadLabel, `the 3-track rare-mood corner got no label; labels were ${JSON.stringify(labels)}`).toBeTruthy();
        expect(sadLabel!.count).toBe(3);
    });

    it("merges adjacent same-mood cells into one label", () => {
        // Two side-by-side cells of the same mood should be one region, not two.
        const a = Array.from({ length: 4 }, (_, i) => track(`a${i}`, 0.2, 0.2 + i * 0.03, "moodParty"));
        const b = Array.from({ length: 4 }, (_, i) => track(`b${i}`, 0.35, 0.2 + i * 0.03, "moodParty"));
        const labels = computeClusterLabels([...a, ...b], BOUNDS);
        const partyLabels = labels.filter((l) => l.count > 0);
        const totalLabelled = partyLabels.reduce((s, l) => s + l.count, 0);
        expect(totalLabelled).toBe(8);
        // 8x8 grid at these coordinates: x=0.2 and x=0.35 are cells 1 and 2 --
        // 4-connected neighbours, so they merge into exactly one party label
        // unless other moods intervene (there are none here).
        expect(labels.length).toBe(1);
    });

    it("caps the number of labels, largest first", () => {
        const tracks: MapTrack[] = [];
        const moods = ["moodHappy", "moodSad", "moodRelaxed", "moodAggressive", "moodParty", "moodAcoustic", "moodElectronic"];
        moods.forEach((mood, mi) => {
            const size = 10 - mi; // first mood biggest
            for (let i = 0; i < size; i++) {
                tracks.push(track(`${mood}-${i}`, 0.05 + mi * 0.13, 0.05 + (i % 5) * 0.02, mood));
            }
        });
        const labels = computeClusterLabels(tracks, BOUNDS, 8, { maxLabels: 3 });
        expect(labels.length).toBeLessThanOrEqual(3);
        expect(labels[0].count).toBeGreaterThanOrEqual(labels[labels.length - 1].count);
    });

    it("returns nothing for an empty map", () => {
        expect(computeClusterLabels([], BOUNDS)).toEqual([]);
    });
});
