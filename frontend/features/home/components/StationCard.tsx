"use client";

import { memo } from "react";
import { Play } from "lucide-react";
import { api } from "@/lib/api";
import { TileCard } from "@/components/cards/TileCard";
import { CachedImage } from "@/components/ui/CachedImage";
import { RadioStation, stationHue } from "../radioData";

interface StationCardProps {
    station: RadioStation;
    /** The cover the server picked for today; none until the page's request answers, or when the station has none. */
    cover?: string | null;
    onStart: (station: RadioStation) => void;
    busy?: boolean;
    disabled?: boolean;
    index?: number;
    className?: string;
}

/**
 * A radio station: the cover of a song it plays, washed in the station's colour, with its name and line over the
 * bottom. Until a cover arrives, or when the station has none, the tile is a fade of its colour. The cover loads at once:
 * it arrives after the tile is already on screen, and Chrome held such lazy images up to 3 s before fetching them.
 */
export const StationCard = memo(function StationCard({ station, cover, onStart, busy = false, disabled = false, index = 0, className }: StationCardProps) {
    const hue = stationHue(station);

    return (
        <TileCard
            title={station.name}
            subtitle={station.description}
            hoverBorder={station.hoverBorder}
            onClick={() => onStart(station)}
            busy={busy}
            disabled={disabled}
            index={index}
            className={className}
            titleClassName="text-base"
            subtitleClassName="text-white/75"
            background={
                <>
                    <div aria-hidden="true" className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${hue}8c, ${hue}1a)` }} />
                    {cover && (
                        <>
                            <CachedImage src={api.getCoverArtUrl(cover, 300)} alt="" fill sizes="(max-width: 640px) 50vw, 200px" loading="eager" className="object-cover cover-zoom" />
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
                </>
            }
            badge={
                <div className="absolute top-3 left-3 z-(--z-raised) w-8 h-8 rounded-full bg-brand flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-disabled:hidden transition-opacity">
                    <Play className="w-3.5 h-3.5 text-black ml-0.5" fill="currentColor" />
                </div>
            }
        />
    );
});
