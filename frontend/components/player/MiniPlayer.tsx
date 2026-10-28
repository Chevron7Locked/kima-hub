"use client";

import { usePlayerControls } from "@/hooks/usePlayerControls";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import {
    Play,
    Pause,
    Music as MusicIcon,
    Loader2,
    ChevronLeft,
    AlertTriangle,
    RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useState, useRef } from "react";
import { VibeToggleButton } from "./VibeToggleButton";
import { CachedImage } from "@/components/ui/CachedImage";

export function MiniPlayer() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isPlaying,
        isBuffering,
        audioError,
        progress,
        pause,
        resumeWithGesture,
        setPlayerMode,
    } = usePlayerControls();
    const [isMinimized, setIsMinimized] = useState(false);
    const [isDismissed, setIsDismissed] = useState(false);
    const [swipeOffset, setSwipeOffset] = useState(0);
    const touchStartX = useRef<number | null>(null);
    const [lastMediaId, setLastMediaId] = useState<string | null>(null);

    const currentMediaId =
        currentTrack?.id || currentAudiobook?.id || currentPodcast?.id;

    // Reset dismissed/minimized on media change or resume (render-time derived state)
    if (currentMediaId && currentMediaId !== lastMediaId) {
        setLastMediaId(currentMediaId);
        if (isDismissed) setIsDismissed(false);
        if (isMinimized) setIsMinimized(false);
    } else if (currentMediaId && isDismissed && isPlaying) {
        setIsDismissed(false);
    }

    const { title, subtitle, coverUrl, hasMedia } = useMediaInfo(100);

    // Check if controls should be enabled (only for tracks)
    const canSkip = playbackType === "track";

    if (!hasMedia) return null;

    // Handle swipe gestures:
    // - Swipe RIGHT: minimize to tab
    // - Swipe LEFT + playing: open overlay
    // - Swipe LEFT + not playing: dismiss completely
    const handleTouchStart = (e: React.TouchEvent) => {
        touchStartX.current = e.touches[0].clientX;
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (touchStartX.current === null) return;
        const deltaX = e.touches[0].clientX - touchStartX.current;
        // Track both directions, cap at ±150px
        setSwipeOffset(Math.max(-150, Math.min(150, deltaX)));
    };

    const handleTouchEnd = () => {
        if (touchStartX.current === null) return;

        // Swipe RIGHT (positive) → minimize to tab
        if (swipeOffset > 80) {
            setIsMinimized(true);
        }
        // Swipe LEFT (negative) → open overlay OR dismiss
        else if (swipeOffset < -80) {
            if (isPlaying) {
                // If playing, open full-screen overlay
                setPlayerMode("overlay");
            } else {
                // If not playing, dismiss completely
                setIsDismissed(true);
            }
        }

        setSwipeOffset(0);
        touchStartX.current = null;
    };

    if (isDismissed) {
        return null;
    }

    // Minimized tab - matches full player height, slides from right
    if (isMinimized) {
        return (
            <button
                onClick={() => setIsMinimized(false)}
                className="fixed right-0 z-(--z-player) transition-transform hover:scale-105 active:scale-95"
                style={{
                    bottom: "calc(var(--nav-h) + var(--standalone-safe-area-bottom, 0px) + 8px)",
                }}
                aria-label="Show player"
                title="show player"
            >
                <div
                    className="rounded-l-2xl p-[2px]"
                    style={{
                        background: "linear-gradient(90deg, #fca200 0%, #d48c00 100%)",
                    }}
                >
                    <div className="rounded-l-xl overflow-hidden">
                        <div className="relative bg-gradient-to-r from-[#1a1508] via-[#1a1200] to-[#1a1508]">
                            <div className="absolute inset-0 bg-gradient-to-r from-brand/30 to-brand-dark/20" />

                            <div className="relative h-[2px] bg-white/20 w-full">
                                <div
                                    className="h-full bg-brand transition-all duration-150"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>

                            <div className="relative flex items-center gap-2 pl-3 pr-2 py-3">
                                <ChevronLeft className="w-4 h-4 text-white flex-shrink-0" />
                                {coverUrl ? (
                                    <div className="relative w-12 h-12 rounded-lg overflow-hidden">
                                        <CachedImage
                                            src={coverUrl}
                                            alt={title}
                                            fill
                                            sizes="48px"
                                            className="object-cover"
                                        />
                                    </div>
                                ) : (
                                    <div className="w-12 h-12 rounded-lg bg-black/30 flex items-center justify-center">
                                        <MusicIcon className="w-5 h-5 text-[var(--text-secondary)]" />
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </button>
        );
    }

    const swipeOpacity = 1 - Math.abs(swipeOffset) / 200;

    return (
        <div
            className="fixed left-2 right-2 z-(--z-player)"
            role="region"
            aria-label="now playing"
            style={{
                bottom: "calc(var(--nav-h) + var(--standalone-safe-area-bottom, 0px) + 8px)",
                transform: `translateX(${swipeOffset}px)`,
                opacity: swipeOpacity,
                transition:
                    swipeOffset === 0
                        ? "transform 0.25s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.25s cubic-bezier(0.25, 1, 0.5, 1)"
                        : "none",
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
        >
            {/* A raised neutral card with a hairline edge and a faint accent wash
                from the leading edge — the iOS mini player's shell. */}
            <div
                className="relative overflow-hidden rounded-[14px] border border-[rgba(255,240,214,0.08)] shadow-[0_5px_14px_rgba(0,0,0,0.5)]"
                style={{ background: "var(--bg-secondary)" }}
            >
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0"
                    style={{ background: "linear-gradient(90deg, rgba(252,162,0,0.10), transparent 55%)" }}
                />
                <div className="relative h-[2px] w-full bg-white/10">
                    <div
                        className="h-full bg-[var(--color-brand)] transition-all duration-150"
                        style={{ width: `${progress}%` }}
                    />
                </div>

                        {/* Player content - more spacious padding */}
                        <div
                            className="relative flex items-center gap-3 px-3 py-3 cursor-pointer landscape-short:py-1"
                            onClick={() => setPlayerMode("overlay")}
                        >
                            {/* Album Art - expand button for keyboard/AT users */}
                            <button
                                className="relative w-12 h-12 flex-shrink-0 rounded-[12px] overflow-hidden bg-black/30 shadow-[0_3px_6px_rgba(0,0,0,0.45)] landscape-short:w-10 landscape-short:h-10"
                                aria-label="Expand player"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setPlayerMode("overlay");
                                }}
                            >
                                {coverUrl ? (
                                    <CachedImage
                                        src={coverUrl}
                                        alt={title}
                                        fill
                                        sizes="48px"
                                        className="object-cover"
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <MusicIcon className="w-5 h-5 text-[var(--text-secondary)]" />
                                    </div>
                                )}
                            </button>

                            <div className="flex-1 min-w-0">
                                {audioError ? (
                                    <>
                                        <div className="flex items-center gap-1">
                                            <AlertTriangle className="w-3.5 h-3.5 text-danger-light flex-shrink-0" />
                                            <p className="text-danger-light text-sm font-medium truncate leading-tight">
                                                Playback Error
                                            </p>
                                        </div>
                                        <p className="text-danger-light/70 text-xs truncate leading-tight mt-0.5">
                                            Tap retry to reconnect
                                        </p>
                                    </>
                                ) : (
                                    <>
                                        <p data-player-title className="text-[15px] font-semibold text-[var(--text-primary)] truncate leading-tight">
                                            {title}
                                        </p>
                                        <p className="text-[13px] text-[var(--text-secondary)] truncate leading-tight mt-0.5">
                                            {subtitle}
                                        </p>
                                    </>
                                )}
                            </div>

                            {/* Controls - Vibe button (for music only) & Play/Pause */}
                            <div
                                className="flex items-center gap-1.5 flex-shrink-0"
                                onClick={(e) => e.stopPropagation()}
                                role="group"
                                aria-label="Playback controls"
                            >
                                <VibeToggleButton
                                    unavailable={!canSkip}
                                    hideWhenUnavailable
                                    className="w-10 h-10 flex items-center justify-center rounded-full transition-colors"
                                    iconClassName="w-5 h-5"
                                    idleClassName="text-[var(--text-primary)] hover:text-brand"
                                    activeClassName="text-brand"
                                />

                                <button
                                    onClick={() => {
                                        if (isPlaying) {
                                            pause();
                                        } else {
                                            resumeWithGesture();
                                        }
                                    }}
                                    className={cn(
                                        "w-10 h-10 rounded-full flex items-center justify-center transition",
                                        audioError
                                            ? "bg-danger text-white hover:bg-danger-light"
                                            : isBuffering
                                            ? "bg-brand/80 text-black"
                                            : "bg-brand text-black hover:scale-105"
                                    )}
                                    aria-label={
                                        audioError
                                            ? "Retry playback"
                                            : isBuffering
                                            ? "Buffering..."
                                            : isPlaying
                                            ? "Pause"
                                            : "Play"
                                    }
                                    title={
                                        audioError
                                            ? "retry playback"
                                            : isBuffering
                                            ? "buffering..."
                                            : isPlaying
                                            ? "pause"
                                            : "play"
                                    }
                                >
                                    {audioError ? (
                                        <RefreshCw className="w-5 h-5" />
                                    ) : isBuffering ? (
                                        <Loader2 className="w-5 h-5 animate-spin" />
                                    ) : isPlaying ? (
                                        <Pause className="w-5 h-5" />
                                    ) : (
                                        <Play className="w-5 h-5 ml-0.5" />
                                    )}
                                </button>
                            </div>
                        </div>
            </div>
        </div>
    );

}
