"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { ChevronDown, X } from "lucide-react";
import { MOOD_COLORS, isMood, moodLabel } from "./mapUtils";
import type { MapTrack } from "./types";
import { cn } from "@/lib/cn";

interface MoodLegendProps {
    tracks: MapTrack[];
    /** Every track on the map, shown after the moods. */
    trackCount: number;
    activeMood: string | null;
    /** A single chip that opens the list, so the map keeps its top edge (phones and tablets). */
    compact?: boolean;
    onPreview: (mood: string | null) => void;
    onToggle: (mood: string) => void;
}

/**
 * The library's moods, counted, largest first, then "No single mood" and "Not
 * analysed yet". Hover lights a mood's tracks; a click keeps it lit.
 */
export function MoodLegend({ tracks, trackCount, activeMood, compact = false, onPreview, onToggle }: MoodLegendProps) {
    const moods = useMemo(() => {
        const counts = new Map<string, number>();
        for (const t of tracks) counts.set(t.dominantMood, (counts.get(t.dominantMood) ?? 0) + 1);
        return [...counts.entries()].sort(
            (a, b) => Number(isMood(b[0])) - Number(isMood(a[0])) || b[1] - a[1],
        );
    }, [tracks]);

    const [open, setOpen] = useState(false);
    const chipRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            setOpen(false);
        };
        // A press anywhere but the chip or the dialog closes it, the way a
        // popover behaves; the chip is excluded so its own toggle still works.
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (dialogRef.current?.contains(target) || chipRef.current?.contains(target)) return;
            setOpen(false);
        };
        dialogRef.current?.focus();
        const chip = chipRef.current;
        document.addEventListener("keydown", onKey);
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => {
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("pointerdown", onPointerDown, true);
            chip?.focus();
        };
    }, [open]);

    const chip = ([mood, count]: [string, number]) => {
        const [r, g, b] = MOOD_COLORS[mood] ?? MOOD_COLORS.neutral;
        const on = activeMood === mood;
        return (
            <button
                key={mood}
                type="button"
                aria-pressed={on}
                onClick={() => {
                    onToggle(mood);
                    if (compact) setOpen(false);
                }}
                onMouseEnter={() => onPreview(mood)}
                onFocus={() => onPreview(mood)}
                onBlur={() => onPreview(null)}
                className="group flex shrink-0 items-center focus-visible:outline-none"
            >
                <span
                    className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors group-focus-visible:ring-2 group-focus-visible:ring-white/40"
                    style={{
                        borderColor: on ? `rgb(${r} ${g} ${b} / 0.7)` : "rgba(255,255,255,0.1)",
                        background: on ? `rgb(${r} ${g} ${b} / 0.16)` : "rgba(8,5,14,0.5)",
                        color: on ? "#fff" : "rgba(255,255,255,0.72)",
                    }}
                >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: `rgb(${r} ${g} ${b})`, boxShadow: `0 0 6px rgb(${r} ${g} ${b} / 0.8)` }} />
                    {moodLabel(mood)}
                    <span className="tabular-nums text-white/60">{count.toLocaleString()}</span>
                </span>
            </button>
        );
    };

    if (compact) {
        const active = activeMood ? MOOD_COLORS[activeMood] ?? MOOD_COLORS.neutral : null;
        return (
            <div className="relative shrink-0">
                <button
                    ref={chipRef}
                    type="button"
                    aria-label="Moods"
                    aria-expanded={open}
                    aria-haspopup="dialog"
                    onClick={() => setOpen((value) => !value)}
                    className="vibe-glass flex h-11 items-center gap-2 rounded-full px-3.5 text-[11px] text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                >
                    <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={active
                            ? { background: `rgb(${active[0]} ${active[1]} ${active[2]})`, boxShadow: `0 0 6px rgb(${active[0]} ${active[1]} ${active[2]} / 0.8)` }
                            : { background: "linear-gradient(90deg, #fca200, #773b97)" }}
                    />
                    <span className="truncate">{activeMood ? moodLabel(activeMood) : "moods"}</span>
                    <ChevronDown className={cn("h-3 w-3 text-white/50 transition-transform", open && "rotate-180")} />
                </button>

                {open && (
                    <div
                        ref={dialogRef}
                        role="dialog"
                        aria-label="Moods in your library"
                        tabIndex={-1}
                        className="vibe-glass vibe-glass--solid absolute left-0 top-full z-(--z-dropdown) mt-2 w-[min(19rem,calc(100vw-1.5rem))] rounded-xl p-2 outline-none"
                    >
                        <div className="mb-1.5 flex items-center justify-between px-1">
                            <span className="text-[11px] text-white/60">{trackCount.toLocaleString()} tracks</span>
                            <button
                                type="button"
                                onClick={() => setOpen(false)}
                                aria-label="Close moods"
                                className="flex h-7 w-7 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">{moods.map(chip)}</div>
                    </div>
                )}
            </div>
        );
    }

    const total = <span className="shrink-0 text-[11px] tabular-nums text-white/60">{trackCount.toLocaleString()} tracks</span>;

    return (
        <>
            <div
                className="flex flex-wrap gap-1.5"
                onMouseLeave={() => onPreview(null)}
                role="group"
                aria-label="Moods in your library"
            >
                {moods.map(chip)}
            </div>
            <p className="mt-2">{total}</p>
        </>
    );
}
