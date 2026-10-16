"use client";

import { useMediaInfo } from "@/hooks/useMediaInfo";
import { usePlayerControls } from "@/hooks/usePlayerControls";
import { PlayCountLine } from "@/features/stats/PlayCountLine";
import Link from "next/link";
import { useRef, useState } from "react";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    ChevronDown,
    Music as MusicIcon,
    Shuffle,
    Repeat,
    Repeat1,
    Loader2,
    RotateCcw,
    RotateCw,
    RefreshCw,
    MicVocal,
} from "lucide-react";
import { formatTime, formatMediaDuration } from "@/lib/format";
import { shuffleState } from "@/lib/shuffle";
import { cn } from "@/lib/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { SeekSlider } from "./SeekSlider";
import { SleepTimer } from "./SleepTimer";
import { LyricsView } from "@/components/lyrics/LyricsView";
import { useLyricsToggle } from "@/hooks/useLyricsToggle";
import { VibeToggleButton } from "./VibeToggleButton";
import { CachedImage } from "@/components/ui/CachedImage";

export function OverlayPlayer() {
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
        displayTime,
        progress,
        pause,
        resumeWithGesture,
        next,
        previous,
        returnToPreviousMode,
        seek,
        skipForward,
        skipBackward,
        toggleShuffle,
        toggleRepeat,
    } = usePlayerControls();

    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    // Swipe state for track skipping
    const touchStartX = useRef<number | null>(null);
    const touchStartY = useRef<number | null>(null);
    const [swipeOffset, setSwipeOffset] = useState(0);
    const { handleLyricsToggle, isLyricsActive } = useLyricsToggle({ inline: true });
    const { title, subtitle, coverUrl, artistLink, mediaLink, hasMedia } = useMediaInfo(500);

    if (!currentTrack && !currentAudiobook && !currentPodcast) return null;

    const canSkip = playbackType === "track";
    // A podcast moves on to the show's next episode.
    const canNext = canSkip || playbackType === "podcast";
    const shuffle = shuffleState(hasMedia, playbackType, activeOperation.type);

    // A sideways swipe on the artwork skips the track; the seek bar and other
    // controls are outside it. Only a clearly sideways swipe counts.
    const handleTouchStart = (e: React.TouchEvent) => {
        touchStartX.current = e.touches[0].clientX;
        touchStartY.current = e.touches[0].clientY;
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (touchStartX.current === null || touchStartY.current === null) return;
        const deltaX = e.touches[0].clientX - touchStartX.current;
        const deltaY = e.touches[0].clientY - touchStartY.current;
        if (Math.abs(deltaY) > Math.abs(deltaX)) {
            touchStartX.current = null;
            setSwipeOffset(0);
            return;
        }
        setSwipeOffset(Math.max(-100, Math.min(100, deltaX)));
    };

    const handleTouchEnd = () => {
        touchStartY.current = null;
        if (touchStartX.current === null) return;

        if (canSkip && swipeOffset > 60) {
            previous();
        } else if (canNext && swipeOffset < -60) {
            next();
        }

        setSwipeOffset(0);
        touchStartX.current = null;
    };

    return (
        <div
            className="fixed inset-0 bg-gradient-to-b from-[#141210] via-[#0a0a0a] to-[#000000] z-(--z-overlay) flex flex-col overflow-hidden"
            role="region"
            aria-label="now playing"
        >
            <div
                className="flex items-center justify-between px-4 py-3 flex-shrink-0"
                style={{ paddingTop: "calc(12px + env(safe-area-inset-top))" }}
            >
                <button
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        returnToPreviousMode();
                    }}
                    className="text-[var(--text-secondary)] hover:text-white transition-colors p-2 -ml-2 rounded-full hover:bg-white/10"
                    title="close"
                >
                    <ChevronDown className="w-7 h-7" />
                </button>
                <span className="text-xs text-[var(--text-muted)] font-medium">
                    Now Playing
                </span>
                <div className="w-11" /> {/* Spacer for centering */}
            </div>

            {/* Main Content - Portrait vs Landscape */}
            <div className="flex-1 flex flex-col landscape:flex-row items-center justify-center px-6 pb-6 landscape:px-8 landscape:gap-8 overflow-hidden">
                {isLyricsActive ? (
                    <div className="w-full max-w-[280px] landscape:flex-1 aspect-square flex-shrink-0 relative mb-6 landscape:mb-0 rounded-2xl bg-[var(--bg-primary)]/90 border border-white/[0.06]">
                        <LyricsView variant="compact" />
                    </div>
                ) : (
                    <div
                        className="w-full max-w-[280px] landscape:flex-1 aspect-square flex-shrink-0 relative mb-6 landscape:mb-0"
                        style={{
                            transform: `translateX(${swipeOffset * 0.5}px)`,
                            opacity: 1 - Math.abs(swipeOffset) / 200,
                        }}
                        onTouchStart={isMobileOrTablet ? handleTouchStart : undefined}
                        onTouchMove={isMobileOrTablet ? handleTouchMove : undefined}
                        onTouchEnd={isMobileOrTablet ? handleTouchEnd : undefined}
                    >
                        <div
                            className={cn(
                                "absolute inset-0 rounded-2xl blur-2xl opacity-50",
                                activeOperation.type !== 'idle'
                                    ? "bg-gradient-to-br from-brand/30 via-transparent to-type-track/30"
                                    : "bg-gradient-to-br from-brand/20 via-transparent to-brand-dark/20"
                            )}
                        />

                        <div className={cn(
                            "relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-2xl overflow-hidden transition-transform duration-300",
                            isPlaying && "scale-[1.03]"
                        )}>
                        {coverUrl ? (
                            <CachedImage
                                key={coverUrl}
                                src={coverUrl}
                                alt={title}
                                fill
                                sizes="280px"
                                className="object-cover"
                                priority
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <MusicIcon className="w-24 h-24 text-[var(--text-muted)]" />
                            </div>
                        )}
                        </div>

                        {canSkip &&
                            isMobileOrTablet &&
                            Math.abs(swipeOffset) > 20 && (
                                <div
                                    className={cn(
                                        "absolute top-1/2 -translate-y-1/2 text-[var(--text-secondary)]",
                                        swipeOffset > 0 ? "-left-8" : "-right-8"
                                    )}
                                >
                                    {swipeOffset > 0 ? (
                                        <SkipBack className="w-6 h-6" />
                                    ) : (
                                        <SkipForward className="w-6 h-6" />
                                    )}
                                </div>
                            )}
                    </div>
                )}

                <div className="w-full max-w-[320px] landscape:max-w-[280px] landscape:flex-1 flex flex-col">
                    <div className="text-center landscape:text-left mb-6">
                        {mediaLink ? (
                            <Link
                                href={mediaLink}
                                onClick={returnToPreviousMode}
                                className="block hover:underline"
                            >
                                <p data-player-title className="text-xl font-bold text-white mb-1 truncate tracking-tight">
                                    {title}
                                </p>
                            </Link>
                        ) : (
                            <p data-player-title className="text-xl font-bold text-white mb-1 truncate tracking-tight">
                                {title}
                            </p>
                        )}
                        {artistLink ? (
                            <Link
                                href={artistLink}
                                onClick={returnToPreviousMode}
                                className="block hover:underline"
                            >
                                <p className="text-base text-[var(--text-secondary)] truncate">
                                    {subtitle}
                                </p>
                            </Link>
                        ) : (
                            <p className="text-base text-[var(--text-secondary)] truncate">
                                {subtitle}
                            </p>
                        )}
                        <PlayCountLine
                            trackId={playbackType === "track" ? currentTrack?.id : null}
                            className="mt-1"
                        />

                    </div>

                    <div className="mb-6">
                        <SeekSlider
                            progress={progress}
                            duration={duration}
                            onSeek={seek}
                            hasMedia={hasMedia}
                            variant="overlay"
                            showHandle={false}
                            className="mb-2"
                        />
                        <div className="flex justify-between text-xs text-[var(--text-muted)] tabular-nums font-medium">
                            <span>{formatTime(displayTime)}</span>
                            <span>{formatMediaDuration(playbackType, duration, displayTime)}</span>
                        </div>
                    </div>

                    <div className="flex items-center justify-center gap-6 mb-6">
                        {!canSkip && (
                            <button
                                onClick={() => skipBackward(30)}
                                className="text-[var(--text-primary)] hover:text-white transition-all hover:scale-110 relative"
                                title="rewind 30 seconds"
                            >
                                <RotateCcw className="w-7 h-7" />
                                <span className="absolute text-micro font-semibold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                    30
                                </span>
                            </button>
                        )}

                        <button
                            onClick={previous}
                            className={cn(
                                "text-[var(--text-primary)] hover:text-white transition-all hover:scale-110",
                                !canSkip &&
                                    "opacity-30 cursor-not-allowed hover:scale-100"
                            )}
                            disabled={!canSkip}
                            title={canSkip ? "previous" : "skip only for music"}
                        >
                            <SkipBack className="w-8 h-8" />
                        </button>

                        <button
                            onClick={isPlaying ? pause : resumeWithGesture}
                            className={cn(
                                "w-16 h-16 rounded-full flex items-center justify-center hover:scale-105 transition-all",
                                audioError
                                    ? "bg-danger text-black hover:bg-danger-light"
                                    : isBuffering
                                    ? "bg-brand/80 text-black"
                                    : "bg-brand text-black"
                            )}
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
                                <RefreshCw className="w-7 h-7" />
                            ) : isBuffering ? (
                                <Loader2 className="w-7 h-7 animate-spin" />
                            ) : isPlaying ? (
                                <span className="animate-pop"><Pause className="w-7 h-7" /></span>
                            ) : (
                                <span className="animate-pop"><Play className="w-7 h-7 ml-1" /></span>
                            )}
                        </button>

                        <button
                            onClick={next}
                            className={cn(
                                "text-[var(--text-primary)] hover:text-white transition-all hover:scale-110",
                                !canNext &&
                                    "opacity-30 cursor-not-allowed hover:scale-100"
                            )}
                            disabled={!canNext}
                            aria-label={playbackType === "podcast" ? "next episode" : "next track"}
                            title={playbackType === "podcast" ? "next episode" : canNext ? "next" : "next is for music and podcasts"}
                        >
                            <SkipForward className="w-8 h-8" />
                        </button>

                        {!canSkip && (
                            <button
                                onClick={() => skipForward(30)}
                                className="text-[var(--text-primary)] hover:text-white transition-all hover:scale-110 relative"
                                title="forward 30 seconds"
                            >
                                <RotateCw className="w-7 h-7" />
                                <span className="absolute text-micro font-semibold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                    30
                                </span>
                            </button>
                        )}
                    </div>

                    <div className="flex items-center justify-center gap-8">
                        <SleepTimer />

                        <button
                            onClick={toggleShuffle}
                            disabled={!shuffle.enabled}
                            className={cn(
                                "transition-colors",
                                !shuffle.enabled
                                    ? "text-[var(--text-muted)] cursor-not-allowed"
                                    : isShuffle
                                    ? "text-brand"
                                    : "text-[var(--text-muted)] hover:text-white"
                            )}
                            title={shuffle.title}
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>

                        <button
                            onClick={toggleRepeat}
                            disabled={!canSkip}
                            className={cn(
                                "transition-colors",
                                !canSkip
                                    ? "text-[var(--text-muted)] cursor-not-allowed"
                                    : repeatMode !== "off"
                                    ? "text-brand"
                                    : "text-[var(--text-muted)] hover:text-white"
                            )}
                            title={
                                repeatMode === "one"
                                    ? "repeat one"
                                    : repeatMode === "all"
                                    ? "repeat all"
                                    : "repeat off"
                            }
                        >
                            {repeatMode === "one" ? (
                                <Repeat1 className="w-5 h-5" />
                            ) : (
                                <Repeat className="w-5 h-5" />
                            )}
                        </button>

                        <VibeToggleButton
                            unavailable={!canSkip}
                            className="transition-colors"
                            iconClassName="w-5 h-5"
                            idleClassName="text-[var(--text-muted)] hover:text-brand"
                            activeClassName="text-brand"
                        />

                        {playbackType === "track" && (
                            <button
                                onClick={handleLyricsToggle}
                                className={cn(
                                    "transition-colors",
                                    !hasMedia
                                        ? "text-[var(--text-muted)] cursor-not-allowed"
                                        : isLyricsActive
                                        ? "text-brand"
                                        : "text-[var(--text-muted)] hover:text-brand"
                                )}
                                disabled={!hasMedia}
                                aria-label="Toggle lyrics"
                                title="show lyrics"
                            >
                                <MicVocal className="w-5 h-5" />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Safe area padding at bottom */}
            <div style={{ height: "env(safe-area-inset-bottom)" }} />
        </div>
    );
}
