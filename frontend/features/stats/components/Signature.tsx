"use client";

/**
 * Graphics that need both the audio analysis of every file and the fact that
 * the files are yours.
 */

import { useInView } from "@/hooks/useInView";
import { KeyWheel } from "./KeyWheel";
import { EnergyCurve } from "./EnergyCurve";
import type { Signature as Sig } from "../types";

/* ── What it sounds like ───────────────────────────────────────────────── */

export function SignatureSound({ signature: s, period }: { signature: Sig; period?: string }) {
    return (
        <div className="grid gap-x-12 gap-y-(--stat-gap-block) lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-start">
            {s.key && <KeyWheel keys={s.key} period={period} />}
            {s.hourly.length > 3 && <EnergyCurve hourly={s.hourly} />}
        </div>
    );
}

/* ── The collection against the listening ──────────────────────────────── */

/** Shelf (grey) and listening (amber) marked on one shared track, so the gap is seen. */
export function OwnedAgainstPlayed({ signature: s }: { signature: Sig }) {
    const { ref, shown } = useInView<HTMLDivElement>({ threshold: 0.2 });
    if (s.ownedVsPlayed.length === 0) return null;

    // How far played energy sits above the library's.
    const energy = s.ownedVsPlayed.find((row) => row.unit !== "bpm");
    const above = energy
        ? Math.round(((energy.played - energy.owned) / Math.max(0.01, energy.owned)) * 100)
        : 0;

    return (
        <div ref={ref} className="flex flex-col gap-5">
            <p className="t-meta">grey = library average · amber = played average</p>

            <dl className="flex flex-col gap-4">
                {s.ownedVsPlayed.map((row, i) => {
                    const norm = (v: number) => (row.unit === "bpm" ? v / 200 : v);
                    const o = Math.max(0, Math.min(1, norm(row.owned)));
                    const pl = Math.max(0, Math.min(1, norm(row.played)));
                    const fmt = (v: number) =>
                        row.unit === "bpm" ? Math.round(v).toString() : Math.round(v * 100).toString();
                    return (
                        <div key={row.label} className="flex flex-col gap-1.5">
                            <div className="flex items-baseline justify-between gap-4">
                                <dt className="t-meta text-[var(--text-secondary)]">{row.label}</dt>
                                <dd className="t-meta tabular-nums">
                                    <span className="text-[var(--text-muted)]">{fmt(row.owned)}</span>
                                    <span className="text-[var(--text-muted)]"> → </span>
                                    <span className="t-figure text-xs">{fmt(row.played)}</span>
                                </dd>
                            </div>
                            <div className="relative h-[3px] w-full bg-white/[0.06]">
                                <span
                                    className="absolute top-1/2 -translate-y-1/2 w-[3px] h-[9px] bg-white/30"
                                    style={{ left: `${o * 100}%` }}
                                />
                                <span
                                    className="absolute top-1/2 -translate-y-1/2 w-[3px] h-[11px] bg-brand"
                                    style={{
                                        left: `${(shown ? pl : o) * 100}%`,
                                        transition: "left 760ms cubic-bezier(0.25,1,0.5,1)",
                                        transitionDelay: `${180 + i * 90}ms`,
                                    }}
                                />
                            </div>
                        </div>
                    );
                })}
            </dl>

            {/* Only when there is a gap worth stating. The legend above already
                says which mark is which, so with nothing to add this said
                nothing twice. */}
            {above > 3 && (
                <p className="t-body max-w-[38ch]">
                        played energy:{" "}
                        <span className="t-figure text-sm">{above}%</span> above library average
                </p>
            )}
        </div>
    );
}
