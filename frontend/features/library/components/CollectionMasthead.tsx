"use client";

/**
 * The collection's masthead: the title, one line on how much of the library
 * has been played, and a thin band split by each mood's share of it in the
 * vibe map's colours (songs that stand out on no single mood as a blend of
 * all five), under a soft violet bleed from the top-right.
 */

import { useId, useState } from "react";
import { MOOD_COLORS, MOOD_KEYS, moodLabel, type MoodShare } from "@/features/vibe/mapUtils";

interface CollectionMastheadProps {
    title: string;
    /** The stats line; null until it loads, when `fallbackLine` shows instead. */
    heardLine: string | null;
    /** The active tab's count, e.g. "315 artists". */
    fallbackLine: string;
    shares: MoodShare[];
}

export function CollectionMasthead({ title, heardLine, fallbackLine, shares }: CollectionMastheadProps) {
    return (
        <header className="relative">
            {/* The cosmos bleed: soft violet from the top-right, reaching up past the column. */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 -top-16 h-[300px]"
                style={{
                    background: "radial-gradient(280px 280px at 82% 14%, rgba(119, 59, 151, 0.30), transparent 70%)",
                }}
            />

            <div className="relative page-shell pt-6 pb-5">
                <h1 className="t-page-title">{title}</h1>
                <p className="mt-2 text-sm tabular-nums text-[var(--text-secondary)] truncate transition-opacity duration-500">
                    {heardLine ?? fallbackLine}
                </p>
                <MoodBand shares={shares} />
            </div>
        </header>
    );
}

const rgb = ([r, g, b]: [number, number, number]) => `rgb(${r} ${g} ${b})`;

/** The songs that stand out on no single mood: every one of them still has all five scores, so a blend of the five. */
const BLEND = `linear-gradient(90deg, ${MOOD_KEYS.map((key) => rgb(MOOD_COLORS[key])).join(", ")})`;

/** What makes a song a mood, on hover or a tap: the same line the mixes, stations and tags use. */
const BAND_TOOLTIP =
    "a song counts as a mood when it scores 1.25 standard deviations or more above your library's average for that " +
    "mood. songs that don't stand out on any one of the five are the blend.";

const bandName = (key: string) => (key === "neutral" ? "a mix of moods" : moodLabel(key).toLowerCase());

/**
 * One 4px band, each mood's stretch as wide as its share; a quiet track until the map loads. Hovering it shows what makes
 * a song a mood; a tap or a click spells it out under the band, for touch screens, where a hover tooltip never shows.
 */
function MoodBand({ shares }: { shares: MoodShare[] }) {
    const [explained, setExplained] = useState(false);
    const explanationId = useId();
    const label = shares.length
        ? "moods: " + shares.map((s) => `${bandName(s.key)} ${Math.round(s.fraction * 100)}%`).join(", ")
        : undefined;

    const band = (
        // The keyboard ring hugs the band itself, not the larger tap area around it.
        <div
            className="h-1 w-full overflow-hidden rounded-full group-focus-visible:outline-2 group-focus-visible:outline-offset-4 group-focus-visible:outline-brand"
            style={{ background: "rgba(255, 240, 214, 0.06)" }}
        >
            <div className="flex h-full w-full">
                {shares.map((share) => (
                    <div
                        key={share.key}
                        data-mood={share.key}
                        className="h-full transition-[width] duration-500"
                        style={{
                            width: `${share.fraction * 100}%`,
                            background: share.key === "neutral" ? BLEND : rgb(MOOD_COLORS[share.key] ?? MOOD_COLORS.neutral),
                        }}
                    />
                ))}
            </div>
        </div>
    );

    // Until the map loads there is nothing to explain: a plain track where the band will be.
    if (!shares.length) return <div className="mt-3">{band}</div>;

    return (
        <>
            {/* A 44px target around the 4px band, which stays exactly where it was. */}
            <button
                type="button"
                title={BAND_TOOLTIP}
                aria-label={label}
                aria-expanded={explained}
                aria-controls={explanationId}
                onClick={() => setExplained((open) => !open)}
                className="group -mb-5 -mt-2 block w-full py-5"
                // The global keyboard ring would box the whole tap area across the text around it; the band draws its own.
                style={{ outline: "none" }}
            >
                {band}
            </button>
            <p id={explanationId} hidden={!explained} className="mt-2 max-w-prose text-xs text-[var(--text-muted)]">
                {BAND_TOOLTIP}
            </p>
        </>
    );
}
