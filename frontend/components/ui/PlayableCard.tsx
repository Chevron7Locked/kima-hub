"use client";

import { ReactNode, memo, useMemo } from "react";
import Link from "next/link";
import { Play, Pause, Check, Download } from "lucide-react";
import { Card, CardProps } from "./Card";
import { cn } from "@/utils/cn";
import type { ColorPalette } from "@/hooks/useImageColor";
import { CachedImage } from "./CachedImage";

// Kima brand yellow for all on-page play buttons
const KIMA_YELLOW = "#ecb200";

export interface PlayableCardProps extends Omit<CardProps, "onPlay"> {
    href?: string;
    coverArt?: string | null;
    title: string;
    subtitle?: string;
    placeholderIcon?: ReactNode;
    isPlaying?: boolean;
    onPlay?: (e: React.MouseEvent) => void;
    onDownload?: (e: React.MouseEvent) => void;
    showPlayButton?: boolean;
    circular?: boolean;
    badge?: "owned" | "download" | null;
    isDownloading?: boolean;
    colors?: ColorPalette | null;
    tvCardIndex?: number;
}

const PlayableCard = memo(function PlayableCard({
    href,
    coverArt,
    title,
    subtitle,
    placeholderIcon,
    isPlaying = false,
    onPlay,
    onDownload,
    showPlayButton = true,
    circular = false,
    badge = null,
    isDownloading = false,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    colors = null,
    className,
    variant = "default",
    tvCardIndex,
    ...props
}: PlayableCardProps) {
    // Memoize the image source to prevent unnecessary re-renders
    const memoizedCoverArt = useMemo(() => coverArt, [coverArt]);
    // Handle Link click to prevent navigation when clicking on interactive elements
    const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
        const target = e.target as HTMLElement;
        if (target.closest("button")) {
            e.preventDefault();
        }
    };

    const cardContent = (
        <>
            {/* Image Container */}
            <div className="relative aspect-square mb-3">
                <div
                    className={cn(
                        "relative w-full h-full bg-[#282828] flex items-center justify-center overflow-hidden shadow-lg",
                        circular ? "rounded-full" : "rounded-md",
                    )}
                    style={{ contain: "content" }}
                >
                    {memoizedCoverArt ?
                        <CachedImage
                            src={memoizedCoverArt}
                            alt={title}
                            fill
                            className="object-cover group-hover:scale-105 transition-transform"
                            loading="lazy"
                            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, 16vw"
                        />
                    :   placeholderIcon || (
                            <div className="w-12 h-12 bg-[#3e3e3e] rounded-full" />
                        )
                    }
                    {showPlayButton && onPlay && (
                        <div className="absolute inset-0 bg-gradient-to-b from-black/0 to-black/30 opacity-0 group-hover:opacity-100 pointer-events-none" />
                    )}
                </div>

                {/* Play Button */}
                {showPlayButton && onPlay && (
                    <button
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onPlay(e);
                        }}
                        style={{ backgroundColor: KIMA_YELLOW }}
                        className={cn(
                            "absolute bottom-2 right-2 w-10 h-10 rounded-full flex items-center justify-center",
                            "shadow-xl shadow-black/50",
                            isPlaying
                                ? "opacity-100"
                                : "opacity-0 group-hover:opacity-100",
                        )}
                    >
                        {isPlaying ?
                            <Pause className="w-4 h-4 fill-current text-black" />
                        :   <Play className="w-4 h-4 fill-current ml-0.5 text-black" />
                        }
                    </button>
                )}
            </div>

            {/* Badge */}
            {badge && (
                <div className="mb-1.5">
                    {badge === "owned" && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/20 border border-green-500/30 rounded-full text-xs font-medium text-green-400">
                            <Check className="w-3 h-3" />
                            Owned
                        </span>
                    )}
                    {badge === "download" && (
                        <button
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                e.nativeEvent.stopImmediatePropagation();
                                if (!isDownloading && onDownload) {
                                    onDownload(e);
                                }
                            }}
                            onMouseDown={(e) => {
                                e.stopPropagation();
                            }}
                            disabled={isDownloading}
                            className={cn(
                                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors",
                                isDownloading ?
                                    "bg-gray-500/20 border border-gray-500/30 text-gray-500 cursor-not-allowed"
                                :   "bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/30 hover:border-yellow-500/50 text-yellow-400 hover:text-yellow-300",
                            )}
                            title={
                                isDownloading ? "Downloading..." : (
                                    "Download Album"
                                )
                            }
                        >
                            <Download
                                className={cn(
                                    "w-3 h-3",
                                    isDownloading && "animate-pulse",
                                )}
                            />
                            {isDownloading ? "Downloading..." : "Download"}
                        </button>
                    )}
                </div>
            )}

            {/* Title and Subtitle */}
            <h3 className="text-sm font-semibold text-white truncate">
                {title}
            </h3>
            {subtitle && (
                <p className="text-xs text-gray-400 truncate mt-0.5">
                    {subtitle}
                </p>
            )}
        </>
    );

    const cardClassName = cn("group cursor-pointer", className);

    // TV navigation attributes
    const tvNavProps =
        tvCardIndex !== undefined ?
            {
                "data-tv-card": true,
                "data-tv-card-index": tvCardIndex,
                tabIndex: 0,
            }
        :   {};

    if (href) {
        return (
            <Link href={href} onClick={handleLinkClick} {...tvNavProps}>
                <Card variant={variant} className={cardClassName} {...props}>
                    {cardContent}
                </Card>
            </Link>
        );
    }

    return (
        <Card
            variant={variant}
            className={cardClassName}
            {...tvNavProps}
            {...props}
        >
            {cardContent}
        </Card>
    );
});

export { PlayableCard };
