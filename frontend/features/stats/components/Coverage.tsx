"use client";

/**
 * The part of the page that can be finished: four fractions of countable
 * things, set large in a row, each with a thin rule and the gap spelled out.
 */

import { percent } from "../format";
import { useInView } from "@/hooks/useInView";
import { usePlaySlice } from "../usePlaySlice";
import { Shuffle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { ShelfStats } from "../types";

interface Row {
    label: string;
    part: number;
    whole: number;
    unit: string;
}

export function Coverage({ shelf }: { shelf: ShelfStats }) {
    const { ref, shown } = useInView<HTMLDivElement>({ threshold: 0.3 });
    const { play, busy } = usePlaySlice();
    const rows: Row[] = [
        { label: "tracks played", part: shelf.tracks.heard, whole: shelf.tracks.total, unit: "tracks" },
        { label: "albums played", part: shelf.albums.heard, whole: shelf.albums.total, unit: "albums" },
        { label: "artists played", part: shelf.artists.heard, whole: shelf.artists.total, unit: "artists" },
        { label: "tracks analysed", part: shelf.analysis.done, whole: shelf.analysis.total, unit: "tracks" },
    ];

    return (
        <div ref={ref} className="flex flex-col gap-(--stat-gap-block)">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-4 sm:gap-x-8">
                {rows.map((row, i) => {
                    const pct = percent(row.part, row.whole);
                    return (
                        <div
                            key={row.label}
                            className={`flex flex-col gap-3 ${shown ? "animate-rise" : "opacity-0"}`}
                            style={shown ? { animationDelay: `${Math.min(i, 8) * 70}ms` } : undefined}
                        >
                            <dd className="t-figure text-[length:var(--stat-figure)]">
                                {pct}
                                <span className="text-base font-normal text-[var(--text-muted)] tracking-normal">%</span>
                            </dd>

                            <div className="relative h-[2px] w-full bg-white/[0.07]">
                                <div
                                    className="absolute inset-y-0 left-0 w-full origin-left bg-brand"
                                    style={{
                                        transform: `scaleX(${shown ? Math.max(0, Math.min(1, pct / 100)) : 0})`,
                                        transition: "transform 900ms cubic-bezier(0.25,1,0.5,1)",
                                        transitionDelay: `${140 + Math.min(i, 8) * 90}ms`,
                                    }}
                                />
                            </div>

                            <div className="flex flex-col gap-0.5">
                                <dt className="t-label text-[var(--text-secondary)]">{row.label}</dt>
                                <p className="t-meta">
                                    {row.part.toLocaleString()} of {row.whole.toLocaleString()}
                                </p>
                            </div>
                        </div>
                    );
                })}
            </dl>

            {shelf.neverPlayed > 0 && (
                <div className="flex flex-col items-start gap-4">
                    <Button
                        onClick={() => void play("never", { limit: 40 })}
                        isLoading={busy === "never"}
                    >
                        {busy !== "never" && <Shuffle className="w-4 h-4" />}
                        shuffle 40 unplayed
                    </Button>
                </div>
            )}
        </div>
    );
}
