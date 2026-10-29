"use client";

import { Loader2, Pause, Play, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The players' round play button: play or pause, a spinner while buffering, and retry after a playback error.
 * `md` is the bar players' size, `lg` the full-screen player's; `glow` adds the desktop bar's hover halo.
 */
export function PlayPauseButton({
    isPlaying,
    isBuffering,
    audioError,
    onPlay,
    onPause,
    size = "md",
    disabled = false,
    glow = false,
}: {
    isPlaying: boolean;
    isBuffering: boolean;
    audioError: unknown;
    onPlay: () => void;
    onPause: () => void;
    size?: "md" | "lg";
    disabled?: boolean;
    glow?: boolean;
}) {
    // Screen readers and the release walkthrough name it with a capital; the tooltip is lowercase like all UI text.
    const label = audioError ? "Retry playback" : isBuffering ? "Buffering..." : isPlaying ? "Pause" : "Play";
    const icon = size === "lg" ? "w-7 h-7" : "w-5 h-5";
    const iconClass = cn(icon, "relative z-(--z-raised)");
    return (
        <button
            type="button"
            onClick={isPlaying ? onPause : onPlay}
            disabled={disabled}
            aria-label={label}
            title={label.toLowerCase()}
            className={cn(
                "group relative flex shrink-0 items-center justify-center rounded-full transition-all duration-200",
                size === "lg" ? "w-16 h-16" : "w-10 h-10",
                disabled
                    ? "bg-gray-700 text-[var(--text-muted)] cursor-not-allowed"
                    : audioError
                    ? "bg-danger text-white hover:bg-danger-light"
                    : isBuffering
                    ? "bg-brand/80 text-black"
                    : "bg-brand text-black",
                !disabled && (glow ? "hover:scale-110" : "hover:scale-105"),
            )}
        >
            {glow && !disabled && !isBuffering && !audioError && (
                <span className="absolute inset-0 rounded-full bg-brand blur-md opacity-0 group-hover:opacity-50 transition-opacity duration-200" />
            )}
            {audioError ? (
                <RefreshCw className={iconClass} />
            ) : isBuffering ? (
                <Loader2 className={cn(iconClass, "animate-spin")} />
            ) : isPlaying ? (
                <span className="animate-pop"><Pause className={iconClass} /></span>
            ) : (
                <span className="animate-pop"><Play className={cn(iconClass, size === "lg" ? "ml-1" : "ml-0.5")} /></span>
            )}
        </button>
    );
}
