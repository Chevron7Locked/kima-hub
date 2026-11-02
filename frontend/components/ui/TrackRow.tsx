"use client";

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { Music, Play } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { CachedImage } from "@/components/ui/CachedImage";

/**
 * A numbered song row: its number (a play button on hover or focus, a pulsing note while it plays), its cover, title
 * over subtitle, the caller's own columns from the medium breakpoint up, then its actions and length. On a phone the
 * row is number, song, and actions. `columns` is the row's full grid class, so each list keeps its own widths.
 */
export function TrackRow({
    index,
    current,
    playing,
    onPlay,
    title,
    subtitle,
    coverUrl,
    titleBadge,
    columns,
    extras,
    actions,
    duration,
    className,
    style,
    rowProps,
    onDoubleClick,
    onTouchEnd,
}: {
    index: number;
    /** This row's song is the player's song. */
    current: boolean;
    /** The player is playing it right now (not paused). */
    playing: boolean;
    onPlay: () => void;
    title: string;
    subtitle: string;
    coverUrl: string | null;
    titleBadge?: ReactNode;
    /** The grid template, e.g. "grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px]". */
    columns: string;
    /** Cells between the song and the actions; shown from the medium breakpoint up. */
    extras?: ReactNode[];
    actions?: ReactNode;
    duration?: number | null;
    className?: string;
    style?: CSSProperties;
    rowProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, unknown>;
    onDoubleClick?: () => void;
    onTouchEnd?: (event: React.TouchEvent<HTMLDivElement>) => void;
}) {
    const showsPause = current && playing;
    return (
        <div
            {...rowProps}
            onDoubleClick={onDoubleClick}
            onTouchEnd={onTouchEnd}
            style={style}
            className={cn(
                "grid gap-4 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer touch-manipulation",
                columns,
                current && "bg-white/10",
                className,
            )}
        >
            <div className="flex items-center justify-center">
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onPlay();
                    }}
                    className="group/play min-h-[44px] min-w-[44px] flex items-center justify-center"
                    aria-label={showsPause ? `Pause ${title}` : `Play ${title}`}
                >
                    <span
                        className={cn(
                            // Only a screen that can hover swaps the number for a play icon; a tap would leave it stuck.
                            "text-sm can-hover:group-hover:hidden group-focus-visible/play:hidden",
                            current ? "text-brand" : "text-[var(--text-secondary)]",
                        )}
                    >
                        {showsPause ? <Music className="w-4 h-4 text-brand animate-pulse" /> : index + 1}
                    </span>
                    <Play className="w-4 h-4 text-white hidden can-hover:group-hover:block group-focus-visible/play:block" />
                </button>
            </div>

            <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                    {coverUrl ? (
                        <CachedImage src={coverUrl} alt={title} width={40} height={40} className="object-cover" />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center">
                            <Music className="w-5 h-5 text-[var(--text-muted)]" />
                        </div>
                    )}
                </div>
                <div className="min-w-0">
                    <div
                        className={cn(
                            "text-sm font-medium truncate flex items-center gap-2",
                            current ? "text-brand" : "text-white",
                        )}
                    >
                        <span className="truncate">{title}</span>
                        {titleBadge}
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] truncate">{subtitle}</p>
                </div>
            </div>

            {extras?.map((cell, i) => (
                <div key={i} className="hidden md:flex items-center min-w-0 text-sm text-[var(--text-secondary)]">
                    {cell}
                </div>
            ))}

            <div className="flex items-center justify-end gap-2">
                {actions}
                {duration ? (
                    <span className="text-sm text-[var(--text-secondary)] w-12 text-right tabular-nums">
                        {formatTime(duration)}
                    </span>
                ) : null}
            </div>
        </div>
    );
}
