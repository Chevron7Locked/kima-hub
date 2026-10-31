"use client";

import { memo, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { CachedImage } from "@/components/ui/CachedImage";
import { useInView } from "@/hooks/useInView";
import { RadioStation, stationCover, stationHue, stationParams } from "../radioData";

/** Songs asked for to find a station's cover: a few, in case the first have none. */
const COVER_SAMPLE = 5;

/** Cover requests in flight at once, so scrolling past a long page of stations does not ask for all of them together. */
const MAX_COVER_REQUESTS = 4;
let inFlight = 0;
const waiting: (() => void)[] = [];

/** Runs `work` once a place is free. A finished request hands its place straight to the longest waiting one. */
export async function oneAtATurn<T>(work: () => Promise<T>): Promise<T> {
    if (inFlight < MAX_COVER_REQUESTS) inFlight++;
    else await new Promise<void>((go) => waiting.push(go));
    try {
        return await work();
    } finally {
        const next = waiting.shift();
        if (next) next();
        else inFlight--;
    }
}

/** The cover of a song this station would play, asked for once the tile is near the screen and kept for half an hour. */
function useStationCover(station: RadioStation, enabled: boolean) {
    return useQuery({
        queryKey: ["library", "radio", "cover", station.id],
        queryFn: async () => {
            const reply = await oneAtATurn(() =>
                api.get<{ tracks?: { album?: { coverArt?: string | null } | null }[] }>(
                    `/library/radio?${stationParams(station, COVER_SAMPLE)}`,
                ),
            );
            return stationCover(reply.tracks ?? []);
        },
        enabled,
        staleTime: 30 * 60 * 1000,
        retry: false,
    });
}

interface StationCardProps {
    station: RadioStation;
    onStart: (station: RadioStation) => void;
    busy?: boolean;
    disabled?: boolean;
    index?: number;
    className?: string;
}

/**
 * A radio station: the cover of a song it plays, washed in the station's colour, with its name and line over the
 * bottom. Until a cover arrives, or when the station has none, the tile is a fade of its colour.
 */
export const StationCard = memo(function StationCard({ station, onStart, busy = false, disabled = false, index = 0, className }: StationCardProps) {
    const { ref, shown } = useInView<HTMLButtonElement>({ withinMain: true, rootMargin: "200px", threshold: 0 });
    const { data: cover } = useStationCover(station, shown);
    const hue = stationHue(station);

    return (
        <button
            ref={ref}
            type="button"
            onClick={() => onStart(station)}
            disabled={disabled}
            aria-busy={busy}
            data-tv-card
            data-tv-card-index={index}
            style={{ "--i": index } as CSSProperties}
            className={cn(
                "relative group overflow-hidden text-left bg-[var(--bg-primary)] border border-white/10 rounded-lg transition-[border-color] duration-150",
                "disabled:opacity-50 disabled:cursor-not-allowed animate-rise [animation-delay:calc(var(--i)*var(--stagger))]",
                station.hoverBorder,
                className,
            )}
        >
            <div aria-hidden="true" className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${hue}8c, ${hue}1a)` }} />
            {cover && (
                <>
                    <CachedImage src={api.getCoverArtUrl(cover, 300)} alt="" fill sizes="(max-width: 640px) 50vw, 200px" className="object-cover cover-zoom" />
                    {/* The cover takes on the station's colour. */}
                    <div aria-hidden="true" className="absolute inset-0 mix-blend-color" style={{ background: hue }} />
                </>
            )}
            {/* Dark toward the bottom, so the name and line read on any cover. */}
            <div
                aria-hidden="true"
                className="absolute inset-0"
                style={{ background: `linear-gradient(to top, rgb(0 0 0 / 0.9), rgb(0 0 0 / 0.4) 70%), linear-gradient(135deg, ${hue}40, transparent 60%)` }}
            />

            <div className="absolute inset-x-0 bottom-0 p-3">
                <h3 className="text-base font-bold text-white truncate tracking-tight leading-tight">{station.name}</h3>
                <p className="text-xs text-white/75 truncate">{station.description}</p>
            </div>

            {busy ? (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-(--z-raised)">
                    <Loader2 className="w-5 h-5 text-white animate-spin" />
                </div>
            ) : (
                <div className="absolute top-3 left-3 z-(--z-raised) w-8 h-8 rounded-full bg-brand flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:hidden transition-opacity">
                    <Play className="w-3.5 h-3.5 text-black ml-0.5" fill="currentColor" />
                </div>
            )}
        </button>
    );
});
