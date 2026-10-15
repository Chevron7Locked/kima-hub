"use client";

import { usePlayerControls } from "@/hooks/usePlayerControls";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import { PlayCountLine } from "@/features/stats/PlayCountLine";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import Link from "next/link";
import {
    Play,
    Pause,
    Maximize2,
    Music as MusicIcon,
    SkipBack,
    SkipForward,
    Repeat,
    Repeat1,
    Shuffle,
    MonitorUp,
    RotateCcw,
    RotateCw,
    Loader2,
    ChevronLeft,
    AlertTriangle,
    RefreshCw,
} from "lucide-react";
import { shuffleState } from "@/lib/shuffle";
import { cn } from "@/lib/cn";
import { useState, useRef } from "react";
import { KeyboardShortcutsTooltip } from "./KeyboardShortcutsTooltip";
import { SeekSlider } from "./SeekSlider";
import { SleepTimer } from "./SleepTimer";
import { VibeToggleButton } from "./VibeToggleButton";
import { CachedImage } from "@/components/ui/CachedImage";
import { PlayerCover } from "@/components/player/PlayerCover";

export function MiniPlayer() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isShuffle,
        repeatMode,
        activeOperation,
        isPlaying,
        isBuffering,
        audioError,
        duration,
        progress,
        pause,
        resumeWithGesture,
        next,
        previous,
        toggleShuffle,
        toggleRepeat,
        seek,
        skipForward,
        skipBackward,
        setPlayerMode,
    } = usePlayerControls();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
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

    const { title, subtitle, coverUrl, mediaLink, hasMedia } = useMediaInfo(100);

    const countedTrackId = playbackType === "track" ? currentTrack?.id : null;

    // Check if controls should be enabled (only for tracks)
    const canSkip = playbackType === "track";
    const shuffle = shuffleState(hasMedia, playbackType, activeOperation.type);

    if (isMobileOrTablet) {
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
                {/* Page content melts into the bar instead of clipping at its edge. */}
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-full inset-x-4 h-6 rounded-t-full bg-gradient-to-b from-transparent to-[#15100a]/85"
                />

                {/* Gradient border container - uses padding technique for gradient border */}
                <div
                    className="rounded-2xl p-[2px]"
                    style={{
                        background: "linear-gradient(90deg, #fca200 0%, #d48c00 50%, #fca200 100%)",
                    }}
                >
                    {/* Inner container with overflow hidden for proper clipping */}
                    <div className="rounded-xl overflow-hidden">
                        {/* Single solid background with gradient overlay - prevents corner bleed */}
                        <div className="relative bg-gradient-to-r from-[#1a1508] via-[#1a1200] to-[#1a1508]">
                            <div className="absolute inset-0 bg-gradient-to-r from-brand/25 via-brand-dark/35 to-brand/25" />

                            {/* Progress bar at top - inside the clipped container */}
                            <div className="relative h-[2px] bg-white/20 w-full">
                                <div
                                    className="h-full bg-brand transition-all duration-150"
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
                                    className="relative w-12 h-12 flex-shrink-0 rounded-lg overflow-hidden bg-black/30 landscape-short:w-10 landscape-short:h-10"
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
                                            <p className="text-white text-sm font-medium truncate leading-tight">
                                                {title}
                                            </p>
                                            <div className="landscape-short:flex landscape-short:min-w-0 landscape-short:items-baseline landscape-short:gap-2">
                                                <p className="text-gray-300/70 text-xs truncate leading-tight mt-0.5">
                                                    {subtitle}
                                                </p>
                                                <PlayCountLine
                                                    trackId={countedTrackId}
                                                    className="mt-0.5 shrink-0"
                                                />
                                            </div>
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
                </div>
            </div>
        );
    }

    return (
        <div className="relative" role="region" aria-label="now playing">
            <div className="bg-gradient-to-t from-[#080808] via-[#0c0c0c] to-[#0a0a0a] border-t border-white/[0.08] relative">
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent" />

                <SeekSlider
                    progress={progress}
                    duration={duration}
                    onSeek={seek}
                    hasMedia={hasMedia}
                    variant="minimal"
                    className="absolute top-0 left-0 right-0"
                />

                <div className="px-3 py-2.5 pt-3">
                    <div className="flex items-center gap-2 mb-2">
                        <PlayerCover
                            href={mediaLink}
                            coverUrl={coverUrl}
                            title={title}
                            isPlaying={isPlaying}
                            className="w-12 h-12"
                        />

                        <div className="flex-1 min-w-0">
                            {mediaLink ? (
                                <Link
                                    href={mediaLink}
                                    className="block hover:underline"
                                >
                                    <p className="text-white font-semibold truncate text-sm">
                                        {title}
                                    </p>
                                </Link>
                            ) : (
                                <p className="text-white font-semibold truncate text-sm">
                                    {title}
                                </p>
                            )}
                            <p className="text-[var(--text-secondary)] truncate text-xs">
                                {subtitle}
                            </p>
                        </div>

                        <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                                onClick={() => setPlayerMode("full")}
                                className="text-[var(--text-secondary)] hover:text-white transition p-2"
                                aria-label="Show bottom player"
                                title="show bottom player"
                            >
                                <MonitorUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                                onClick={() => setPlayerMode("overlay")}
                                className={cn(
                                    "transition p-2",
                                    hasMedia
                                        ? "text-[var(--text-secondary)] hover:text-white"
                                        : "text-[var(--text-muted)] cursor-not-allowed"
                                )}
                                disabled={!hasMedia}
                                aria-label="Expand player"
                                title="expand to full screen"
                            >
                                <Maximize2 className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>

                    <div className="flex items-center justify-between gap-1">
                        <SleepTimer size="sm" />

                        <button
                            onClick={toggleShuffle}
                            disabled={!shuffle.enabled}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                shuffle.enabled
                                    ? isShuffle
                                        ? "text-brand hover:text-brand-light"
                                        : "text-[var(--text-secondary)] hover:text-white"
                                    : "text-[var(--text-muted)] cursor-not-allowed"
                            )}
                            aria-label="Shuffle"
                            aria-pressed={isShuffle}
                            title={shuffle.title}
                        >
                            <Shuffle className="w-3.5 h-3.5" />
                        </button>

                        <button
                            onClick={() => skipBackward(30)}
                            disabled={!hasMedia}
                            className={cn(
                                "rounded p-1.5 transition-colors relative",
                                hasMedia
                                    ? "text-[var(--text-secondary)] hover:text-white"
                                    : "text-[var(--text-muted)] cursor-not-allowed"
                            )}
                            aria-label="Skip backward 30 seconds"
                            title="rewind 30 seconds"
                        >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span className="absolute text-micro font-semibold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                30
                            </span>
                        </button>

                        <button
                            onClick={previous}
                            disabled={!hasMedia || !canSkip}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                hasMedia && canSkip
                                    ? "text-[var(--text-secondary)] hover:text-white"
                                    : "text-[var(--text-muted)] cursor-not-allowed"
                            )}
                            aria-label="Previous track"
                            title={
                                canSkip ? "previous" : "previous (music only)"
                            }
                        >
                            <SkipBack className="w-4 h-4" />
                        </button>

                        <button
                            onClick={isPlaying ? pause : resumeWithGesture}
                            disabled={!hasMedia}
                            className={cn(
                                "w-10 h-10 rounded-full flex items-center justify-center transition",
                                hasMedia
                                    ? isBuffering
                                        ? "bg-brand/80 text-black"
                                        : "bg-brand text-black hover:scale-105"
                                    : "bg-gray-700 text-[var(--text-muted)] cursor-not-allowed"
                            )}
                            aria-label={isPlaying ? "Pause" : "Play"}
                            title={
                                isBuffering
                                    ? "buffering..."
                                    : isPlaying
                                    ? "pause"
                                    : "play"
                            }
                        >
                            {isBuffering ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : isPlaying ? (
                                <span className="animate-pop"><Pause className="w-4 h-4" /></span>
                            ) : (
                                <span className="animate-pop"><Play className="w-4 h-4 ml-0.5" /></span>
                            )}
                        </button>

                        <button
                            onClick={next}
                            disabled={!hasMedia || !canSkip}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                hasMedia && canSkip
                                    ? "text-[var(--text-secondary)] hover:text-white"
                                    : "text-[var(--text-muted)] cursor-not-allowed"
                            )}
                            aria-label="Next track"
                            title={canSkip ? "next" : "next (music only)"}
                        >
                            <SkipForward className="w-4 h-4" />
                        </button>

                        <button
                            onClick={() => skipForward(30)}
                            disabled={!hasMedia}
                            className={cn(
                                "rounded p-1.5 transition-colors relative",
                                hasMedia
                                    ? "text-[var(--text-secondary)] hover:text-white"
                                    : "text-[var(--text-muted)] cursor-not-allowed"
                            )}
                            aria-label="Skip forward 30 seconds"
                            title="forward 30 seconds"
                        >
                            <RotateCw className="w-3.5 h-3.5" />
                            <span className="absolute text-micro font-semibold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                30
                            </span>
                        </button>

                        <button
                            onClick={toggleRepeat}
                            disabled={!hasMedia || !canSkip}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                hasMedia && canSkip
                                    ? repeatMode !== "off"
                                        ? "text-brand hover:text-brand-light"
                                        : "text-[var(--text-secondary)] hover:text-white"
                                    : "text-[var(--text-muted)] cursor-not-allowed"
                            )}
                            aria-label={repeatMode === 'one' ? "Repeat one" : repeatMode === 'all' ? "Repeat all" : "Repeat off"}
                            aria-pressed={repeatMode !== 'off'}
                            title={
                                canSkip
                                    ? repeatMode === "off"
                                        ? "repeat: off"
                                        : repeatMode === "all"
                                        ? "repeat: all"
                                        : "repeat: one"
                                    : "repeat (music only)"
                            }
                        >
                            {repeatMode === "one" ? (
                                <Repeat1 className="w-3.5 h-3.5" />
                            ) : (
                                <Repeat className="w-3.5 h-3.5" />
                            )}
                        </button>

                        <VibeToggleButton
                            unavailable={!hasMedia || !canSkip}
                            className="rounded p-1.5 transition-colors"
                            iconClassName="w-3.5 h-3.5"
                            idleClassName="text-[var(--text-secondary)] hover:text-brand"
                            activeClassName="text-brand hover:text-brand-hover"
                        />

                        <KeyboardShortcutsTooltip />
                    </div>
                </div>
            </div>
        </div>
    );
}
