"use client";

import { memo, type CSSProperties } from "react";
import { Loader2 } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { cn } from "@/lib/cn";

interface TileCardProps {
    title: string;
    subtitle?: string;
    imageUrl?: string | null;
    tint: string;
    hoverBorder: string;
    accent: string;
    onClick: () => void;
    busy?: boolean;
    index?: number;
    className?: string;
}

export const TileCard = memo(function TileCard({
    title,
    subtitle,
    imageUrl,
    tint,
    hoverBorder,
    accent,
    onClick,
    busy = false,
    index = 0,
    className,
}: TileCardProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            data-tv-card
            data-tv-card-index={index}
            style={{ "--i": index } as CSSProperties}
            className={cn(
                "relative group overflow-hidden text-left bg-[var(--bg-primary)] border border-white/10 rounded-lg transition-[border-color] duration-150",
                "animate-rise [animation-delay:calc(var(--i)*var(--stagger))]",
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

            <div className="absolute inset-0 p-3 flex flex-col justify-end">
                <div>
                    <h3 className="text-sm font-bold text-white truncate tracking-tight leading-tight">{title}</h3>
                    {subtitle && (
                        <p className="text-xs text-[var(--text-muted)] truncate">
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
        </button>
    );
});
