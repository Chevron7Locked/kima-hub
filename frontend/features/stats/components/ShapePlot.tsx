"use client";

/**
 * Taste as a place: brightness across, energy up, one dot per played cell sized
 * by plays. Monthly points over it run faint to bright.
 * The month strip below is volume and control: pointing at a month moves the
 * ring and rewrites the caption.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useInView } from "@/hooks/useInView";
import { monthLabel, monthLong } from "../format";
import type { ListeningStats } from "../types";

const BUCKETS = 24;

/** The largest dot drawn, in viewBox units. */
const MAX_DOT_RADIUS = 2.8;

/** Largest painted radius: the current-month ring (r=3 plus a 2-wide stroke). */
const MAX_PAINTED_RADIUS = 4.2;

/** Bucket 1..24 to a point inside the frame, inset so edge dots stay inside the rule. */
const PAD = MAX_PAINTED_RADIUS;
const cellCentre = (bucket: number) =>
    PAD + (((bucket - 0.5) / BUCKETS) * (100 - PAD * 2));

/** A 0..1 measure onto the same inset scale, so the path shares the frame. */
const onScale = (v: number) => PAD + v * (100 - PAD * 2);

/** The inverse of `cellCentre`: a point in the box back to a bucket. */
const bucketAt = (pos: number) =>
    Math.min(BUCKETS, Math.max(1, Math.round(((pos - PAD) / (100 - PAD * 2)) * BUCKETS + 0.5)));

interface Region {
    x: number; y: number; listens: number;
    tracks: Array<{ title: string; artist: string; listens: number }>;
    energy: number | null; valence: number | null; bpm: number | null;
}

const brightness = (v: number) => (v < 0.4 ? "dark" : v > 0.6 ? "bright" : "neutral");
const energyWord = (e: number) => (e < 0.4 ? "low energy" : e > 0.6 ? "high energy" : "medium energy");
const plays = (n: number) => `${n.toLocaleString()} ${n === 1 ? "play" : "plays"}`;

export function ShapePlot({ listening, period }: { listening: ListeningStats; period?: string }) {
    const { shape, drift } = listening;
    const [at, setAt] = useState<number | null>(null);
    const { ref, shown } = useInView<HTMLElement>({ threshold: 0.25 });

    /* Pointing at the cloud asks the server what is there. Debounced, and
     * ticketed so an answer for a point already left never lands. */
    const [probe, setProbe] = useState<{ x: number; y: number } | null>(null);
    // The answer is kept with the point it answers for, so clearing needs no state write in the
    // effect and an old answer never sits under a new point.
    const [answered, setAnswered] = useState<{ x: number; y: number; region: Region | null } | null>(null);
    const ticket = useRef(0);

    useEffect(() => {
        if (!probe) return;
        const mine = ++ticket.current;
        const timer = setTimeout(async () => {
            try {
                const res = await api.get<Region>(
                    `/stats/region?x=${probe.x}&y=${probe.y}${period ? `&period=${period}` : ""}`,
                );
                if (ticket.current === mine) setAnswered({ x: probe.x, y: probe.y, region: res });
            } catch {
                if (ticket.current === mine) setAnswered({ x: probe.x, y: probe.y, region: null });
            }
        }, 180);
        return () => clearTimeout(timer);
        // The URL carries the window, so a new window has to invalidate the fetch.
    }, [probe, period]);

    // Derived, so pointing somewhere new shows nothing rather than the last
    // place's answer, and letting go clears it without a state write.
    const region =
        probe && answered && answered.x === probe.x && answered.y === probe.y
            ? answered.region
            : null;

    const onMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
        const box = e.currentTarget.getBoundingClientRect();
        const vx = ((e.clientX - box.left) / box.width) * 100;
        const vy = ((e.clientY - box.top) / box.height) * 100;
        const next = { x: bucketAt(vx), y: bucketAt(100 - vy) };
        setProbe((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
    }, []);

    const cloud = useMemo(() => {
        const max = shape.reduce((m, p) => Math.max(m, p.plays), 0);
        if (max === 0) return [];
        return shape.map((p) => {
            const weight = Math.sqrt(p.plays / max);
            return {
                key: `${p.x}-${p.y}`,
                cx: cellCentre(p.x),
                cy: 100 - cellCentre(p.y),
                r: 0.7 + weight * (MAX_DOT_RADIUS - 0.7),
                opacity: 0.2 + weight * 0.7,
            };
        });
    }, [shape]);

    // Months with no analysed plays have nothing to place, so they drop out
    // rather than collapsing the line into a corner.
    const path = useMemo(
        () =>
            drift
                .filter((d) => d.energy != null && d.valence != null)
                .map((d) => ({
                    month: d.month,
                    plays: d.plays,
                    energy: d.energy!,
                    valence: d.valence!,
                    bpm: d.bpm,
                    x: onScale(d.valence!),
                    y: 100 - onScale(d.energy!),
                })),
        [drift],
    );

    const active = at != null && path[at] ? at : path.length - 1;
    const maxMonth = path.reduce((m, p) => Math.max(m, p.plays), 0) || 1;
    const here = path[active];
    const latest = path[path.length - 1];

    /**
     * Play-weighted centre of the full histogram, for the idle caption that
     * speaks for every listen (not the newest month).
     */
    const overall = useMemo(() => {
        let n = 0, valence = 0, energy = 0;
        for (const cell of shape) {
            n += cell.plays;
            valence += cell.plays * ((cell.x - 0.5) / BUCKETS);
            energy += cell.plays * ((cell.y - 0.5) / BUCKETS);
        }
        return n > 0 ? { valence: valence / n, energy: energy / n } : null;
    }, [shape]);

    /** The corner you never visit, named only when it holds under one play in twenty. */
    const barestCorner = useMemo(() => {
        const total = shape.reduce((n, c) => n + c.plays, 0);
        if (total === 0) return null;
        const mid = BUCKETS / 2;
        const quadrants = [
            { name: "dark, low energy",    plays: 0, test: (c: typeof shape[0]) => c.x <= mid && c.y <= mid },
            { name: "bright, low energy",  plays: 0, test: (c: typeof shape[0]) => c.x > mid && c.y <= mid },
            { name: "dark, high energy",   plays: 0, test: (c: typeof shape[0]) => c.x <= mid && c.y > mid },
            { name: "bright, high energy", plays: 0, test: (c: typeof shape[0]) => c.x > mid && c.y > mid },
        ];
        for (const cell of shape) {
            const q = quadrants.find((q) => q.test(cell));
            if (q) q.plays += cell.plays;
        }
        const bare = quadrants.reduce((a, b) => (b.plays < a.plays ? b : a));
        const share = bare.plays / total;
        return share < 0.05 ? { name: bare.name, percent: Math.round(share * 100) } : null;
    }, [shape]);

    const movement = useMemo(() => {
        if (path.length < 3) return null;
        const first = path[0];
        const dE = latest.energy - first.energy;
        const dV = latest.valence - first.valence;
        const parts: string[] = [];
        if (Math.abs(dE) > 0.02) parts.push(dE > 0 ? "higher energy" : "lower energy");
        if (Math.abs(dV) > 0.02) parts.push(dV > 0 ? "brighter" : "darker");
        if (parts.length === 0) return `no change since ${monthLong(first.month)}`;
        return `since ${monthLong(first.month)}: ${parts.join(", ")}`;
    }, [path, latest]);

    if (cloud.length === 0) {
        return (
            <p className="t-body max-w-[46ch]">
                needs audio analysis
            </p>
        );
    }

    return (
        <figure
            ref={ref}
            className="m-0 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-3 gap-y-2"
        >
            <>
                <div className="flex flex-col justify-between items-end text-right leading-tight t-label py-0.5">
                    <span>high energy</span>
                    <span>low energy</span>
                </div>

                <svg
                    viewBox="0 0 100 100"
                    className="w-full aspect-square touch-none"
                    onPointerMove={onMove}
                    onPointerLeave={() => setProbe(null)}
                    role="img"
                    aria-label={
                        overall
                            ? `average: ${energyWord(overall.energy)}, ${brightness(overall.valence)}`
                            : "brightness and energy plot"
                    }
                >
                    <g stroke="var(--chart-ink-empty)" strokeWidth="0.3">
                        {[25, 50, 75].map((v) => (
                            <line key={`v${v}`} x1={v} y1="0" x2={v} y2="100" />
                        ))}
                        {[25, 50, 75].map((h) => (
                            <line key={`h${h}`} x1="0" y1={h} x2="100" y2={h} />
                        ))}
                    </g>
                    <rect
                        x="0" y="0" width="100" height="100"
                        fill="none" stroke="var(--chart-ink-rule)" strokeWidth="0.3"
                    />

                    <g>
                        {cloud.map((d) => (
                            <circle
                                key={d.key}
                                cx={d.cx} cy={d.cy} r={d.r}
                                fill="var(--color-brand)"
                                opacity={shown ? d.opacity : 0}
                                style={{
                                    transition: "opacity 520ms cubic-bezier(0.25,1,0.5,1)",
                                    // Densest cells first: the shape resolves out
                                    // of its own centre rather than all at once.
                                    transitionDelay: `${Math.round((1 - d.r / MAX_DOT_RADIUS) * 420)}ms`,
                                }}
                            />
                        ))}
                    </g>

                    {probe && (
                        <rect
                            x={cellCentre(probe.x - 1) - (100 - PAD * 2) / BUCKETS / 2}
                            y={100 - cellCentre(probe.y + 1) - (100 - PAD * 2) / BUCKETS / 2}
                            width={(3 * (100 - PAD * 2)) / BUCKETS}
                            height={(3 * (100 - PAD * 2)) / BUCKETS}
                            fill="none"
                            stroke="rgba(255,255,255,0.55)"
                            strokeWidth="0.4"
                            rx="1"
                            pointerEvents="none"
                        />
                    )}

                    {path.length > 1 && (
                        <g>
                            {/* Months as unconnected points, bigger where you listened
                                more and brighter toward now: joined, they tangle. */}
                            {path.map((p, i) => {
                                const age = i / Math.max(1, path.length - 1);
                                const weight = Math.sqrt(p.plays / maxMonth);
                                return i === active ? null : (
                                    <g key={`m-${p.month}`}>
                                        <circle
                                            cx={p.x} cy={p.y} r={1 + weight * 1.6}
                                            fill="none" stroke="#0a0a0a" strokeWidth="1.6"
                                            opacity={shown ? 0.85 : 0}
                                            style={{
                                                transition: "opacity 260ms ease-out",
                                                transitionDelay: `${560 + i * 80}ms`,
                                            }}
                                        />
                                        <circle
                                            cx={p.x} cy={p.y} r={1 + weight * 1.6}
                                            fill="#f5f5f5"
                                            opacity={shown ? 0.2 + 0.62 * age : 0}
                                            style={{
                                                transition: "opacity 260ms ease-out",
                                                transitionDelay: `${560 + i * 80}ms`,
                                            }}
                                        />
                                    </g>
                                );
                            })}

                            {/* Where you are now, or the month under the pointer. */}
                            <g
                                style={{
                                    transform: `translate(${here.x}px, ${here.y}px) scale(${shown ? 1 : 0})`,
                                    transformOrigin: `${here.x}px ${here.y}px`,
                                    transition: "transform 320ms cubic-bezier(0.25,1,0.5,1)",
                                    transitionDelay: shown ? `${560 + path.length * 80}ms` : "0ms",
                                }}
                            >
                                <circle r="3" fill="none" stroke="#0a0a0a" strokeWidth="2.4" />
                                <circle r="3" fill="none" stroke="#ffffff" strokeWidth="1" />
                                <circle r="1" fill="#ffffff" />
                            </g>
                        </g>
                    )}
                </svg>

                <div />
                <div className="flex justify-between t-label">
                    <span>dark</span>
                    <span>bright</span>
                </div>
            </>

            {path.length > 2 && (
                <>
                    <span
                        className="t-label text-right self-end pb-1 mt-4"
                        onMouseLeave={() => setAt(null)}
                    >
                        plays per month
                    </span>
                    <div
                        className="flex items-end gap-[3px] h-12 mt-4"
                        onMouseLeave={() => setAt(null)}
                    >
                        {path.map((p, i) => (
                            <button
                                key={p.month}
                                type="button"
                                onMouseEnter={() => setAt(i)}
                                onFocus={() => setAt(i)}
                                onClick={() => setAt(i)}
                                aria-label={`${monthLabel(p.month)}, ${plays(p.plays)}`}
                                className="flex-1 flex items-end h-full rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                                title={`${monthLabel(p.month)}: ${plays(p.plays)}`.toLowerCase()}
                            >
                                <span
                                    className="block w-full transition-colors duration-150"
                                    style={{
                                        height: `${Math.max(6, (p.plays / maxMonth) * 100)}%`,
                                        background:
                                            i === active
                                                ? "#f5f5f5"
                                                : "color-mix(in oklab, var(--color-brand) 45%, transparent)",
                                    }}
                                />
                            </button>
                        ))}
                    </div>
                </>
            )}

            {/* The plot is a single image to assistive technology, which means a
                summary sentence was the whole of it. The same figures as a table
                give a screen reader the evidence rather than only the verdict. */}
            {/* Tailwind v4's sr-only keeps the box's natural width (517px here),
                so the table is pinned to one pixel to never widen the page. */}
            <div className="absolute w-px h-px overflow-hidden [clip-path:inset(50%)] whitespace-nowrap border-0 p-0 -m-px">
            <table>
                <caption>plays by month: brightness, energy, bpm</caption>
                <thead>
                    <tr>
                        <th scope="col">month</th>
                        <th scope="col">brightness (0–100)</th>
                        <th scope="col">energy (0–100)</th>
                        <th scope="col">bpm</th>
                        <th scope="col">plays</th>
                    </tr>
                </thead>
                <tbody>
                    {path.map((m) => (
                        <tr key={`row-${m.month}`}>
                            <th scope="row">{monthLong(m.month)}</th>
                            <td>{Math.round(m.valence * 100)}</td>
                            <td>{Math.round(m.energy * 100)}</td>
                            <td>{m.bpm ? Math.round(m.bpm) : "unknown"}</td>
                            <td>{m.plays.toLocaleString()}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            </div>

            <span />
            {/* Reserved height, so walking the strip never nudges the page.
                In the grid's content column, so it starts at the plot's left
                edge rather than the figure's. */}
            <figcaption className="relative mt-4 h-[10rem] overflow-hidden">
                <div className="absolute inset-x-0 top-0 flex flex-col gap-2">
                {region && region.listens > 0 ? (
                    <>
                        <p className="text-[length:var(--stat-lead)] leading-snug font-light text-[var(--text-primary)] max-w-[30ch]">
                            {energyWord(region.energy ?? 0.5)}, {brightness(region.valence ?? 0.5)}
                        </p>
                        <p className="t-meta">
                            {plays(region.listens)} here
                            {region.bpm ? ` · avg ${Math.round(region.bpm)} bpm` : ""}
                        </p>
                        <ul className="flex flex-col gap-1 mt-1">
                            {region.tracks.map((t) => (
                                <li key={`${t.title}-${t.artist}`} className="flex items-baseline justify-between gap-4 max-w-[34ch]">
                                    <span className="min-w-0 truncate text-sm text-[var(--text-secondary)]">
                                        <span className="text-[var(--text-primary)]">{t.title}</span>
                                        {" · "}{t.artist}
                                    </span>
                                    <span className="t-meta shrink-0">{t.listens}</span>
                                </li>
                            ))}
                        </ul>
                    </>
                ) : (
                    <>
                        <p className="text-[length:var(--stat-lead)] leading-snug font-light text-[var(--text-primary)] max-w-[30ch]">
                            {at == null && overall
                                ? <>average: {energyWord(overall.energy)}, {brightness(overall.valence)}</>
                                : <>{monthLong(here.month)}: {energyWord(here.energy)}, {brightness(here.valence)}</>}
                        </p>
                        <p className="t-body max-w-[36ch]">
                            {at == null
                                ? movement
                                : `${plays(here.plays)}${here.bpm ? ` · avg ${Math.round(here.bpm)} bpm` : ""}`}
                        </p>
                        <p className="t-meta mt-1">
                            {at == null && barestCorner && (
                                <>
                                    least played: {barestCorner.name} ({barestCorner.percent}%)
                                    <span className="hidden sm:inline"> · </span>
                                    <br className="sm:hidden" />
                                </>
                            )}
                            <span className="hidden sm:inline">
                                hover to see tracks
                            </span>
                        </p>
                    </>
                )}
                </div>
            </figcaption>

        </figure>
    );
}
