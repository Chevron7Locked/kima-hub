"use client";

import { memo, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { Loader2, type LucideIcon } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { cn } from "@/lib/cn";
import { MOOD_COLORS, moodLabel } from "@/features/vibe/mapUtils";

type MediaType = "artist" | "album" | "track" | "podcast" | "audiobook";

const TYPE_STYLES: Record<MediaType, { border: string; bar: string }> = {
    artist: { border: "hover:border-type-artist/50", bar: "bg-type-artist" },
    album: { border: "hover:border-type-album/50", bar: "bg-type-album" },
    track: { border: "hover:border-type-track/50", bar: "bg-type-track" },
    podcast: { border: "hover:border-type-podcast/50", bar: "bg-type-podcast" },
    audiobook: { border: "hover:border-type-audiobook/50", bar: "bg-type-audiobook" },
};

interface MediaCardAction {
    icon: LucideIcon;
    label: string;
    onClick: () => void;
    busy?: boolean;
}

interface MediaCardProps {
    href?: string;
    title: string;
    subtitle?: ReactNode;
    imageUrl?: string | string[] | null;
    fallbackIcon: LucideIcon;
    type: MediaType;
    aspect?: "square" | "portrait";
    index?: number;
    sizes?: string;
    badge?: ReactNode;
    corner?: ReactNode;
    progress?: number;
    action?: MediaCardAction;
    /** One of the five mood keys; marks the card's meta with a dot in its map colour. */
    moodKey?: string | null;
    className?: string;
}

function stop(handler: () => void) {
    return (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        handler();
    };
}

/**
 * A card's artwork: one cover, or for a list of covers (a mix, a playlist) each different cover once, the tile fitted
 * to how many there are: two side by side, three as one tall and two small, four in a 2x2 grid. The sidebar's mix
 * tiles and the mix and playlist pages draw the same one, so a mix looks the same wherever it is.
 */
export function CoverArt({
    imageUrl,
    title,
    sizes,
    FallbackIcon,
}: {
    imageUrl?: string | string[] | null;
    title: string;
    sizes: string;
    FallbackIcon: LucideIcon;
}) {
    // A cover that fails to load drops out and the tile refits; with none left, the icon. Remembered by address, so
    // another mix's covers start fresh.
    const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
    const fail = (url: string) => setFailed((prev) => new Set(prev).add(url));
    const urls = [
        ...new Set((Array.isArray(imageUrl) ? imageUrl : [imageUrl]).filter((url): url is string => !!url)),
    ]
        .filter((url) => !failed.has(url))
        .slice(0, 4);

    if (urls.length === 0) {
        return <FallbackIcon className="w-10 h-10 text-[var(--text-muted)]" />;
    }

    if (urls.length === 1) {
        return (
            <CachedImage
                key={urls[0]}
                src={urls[0]}
                alt={title}
                fill
                sizes={sizes}
                className="object-cover cover-zoom"
                onError={() => fail(urls[0])}
            />
        );
    }

    return (
        <div
            data-cover-count={urls.length}
            className={cn("grid grid-cols-2 w-full h-full cover-zoom", urls.length > 2 && "grid-rows-2")}
        >
            {urls.map((url, i) => (
                <div
                    key={url}
                    data-cover-cell
                    className={cn("relative bg-[#181818]", urls.length === 3 && i === 0 && "row-span-2")}
                >
                    <CachedImage
                        src={url}
                        alt=""
                        fill
                        sizes={urls.length === 2 || (urls.length === 3 && i === 0) ? sizes : "100px"}
                        className="object-cover"
                        onError={() => fail(url)}
                    />
                </div>
            ))}
        </div>
    );
}

export const MediaCard = memo(function MediaCard({
    href,
    title,
    subtitle,
    imageUrl,
    fallbackIcon,
    type,
    aspect = "square",
    index = 0,
    sizes = "(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 16vw",
    badge,
    corner,
    progress,
    action,
    moodKey,
    className,
}: MediaCardProps) {
    const styles = TYPE_STYLES[type];
    const ActionIcon = action?.busy ? Loader2 : action?.icon;
    const moodColour = moodKey && moodKey !== "unanalyzed" ? MOOD_COLORS[moodKey] ?? null : null;

    const body = (
        <div className="relative">
            {/* Bare artwork: a rounded square with a hairline edge and soft elevation, no panel. */}
            <div
                className={cn(
                    "relative w-full h-full bg-[#181818] flex items-center justify-center overflow-hidden",
                    "rounded-lg ring-1 ring-white/10 shadow-[0_8px_24px_rgba(0,0,0,0.35)]",
                    aspect === "portrait" ? "aspect-[2/3]" : "aspect-square",
                )}
            >
                <CoverArt key={String(imageUrl)} imageUrl={imageUrl} title={title} sizes={sizes} FallbackIcon={fallbackIcon} />

                {badge && <div className="absolute top-2 left-2">{badge}</div>}
                {corner && <div className="absolute top-2 right-2">{corner}</div>}

                {progress !== undefined && progress > 0 && (
                    <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
                        <div className="h-full bg-brand" style={{ width: `${Math.min(progress, 100)}%` }} />
                    </div>
                )}

                {action && ActionIcon && (
                    <>
                        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none" />
                        <button
                            type="button"
                            onClick={stop(action.onClick)}
                            disabled={action.busy}
                            aria-label={`${action.label} ${title}`}
                            title={action.label.toLowerCase()}
                            className={cn(
                                "absolute bottom-3 right-3 w-11 h-11 rounded-full border border-white/15 bg-black/55 backdrop-blur-[2px]",
                                "flex items-center justify-center transition-[transform,background-color] duration-150",
                                "hover:bg-black/75 hover:scale-105 active:scale-95",
                            )}
                        >
                            <ActionIcon
                                className={cn("w-5 h-5 text-white", action.busy ? "animate-spin" : "fill-current ml-0.5")}
                            />
                        </button>
                    </>
                )}
            </div>

            <div className={cn("h-0.5 mt-1 scale-x-0 group-hover:scale-x-100 transition-transform duration-150", styles.bar)} />

            <div className="pt-1.5 px-0.5">
                <h3 className="text-sm font-bold text-white truncate tracking-tight" title={title.toLowerCase()}>
                    {title}
                </h3>
                {subtitle && (
                    <p className="flex items-center gap-1.5 text-xs tabular-nums text-[var(--text-muted)] mt-0.5">
                        {moodColour && (
                            <span
                                role="img"
                                aria-label={moodLabel(moodKey!).toLowerCase()}
                                title={moodLabel(moodKey!).toLowerCase()}
                                className="size-1.5 shrink-0 rounded-full"
                                style={{ background: `rgb(${moodColour[0]} ${moodColour[1]} ${moodColour[2]})` }}
                            />
                        )}
                        <span className="truncate">{subtitle}</span>
                    </p>
                )}
            </div>
        </div>
    );

    const rootProps = {
        "data-tv-card": true,
        "data-tv-card-index": index,
        style: { "--i": index } as CSSProperties,
        className: cn("group block animate-rise [animation-delay:calc(var(--i)*var(--stagger))]", className),
    };

    return href ? (
        <Link href={href} {...rootProps}>
            {body}
        </Link>
    ) : (
        <div tabIndex={0} {...rootProps}>
            {body}
        </div>
    );
});
