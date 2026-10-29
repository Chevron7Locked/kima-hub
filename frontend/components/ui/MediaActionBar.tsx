"use client";

import { memo, type ReactNode } from "react";
import { Play, Pause, Shuffle } from "lucide-react";
import { cn } from "@/lib/cn";

interface MediaActionBarProps {
    /** The play disc hides when there is nothing to play (an unowned album). */
    showPlay?: boolean;
    showPause: boolean;
    onPlayPause: () => void;
    onShuffle?: () => void;
    /**
     * "square" (rounded-lg) is the deliberate branch from Spotify's circles
     * (Kevin's call); "circle" is the play disc.
     */
    discShape?: "circle" | "square";
    secondaryShape: "circle" | "square";
    /** Extra icon buttons and CTAs, in order, as MediaActionButton/CTA elements. */
    children?: ReactNode;
}

/** The brand play/pause disc; one place the disc shape and glyph live. */
export const PlayDisc = memo(function PlayDisc({
    showPause,
    onClick,
    shape,
    disabled,
    label,
}: {
    showPause: boolean;
    onClick: () => void;
    shape: "circle" | "square";
    disabled?: boolean;
    label?: string;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            aria-label={label ?? (showPause ? "pause" : "play all")}
            className={cn(
                "h-12 w-12 flex items-center justify-center transition-all hover:scale-105 active:scale-95 bg-brand disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100",
                shape === "circle" ? "rounded-full" : "rounded-lg",
            )}
        >
            {showPause ? (
                <Pause className="w-5 h-5 fill-current text-[var(--color-on-brand)]" />
            ) : (
                <Play className="w-5 h-5 fill-current text-[var(--color-on-brand)] ml-0.5" />
            )}
        </button>
    );
});

/** The play disc + shuffle row under a hero. */
export const MediaActionBar = memo(function MediaActionBar({
    showPlay = true,
    showPause,
    onPlayPause,
    onShuffle,
    discShape = "circle",
    secondaryShape,
    children,
}: MediaActionBarProps) {
    return (
        <div className="flex items-center gap-4">
            {showPlay && (
                <PlayDisc showPause={showPause} onClick={onPlayPause} shape={discShape} />
            )}

            {showPlay && onShuffle && (
                <MediaActionButton
                    shape={secondaryShape}
                    icon={<Shuffle className="w-5 h-5" />}
                    label="shuffle play"
                    onClick={onShuffle}
                />
            )}

            {children}
        </div>
    );
});

interface MediaActionButtonProps {
    icon: ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    shape: "circle" | "square";
}

/** A secondary icon button beside the play disc. */
export const MediaActionButton = memo(function MediaActionButton({
    icon,
    label,
    onClick,
    disabled,
    shape,
}: MediaActionButtonProps) {
    return (
        <button
            onClick={onClick}
            title={label}
            aria-label={label}
            disabled={disabled}
            className={cn(
                "h-8 w-8 hover:bg-white/10 flex items-center justify-center text-[var(--text-secondary)] hover:text-white transition-all disabled:opacity-50",
                shape === "circle" ? "rounded-full" : "rounded-lg",
            )}
        >
            {icon}
        </button>
    );
});
