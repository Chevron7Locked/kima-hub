"use client";

/**
 * Energy hour by hour as a curve, with plays per hour as a band beneath it so a
 * swing built on four listens is visibly thin. The axis is labelled in the
 * taste plot's own words rather than explained in a sentence.
 */

import { useMemo } from "react";
import { useInView } from "@/hooks/useInView";
import { hourLabel } from "../format";
import type { Signature } from "../types";

const W = 100, H = 34;

/** A smooth line through the points, using midpoints so it never overshoots. */
function smooth(points: Array<[number, number]>): string {
    if (points.length < 2) return "";
    let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
    for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1];
        const [x1, y1] = points[i];
        const mx = (x0 + x1) / 2;
        d += ` C ${mx.toFixed(2)} ${y0.toFixed(2)}, ${mx.toFixed(2)} ${y1.toFixed(2)}, ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    }
    return d;
}

export function EnergyCurve({ hourly }: { hourly: Signature["hourly"] }) {
    const { ref, shown } = useInView<HTMLElement>({ threshold: 0.35 });

    const { line, band, peak, trough } = useMemo(() => {
        const byHour = new Map(hourly.map((h) => [h.hour, h]));
        const rows = Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? { hour, plays: 0, energy: 0 });
        const withPlays = rows.filter((r) => r.plays > 0);
        if (withPlays.length < 3) return { line: "", band: "", peak: null, trough: null };

        const lo = Math.min(...withPlays.map((r) => r.energy));
        const hi = Math.max(...withPlays.map((r) => r.energy));
        // Floor the span so a steady day is not stretched into a dramatic one,
        // and centre the real range inside it so a flat line sits mid-plot.
        const range = hi - lo;
        const span = Math.max(0.08, range);
        const base = lo - (span - range) / 2;
        const maxPlays = Math.max(...rows.map((r) => r.plays));

        // Hours with nothing played carry the previous reading rather than
        // dropping to zero, which would draw a cliff that never happened.
        let last = withPlays[0].energy;
        const pts: Array<[number, number]> = rows.map((r) => {
            if (r.plays > 0) last = r.energy;
            const x = (r.hour / 23) * W;
            const y = H - ((last - base) / span) * (H - 4) - 2;
            return [x, y];
        });

        const bandPts = rows.map((r) => {
            const x = (r.hour / 23) * W;
            const h = (r.plays / maxPlays) * 11;
            return `${x.toFixed(2)},${(H + 11 - h).toFixed(2)}`;
        });

        return {
            line: smooth(pts),
            band: `M 0 ${H + 11} L ${bandPts.join(" L ")} L ${W} ${H + 11} Z`,
            peak: withPlays.reduce((a, b) => (b.energy > a.energy ? b : a)),
            trough: withPlays.reduce((a, b) => (b.energy < a.energy ? b : a)),
        };
    }, [hourly]);

    if (!line) return null;

    return (
        // Capped so it pairs with the key wheel beside it: the viewBox is roughly two-to-one, so
        // uncapped on a phone it stands 280 px tall against the wheel's 304 px width.
        <figure
            ref={ref}
            className="m-0 grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 max-w-[34rem] xl:max-w-[44rem]"
        >
            {/* The axis, named down the left edge. */}
            <div className="flex flex-col items-end t-label">
                <div className="flex-[34] flex w-full flex-col items-end justify-between py-0.5">
                    <span>high</span>
                    <span>low</span>
                </div>
                <div className="flex-[12] flex w-full items-center justify-end">
                    <span>plays</span>
                </div>
            </div>

            <svg viewBox={`0 0 ${W} ${H + 12}`} className="w-full" role="img"
                 aria-label={`highest energy around ${hourLabel(peak!.hour)}, lowest around ${hourLabel(trough!.hour)}`}>
                <path d={band} fill="var(--chart-ink-band)" />
                <path
                    d={line}
                    fill="none"
                    stroke="var(--color-brand)"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                    pathLength={1}
                    style={{
                        strokeDasharray: 1,
                        strokeDashoffset: shown ? 0 : 1,
                        transition: "stroke-dashoffset 1100ms cubic-bezier(0.32,0.72,0,1)",
                    }}
                />
            </svg>

            <span aria-hidden />
            <div className="flex justify-between t-meta">
                <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span>
            </div>
        </figure>
    );
}
