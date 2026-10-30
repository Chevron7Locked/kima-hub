/**
 * The collection masthead's mood band: each mood's stretch in its own colour, the songs that stand out on no single
 * mood as a blend of all five, and a tooltip saying what makes a song a mood.
 */
import { describe, it, expect } from "vitest";
import React, { act } from "react";
import { CollectionMasthead } from "@/features/library/components/CollectionMasthead";
import { MOOD_COLORS, MOOD_KEYS } from "@/features/vibe/mapUtils";
import { mountHost } from "./helpers/dom";

const dom = mountHost();

const shares = [
    { key: "moodAggressive", fraction: 0.13 },
    { key: "moodRelaxed", fraction: 0.13 },
    { key: "neutral", fraction: 0.49 },
];

function show() {
    act(() =>
        dom.root.render(<CollectionMasthead title="Collection" heardLine={null} fallbackLine="9 albums" shares={shares} />),
    );
    return dom.host.querySelector<HTMLElement>('[role="img"]')!;
}

describe("CollectionMasthead mood band", () => {
    it("draws the songs that stand out on no single mood as a blend of all five mood colours", () => {
        const band = show();
        const stretches = [...band.querySelectorAll<HTMLElement>("[data-mood]")];
        const blend = stretches.find((s) => s.dataset.mood === "neutral")!;
        expect(blend.style.width).toBe("49%");
        expect(blend.style.background).toMatch(/linear-gradient/);
        for (const key of MOOD_KEYS) {
            const [r, g, b] = MOOD_COLORS[key];
            expect(blend.style.background).toMatch(new RegExp(`rgb\\(${r}[ ,]+${g}[ ,]+${b}\\)`));
        }
        const calm = stretches.find((s) => s.dataset.mood === "moodRelaxed")!;
        expect(calm.style.background).not.toMatch(/gradient/);
    });

    it("says what makes a song a mood, and names the blend as a mix", () => {
        const band = show();
        const tooltip = band.closest("[title]")?.getAttribute("title") ?? "";
        expect(tooltip).toMatch(/1\.25/);
        expect(tooltip).toMatch(/your library's average/);
        expect(tooltip).toBe(tooltip.toLowerCase());
        expect(band.getAttribute("aria-label")).toContain("a mix of moods 49%");
        expect(band.getAttribute("aria-label")).not.toContain("no single mood");
    });
});
