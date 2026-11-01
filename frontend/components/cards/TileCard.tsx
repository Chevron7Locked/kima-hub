"use client";

import { memo, type CSSProperties, type ReactNode, type Ref } from "react";
import { Loader2 } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { cn } from "@/lib/cn";

interface TileCardProps {
    title: string;
    subtitle?: string;
    imageUrl?: string | null;
    /** Gradient classes for the tile when it has no image; unused when `background` is given. */
    tint?: string;
    hoverBorder: string;
    /** Gradient classes for the underline that grows on hover; no underline without it. */
    accent?: string;
    onClick: () => void;
    busy?: boolean;
    disabled?: boolean;
    buttonRef?: Ref<HTMLButtonElement>;
    /** Replaces the image and tint layers. */
    background?: ReactNode;
    /** Replace the default title size and the subtitle's colour. */
    titleClassName?: string;
    subtitleClassName?: string;
    /** Shown in place of the busy spinner while the tile is idle. */
    badge?: ReactNode;
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
    disabled = false,
    buttonRef,
    background,
    titleClassName,
    subtitleClassName,
    badge,
    index = 0,
    className,
}: TileCardProps) {
    return (
        <button
            ref={buttonRef}
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-busy={busy}
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
            {background ?? (imageUrl ? (
                <>
                    <CachedImage src={imageUrl} alt="" fill sizes="(max-width: 640px) 50vw, 20vw" className="object-cover cover-zoom" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                </>
            ) : (
                <div className={cn("absolute inset-0 bg-gradient-to-br cover-zoom", tint)} />
            ))}

            <div className="absolute inset-0 p-3 flex flex-col justify-end">
                <div>
                    <h3 className={cn(titleClassName ?? "text-sm", "font-bold text-white truncate tracking-tight leading-tight")}>{title}</h3>
                    {subtitle && (
                        <p className={cn("text-xs truncate", subtitleClassName ?? "text-[var(--text-muted)]")}>
                            {subtitle}
                        </p>
                    )}
                </div>
            </div>

            {accent && (
                <div
                    className={cn(
                        "absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r scale-x-0 group-hover:scale-x-100 transition-transform duration-150",
                        accent,
                    )}
                />
            )}

            {busy ? (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-(--z-raised)">
                    <Loader2 className="w-5 h-5 text-white animate-spin" />
                </div>
            ) : (
                badge
            )}
        </button>
    );
});
