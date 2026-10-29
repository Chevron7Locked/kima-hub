"use client";

/**
 * The circle of fifths, lit by how often you play in each key. Majors outside,
 * relative minors directly inside; neighbours share all but one note.
 * Brightness is the only encoding.
 */

import { useMemo, useState } from "react";
import { useInView } from "@/hooks/useInView";
import { usePlaySlice } from "../usePlaySlice";
import type { Signature } from "../types";

/** Clockwise from the top. Neighbours differ by one sharp or flat. */
const MAJORS = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"];
const MINORS = ["A", "E", "B", "F#", "C#", "G#", "Eb", "Bb", "F", "C", "G", "D"];

/** Essentia may give either spelling; the wheel has one slot for both. */
const SAME: Record<string, string> = {
    "Gb": "F#", "C#": "Db", "G#": "Ab", "D#": "Eb", "A#": "Bb",
    "Cb": "B", "Fb": "E", "E#": "F", "B#": "C",
};
const slot = (k: string) => SAME[k] ?? k;

const TAU = Math.PI * 2;
const CX = 50, CY = 50;

/** One segment of an annulus, as a path. Angles run clockwise from the top. */
function sector(from: number, to: number, rInner: number, rOuter: number): string {
    const a = (t: number) => (t / 12) * TAU - TAU / 4;
    const pt = (t: number, r: number) => [CX + Math.cos(a(t)) * r, CY + Math.sin(a(t)) * r];
    const [x0o, y0o] = pt(from, rOuter);
    const [x1o, y1o] = pt(to, rOuter);
    const [x1i, y1i] = pt(to, rInner);
    const [x0i, y0i] = pt(from, rInner);
    return [
        `M ${x0o.toFixed(2)} ${y0o.toFixed(2)}`,
        `A ${rOuter} ${rOuter} 0 0 1 ${x1o.toFixed(2)} ${y1o.toFixed(2)}`,
        `L ${x1i.toFixed(2)} ${y1i.toFixed(2)}`,
        `A ${rInner} ${rInner} 0 0 0 ${x0i.toFixed(2)} ${y0i.toFixed(2)}`,
        "Z",
    ].join(" ");
}

export function KeyWheel({ keys, period }: { keys: NonNullable<Signature["key"]>; period?: string }) {
    const { ref, shown } = useInView<HTMLElement>({ threshold: 0.3 });
    const { play, busy } = usePlaySlice();
    const [hover, setHover] = useState<{ name: string; plays: number } | null>(null);

    const { ring, max, total } = useMemo(() => {
        const counts = new Map<string, number>();
        let total = 0;
        for (const k of keys.all) {
            const id = `${slot(k.key)}|${k.scale}`;
            counts.set(id, (counts.get(id) ?? 0) + k.plays);
            total += k.plays;
        }
        const ring = MAJORS.map((maj, i) => ({
            i,
            major: { name: maj, plays: counts.get(`${maj}|major`) ?? 0 },
            minor: { name: MINORS[i], plays: counts.get(`${slot(MINORS[i])}|minor`) ?? 0 },
        }));
        const max = Math.max(1, ...ring.flatMap((r) => [r.major.plays, r.minor.plays]));
        return { ring, max, total };
    }, [keys]);

    const ink = (n: number) => {
        if (n === 0) return "var(--chart-ink-faint)";
        const share = Math.pow(n / max, 0.6);
        return `color-mix(in oklab, var(--color-brand) ${Math.round(12 + 88 * share)}%, transparent)`;
    };

    const busiest = ring.reduce<{ name: string; plays: number }>(
        (best, r) => {
            const here = r.minor.plays >= r.major.plays
                ? { name: `${r.minor.name} minor`, plays: r.minor.plays }
                : { name: `${r.major.name} major`, plays: r.major.plays };
            return here.plays > best.plays ? here : best;
        },
        { name: "", plays: 0 },
    );

    return (
        <figure ref={ref} className="m-0 flex flex-col gap-5">
            <svg
                viewBox="0 0 100 100"
                /* As wide as the column allows on phones, for touch targets,
                    but never taller than the panel leaves room for. */
                className="w-full aspect-square max-w-[calc(var(--fit-h)*0.4)] lg:max-w-[min(19rem,calc(var(--fit-h)-12rem))]"
                role="img"
                aria-label={`key wheel · top key: ${busiest.name.toLowerCase()} · ${Math.round(keys.minorPct)}% minor`}
            >
                {ring.map((r) => {
                    const wedge = (
                        which: "major" | "minor",
                        d: string,
                        plays: number,
                        name: string,
                        delay: number,
                    ) => {
                        const label = `${name} ${which}`;
                        const dead = plays === 0;
                        return (
                            <path
                                key={`${r.major.name}-${which}`}
                                d={d}
                                fill={shown ? ink(plays) : "var(--chart-ink-faint)"}
                                stroke={hover?.name === label ? "#ffffff" : "transparent"}
                                strokeWidth="0.7"
                                role={dead ? undefined : "button"}
                                tabIndex={dead ? undefined : 0}
                                aria-label={dead ? undefined : `play ${label.toLowerCase()}, ${plays} ${plays === 1 ? "play" : "plays"}`}
                                onPointerEnter={() => setHover({ name: label, plays })}
                                onPointerLeave={() => setHover(null)}
                                onFocus={() => setHover({ name: label, plays })}
                                onBlur={() => setHover(null)}
                                onClick={dead ? undefined : () => void play("key", { key: label, limit: 40, token: label, period })}
                                onKeyDown={dead ? undefined : (e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        void play("key", { key: label, limit: 40, token: label, period });
                                    }
                                }}
                                style={{
                                    cursor: dead ? "default" : "pointer",
                                    opacity: busy === label ? 0.55 : 1,
                                    transition: "fill 520ms cubic-bezier(0.25,1,0.5,1), stroke 150ms, opacity 150ms",
                                    transitionDelay: `${delay}ms, 0ms, 0ms`,
                                    outline: "none",
                                }}
                            />
                        );
                    };
                    return (
                        <g key={r.major.name}>
                            {wedge("major", sector(r.i - 0.46, r.i + 0.46, 33.5, 45), r.major.plays, r.major.name, r.i * 45)}
                            {wedge("minor", sector(r.i - 0.46, r.i + 0.46, 19, 30.5), r.minor.plays, r.minor.name, r.i * 45 + 90)}
                        </g>
                    );
                })}

                {/* Majors on the outer ring; the minor inside each is its relative. */}
                {ring.map((r) => {
                    const a = (r.i / 12) * TAU - TAU / 4;
                    const x = CX + Math.cos(a) * 39.2;
                    const y = CY + Math.sin(a) * 39.2;
                    const loud = r.major.plays / max > 0.45;
                    return (
                        <text
                            key={`t-${r.major.name}`}
                            x={x} y={y}
                            textAnchor="middle" dominantBaseline="central"
                            fontSize="4.4"
                            fill={loud ? "#0a0a0a" : "rgba(229,229,229,0.75)"}
                            pointerEvents="none"
                            style={{ fontWeight: 500, letterSpacing: "-0.02em" }}
                        >
                            {r.major.name.toLowerCase()}
                        </text>
                    );
                })}

                {ring.map((r) => {
                    const a = (r.i / 12) * TAU - TAU / 4;
                    const loud = r.minor.plays / max > 0.45;
                    return (
                        <text
                            key={`m-${r.minor.name}`}
                            x={CX + Math.cos(a) * 24.75} y={CY + Math.sin(a) * 24.75}
                            textAnchor="middle" dominantBaseline="central"
                            fontSize="3.3"
                            fill={loud ? "#0a0a0a" : "rgba(229,229,229,0.6)"}
                            pointerEvents="none"
                            style={{ fontWeight: 500, letterSpacing: "-0.02em" }}
                        >
                            {`${r.minor.name.toLowerCase()}m`}
                        </text>
                    );
                })}

                <text
                    x={CX} y={CY - 2.5} textAnchor="middle" dominantBaseline="central"
                    fontSize="12" fill="#e5e5e5" pointerEvents="none" style={{ fontWeight: 200 }}
                >
                    {`${Math.round(keys.minorPct)}%`}
                </text>
                <text
                    x={CX} y={CY + 6} textAnchor="middle" dominantBaseline="central"
                    fontSize="4" fill="#858585" pointerEvents="none" style={{ letterSpacing: "0.06em" }}
                >
                    minor
                </text>
            </svg>

            {/* Reserved, so reading the wheel never nudges what is under it. */}
            <figcaption className="t-meta min-h-[2.5rem] max-w-[30ch]">
                {hover
                    ? hover.plays > 0
                        ? `${hover.name.toLowerCase()}: ${hover.plays.toLocaleString()} ${hover.plays === 1 ? "play" : "plays"}`
                        : `${hover.name.toLowerCase()}: no plays`
                    : `outer: major · inner: minor · ${total.toLocaleString()} ${total === 1 ? "play" : "plays"}`}
            </figcaption>
        </figure>
    );
}
