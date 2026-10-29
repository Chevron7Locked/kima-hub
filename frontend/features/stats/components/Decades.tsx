"use client";

/**
 * The shelf as a timeline. Each decade is a disc sized by albums owned and
 * filled by albums opened.
 */

import type { ShelfStats } from "../types";
import { useInView } from "@/hooks/useInView";

export function Decades({ decades }: { decades: ShelfStats["decades"] }) {
    const { ref, shown } = useInView<HTMLElement>({ threshold: 0.35 });
    if (decades.length < 2) return null;

    const max = decades.reduce((m, d) => Math.max(m, d.albums), 0);
    if (max === 0) return null;

    const biggest = decades.reduce((a, b) => (b.albums > a.albums ? b : a));
    // Decades with fewer than three albums are not evidence of neglect. Reduce
    // over the filtered list without a seed so an excluded decade can never win.
    const judged = decades.filter((d) => d.albums >= 3);
    const coldest = judged.length
        ? judged.reduce((a, b) => (b.heard / b.albums < a.heard / a.albums ? b : a))
        : null;

    const W = 100;
    const gaps = Math.max(1, decades.length - 1);

    // Largest radius that cannot collide: solving 2R <= (W - 2R) / gaps, less a
    // little for daylight between neighbours.
    const maxR = Math.min(9.5, (W / (2 * (gaps + 1))) * 0.92);
    const minR = Math.min(2.6, maxR * 0.32);

    // Area carries the count. Interpolate between the two areas and take the
    // root, so the radius lands on minR at zero and maxR at the top while ink
    // stays proportional to albums.
    const radius = (albums: number) =>
        Math.sqrt(minR * minR + (albums / max) * (maxR * maxR - minR * minR));

    const H = maxR * 2 + 4;
    // Inset the ends by a full radius so the first and last are not clipped.
    const step = (W - maxR * 2) / gaps;
    const at = (i: number) => maxR + i * step;

    return (
        <figure ref={ref} className="m-0 grid items-center gap-x-12 gap-y-8 sm:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-2">
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
                     aria-label={`albums by decade · most from the ${String(biggest.decade).slice(2)}s`}>
                    <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="var(--chart-ink-rule)" strokeWidth="0.3" />
                    {decades.map((d, i) => {
                        const cx = at(i);
                        const r = radius(d.albums);
                        const heard = d.albums > 0 ? d.heard / d.albums : 0;
                        return (
                            <g key={d.decade}>
                                <circle
                                    cx={cx} cy={H / 2} r={r}
                                    /* The outline keeps a barely-heard disc visible. */
                                    fill="var(--chart-ink-empty)"
                                    stroke="var(--chart-ink-edge)" strokeWidth="0.4"
                                    style={{
                                        transform: `scale(${shown ? 1 : 0})`,
                                        transformOrigin: `${cx}px ${H / 2}px`,
                                        transition: "transform 560ms cubic-bezier(0.25,1,0.5,1)",
                                        transitionDelay: `${i * 70}ms`,
                                    }}
                                />
                                {/* The opened share fills from the bottom, so the
                                    disc reads as a vessel rather than a pie. */}
                                <clipPath id={`fill-${d.decade}`}>
                                    <rect x={cx - r} y={H / 2 + r - 2 * r * heard} width={2 * r} height={2 * r * heard} />
                                </clipPath>
                                <circle
                                    cx={cx} cy={H / 2} r={r}
                                    fill="var(--color-brand)"
                                    clipPath={`url(#fill-${d.decade})`}
                                    style={{
                                        transform: `scale(${shown ? 1 : 0})`,
                                        transformOrigin: `${cx}px ${H / 2}px`,
                                        transition: "transform 560ms cubic-bezier(0.25,1,0.5,1)",
                                        transitionDelay: `${i * 70 + 110}ms`,
                                    }}
                                />
                                <title>{`${d.decade}s: ${d.heard} of ${d.albums} ${d.albums === 1 ? "album" : "albums"} played`}</title>
                            </g>
                        );
                    })}
                </svg>
                {/* Labels sit under their own disc rather than spreading edge to
                    edge, which put them a full slot away from what they name. */}
                <div className="relative h-4">
                    {decades.map((d, i) => (
                        <span
                            key={d.decade}
                            className="absolute t-meta tabular-nums -translate-x-1/2"
                            style={{ left: `${at(i)}%` }}
                        >
                            {String(d.decade).slice(2)}
                        </span>
                    ))}
                </div>
            </div>

            <figcaption className="flex flex-col gap-2 max-w-[30ch]">
                <p className="t-body">
                    most albums:{" "}
                    <span className="t-figure text-sm">{String(biggest.decade).slice(2)}s</span>
                    {coldest && coldest.decade !== biggest.decade && (
                        <>
                            {" · least played: "}
                            <span className="t-figure text-sm">
                                {String(coldest.decade).slice(2)}s
                            </span>
                        </>
                    )}
                </p>
                <p className="t-meta">size = albums owned · fill = albums played</p>
            </figcaption>
        </figure>
    );
}
