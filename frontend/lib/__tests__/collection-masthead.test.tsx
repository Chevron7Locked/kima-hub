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
    return dom.host.querySelector<HTMLElement>('button[aria-label^="moods:"]')!;
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
        const tooltip = band.getAttribute("title") ?? "";
        expect(tooltip).toMatch(/1\.25/);
        expect(tooltip).toMatch(/your library's average/);
        expect(tooltip).toBe(tooltip.toLowerCase());
        expect(band.getAttribute("aria-label")).toContain("a mix of moods 49%");
        expect(band.getAttribute("aria-label")).not.toContain("no single mood");
    });

    it("spells the rule out under the band on a tap, for touch screens where a tooltip never shows", () => {
        const band = show();
        const explanation = document.getElementById(band.getAttribute("aria-controls")!)!;
        expect(band.getAttribute("aria-expanded")).toBe("false");
        expect(explanation.hidden).toBe(true);
        act(() => band.click());
        expect(band.getAttribute("aria-expanded")).toBe("true");
        expect(explanation.hidden).toBe(false);
        expect(explanation.textContent).toBe(band.getAttribute("title"));
        act(() => band.click());
        expect(explanation.hidden).toBe(true);
    });
});
