"use client";

/**
 * The collection's masthead: the title, one line on how much of the library
 * has been played, and a thin band split by each mood's share of it in the
 * vibe map's colours (songs that stand out on no single mood as a blend of
 * all five), under a soft violet bleed from the top-right.
 */

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

            <div className="relative page-shell pt-8 pb-6">
                <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-white leading-none">{title}</h1>
                <p className="mt-3 text-sm tabular-nums text-[var(--text-secondary)] truncate transition-opacity duration-500">
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

/** What makes a song a mood, on hover: the same line the mixes, stations and tags use. */
const BAND_TOOLTIP =
    "a song counts as a mood when it scores 1.25 standard deviations or more above your library's average for that " +
    "mood. songs that don't stand out on any one of the five are the blend.";

const bandName = (key: string) => (key === "neutral" ? "a mix of moods" : moodLabel(key).toLowerCase());

/** One 4px band, each mood's stretch as wide as its share; a quiet track until the map loads. */
function MoodBand({ shares }: { shares: MoodShare[] }) {
    const label = shares.length
        ? "moods: " + shares.map((s) => `${bandName(s.key)} ${Math.round(s.fraction * 100)}%`).join(", ")
        : undefined;

    return (
        // A few pixels of hover room around the 4px band, so the tooltip can be reached.
        <div title={shares.length ? BAND_TOOLTIP : undefined} className="-mb-2 mt-1 py-2">
            <div
                role={shares.length ? "img" : undefined}
                aria-label={label}
                className="h-1 w-full overflow-hidden rounded-full"
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
        </div>
    );
}
