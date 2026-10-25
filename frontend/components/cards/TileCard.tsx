"use client";

import { memo, type CSSProperties, type ReactNode } from "react";
import { Loader2, Play } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { cn } from "@/lib/cn";

interface TileCardProps {
    title: string;
    subtitle?: string;
    /** Let the subtitle take a second line instead of cutting it off, for tiles tall enough to hold it. */
    wrapSubtitle?: boolean;
    eyebrow?: ReactNode;
    imageUrl?: string | null;
    tint: string;
    hoverBorder: string;
    accent: string;
    onClick: () => void;
    playable?: boolean;
    busy?: boolean;
    disabled?: boolean;
    index?: number;
    className?: string;
}

export const TileCard = memo(function TileCard({
    title,
    subtitle,
    wrapSubtitle = false,
    eyebrow,
    imageUrl,
    tint,
    hoverBorder,
    accent,
    onClick,
    playable = false,
    busy = false,
    disabled = false,
    index = 0,
    className,
}: TileCardProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            data-tv-card
            data-tv-card-index={index}
            style={{ "--i": index } as CSSProperties}
            className={cn(
                "relative group overflow-hidden text-left bg-[var(--bg-primary)] border border-white/10 rounded-lg transition-[border-color] duration-150",
                "disabled:opacity-50 disabled:cursor-not-allowed animate-rise [animation-delay:calc(var(--i)*var(--stagger))]",
                hoverBorder,
                className,
            )}
        >
            {imageUrl ? (
                <>
                    <CachedImage src={imageUrl} alt="" fill sizes="(max-width: 640px) 50vw, 20vw" className="object-cover cover-zoom" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                </>
            ) : (
                <div className={cn("absolute inset-0 bg-gradient-to-br cover-zoom", tint)} />
            )}

            <div className="absolute inset-0 p-3 flex flex-col justify-between">
                <div>{eyebrow}</div>
                <div>
                    <h3 className="text-sm font-bold text-white truncate tracking-tight leading-tight">{title}</h3>
                    {subtitle && (
                        <p className={cn("text-xs text-[var(--text-muted)]", wrapSubtitle ? "line-clamp-2" : "truncate")}>
                            {subtitle}
                        </p>
                    )}
                </div>
            </div>

            <div
                className={cn(
                    "absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r scale-x-0 group-hover:scale-x-100 transition-transform duration-150",
                    accent,
                )}
            />

            {busy && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-(--z-raised)">
                    <Loader2 className="w-5 h-5 text-white animate-spin" />
                </div>
            )}

            {playable && !busy && (
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <div className="w-10 h-10 rounded-lg bg-white flex items-center justify-center">
                        <Play className="w-4 h-4 text-black ml-0.5" fill="currentColor" />
                    </div>
                </div>
            )}
        </button>
    );
});
