"use client";

import { useAudioState, useAudioPlayback, useAudioControls } from "@/lib/audio-context";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import Image from "next/image";
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
    AudioWaveform,
    ChevronLeft,
    ChevronUp,
    ChevronDown,
    AlertTriangle,
    RefreshCw,
} from "lucide-react";
import { useToast } from "@/lib/toast-context";
import { cn } from "@/utils/cn";
import { useState, useRef, useEffect, lazy, Suspense } from "react";
import { KeyboardShortcutsTooltip } from "./KeyboardShortcutsTooltip";
import { SeekSlider } from "./SeekSlider";
import { useFeatures } from "@/lib/features-context";
import { usePlaybackProgress } from "@/hooks/usePlaybackProgress";

const EnhancedVibeOverlay = lazy(() => import("./VibeOverlayEnhanced").then(mod => ({ default: mod.EnhancedVibeOverlay })));

export function MiniPlayer() {
    const { toast } = useToast();
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isShuffle,
        repeatMode,
        vibeMode,
        queue,
        currentIndex,
    } = useAudioState();
    const {
        isPlaying,
        isBuffering,
        canSeek,
        downloadProgress,
        audioError,
        clearAudioError,
    } = useAudioPlayback();
    const { duration, progress } = usePlaybackProgress();
    const {
        pause,
        resume,
        next,
        previous,
        toggleShuffle,
        toggleRepeat,
        seek,
        skipForward,
        skipBackward,
        setPlayerMode,
        startVibeMode,
        stopVibeMode,
    } = useAudioControls();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const { vibeEmbeddings, loading: featuresLoading } = useFeatures();
    const [isVibeLoading, setIsVibeLoading] = useState(false);
    const [isMinimized, setIsMinimized] = useState(false);
    const [isDismissed, setIsDismissed] = useState(false);
    const [swipeOffset, setSwipeOffset] = useState(0);
    const [isVibePanelExpanded, setIsVibePanelExpanded] = useState(false);
    const touchStartX = useRef<number | null>(null);
    const lastMediaIdRef = useRef<string | null>(null);

    // Get current track's audio features for vibe comparison
    const currentTrackFeatures = queue[currentIndex]?.audioFeatures || null;

    // Reset dismissed/minimized state when a new track starts playing
    const currentMediaId =
        currentTrack?.id || currentAudiobook?.id || currentPodcast?.id;

    useEffect(() => {
        // Reset dismissed state when new media loads OR when same media starts playing again
        if (currentMediaId) {
            if (currentMediaId !== lastMediaIdRef.current) {
                // Different media - reset everything
                lastMediaIdRef.current = currentMediaId;
                setIsDismissed(false);
                setIsMinimized(false);
            } else if (isDismissed && isPlaying) {
                // Same media but user started playing again - show the player
                setIsDismissed(false);
            }
        }
    }, [currentMediaId, isDismissed, isPlaying]);

    // Handle Vibe Match toggle - finds tracks that sound like the current track
    const handleVibeToggle = async () => {
        if (!currentTrack?.id) return;

        // If vibe mode is on, turn it off
        if (vibeMode) {
            stopVibeMode();
            toast.success("Vibe mode off");
            return;
        }

        // Otherwise, start vibe mode
        setIsVibeLoading(true);
        try {
            const result = await startVibeMode();

            if (result.success && result.trackCount > 0) {
                toast.success(`Vibe mode on - ${result.trackCount} similar tracks queued up next`);
            } else {
                toast.error("Couldn't find matching tracks in your library");
            }
        } catch (error) {
            console.error("Failed to start vibe match:", error);
            toast.error("Failed to match vibe");
        } finally {
            setIsVibeLoading(false);
        }
    };

    const { title, subtitle, coverUrl, mediaLink, hasMedia } = useMediaInfo(100);

    // Check if controls should be enabled (only for tracks)
    const canSkip = playbackType === "track";

    // Handle progress bar seek
    const handleSeek = (time: number) => {
        seek(time);
    };

    if (isMobileOrTablet) {
        // Don't render if no media
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

            // Reset
            setSwipeOffset(0);
            touchStartX.current = null;
        };

        // Completely dismissed - don't render anything
        if (isDismissed) {
            return null;
        }

        // Minimized tab - matches full player height, slides from right
        if (isMinimized) {
            return (
                <button
                    onClick={() => setIsMinimized(false)}
                    className="fixed right-0 z-[45] shadow-2xl transition-transform hover:scale-105 active:scale-95"
                    style={{
                        bottom: "calc(56px + var(--standalone-safe-area-bottom, 0px) + 8px)",
                    }}
                    aria-label="Show player"
                    title="Show player"
                >
                    <div
                        className="rounded-l-xl p-[2px]"
                        style={{
                            background: "linear-gradient(90deg, #fca200 0%, #f97316 100%)",
                        }}
                    >
                        <div className="rounded-l-[10px] overflow-hidden">
                            <div className="relative bg-gradient-to-r from-[#1a1508] to-[#0f0f0f]">
                                <div className="absolute inset-0 bg-gradient-to-r from-brand/30 to-[#f97316]/20" />

                                {/* Progress bar at top */}
                                <div className="relative h-[2px] bg-white/20 w-full">
                                    <div
                                        className="h-full bg-[#eab308] transition-all duration-150"
                                        style={{ width: `${progress}%` }}
                                    />
                                </div>
                                
                                {/* Content */}
                                <div className="relative flex items-center gap-2 pl-3 pr-2 py-3">
                                    <ChevronLeft className="w-4 h-4 text-white flex-shrink-0" />
                                    {coverUrl ? (
                                        <div className="relative w-12 h-12 rounded-lg overflow-hidden">
                                            <Image
                                                src={coverUrl}
                                                alt={title}
                                                fill
                                                sizes="48px"
                                                className="object-cover"
                                                unoptimized
                                            />
                                        </div>
                                    ) : (
                                        <div className="w-12 h-12 rounded-lg bg-black/30 flex items-center justify-center">
                                            <MusicIcon className="w-5 h-5 text-gray-400" />
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </button>
            );
        }

        // Calculate opacity for swipe feedback
        const swipeOpacity = 1 - Math.abs(swipeOffset) / 200;

        return (
            <div
                className="fixed left-2 right-2 z-[45] shadow-2xl"
                style={{
                    bottom: "calc(56px + var(--standalone-safe-area-bottom, 0px) + 8px)",
                    transform: `translateX(${swipeOffset}px)`,
                    opacity: swipeOpacity,
                    transition:
                        swipeOffset === 0
                            ? "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1)"
                            : "none",
                }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            >
                {/* Gradient border container - uses padding technique for gradient border */}
                <div
                    className="rounded-[14px] p-[2px]"
                    style={{
                        background: "linear-gradient(90deg, #fca200 0%, #f97316 50%, #fca200 100%)",
                    }}
                >
                    {/* Inner container with overflow hidden for proper clipping */}
                    <div className="rounded-[12px] overflow-hidden">
                        {/* Single solid background with gradient overlay - prevents corner bleed */}
                        <div className="relative bg-gradient-to-r from-[#1a1508] via-[#1a1200] to-[#1a1508]">
                            <div className="absolute inset-0 bg-gradient-to-r from-brand/25 via-[#f97316]/35 to-brand/25" />

                            {/* Progress bar at top - inside the clipped container */}
                            <div className="relative h-[2px] bg-white/20 w-full">
                                <div
                                    className="h-full bg-[#eab308] transition-all duration-150"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>

                            {/* Player content - more spacious padding */}
                            <div
                                className="relative flex items-center gap-3 px-3 py-3 cursor-pointer"
                                onClick={() => setPlayerMode("overlay")}
                            >
                                {/* Album Art - slightly larger */}
                                <div className="relative w-12 h-12 flex-shrink-0 rounded-lg overflow-hidden bg-black/30 shadow-md">
                                    {coverUrl ? (
                                        <Image
                                            src={coverUrl}
                                            alt={title}
                                            fill
                                            sizes="48px"
                                            className="object-cover"
                                            unoptimized
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                            <MusicIcon className="w-5 h-5 text-gray-400" />
                                        </div>
                                    )}
                                </div>

                                {/* Track Info */}
                                <div className="flex-1 min-w-0">
                                    {audioError ? (
                                        <>
                                            <div className="flex items-center gap-1">
                                                <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                                                <p className="text-red-300 text-sm font-medium truncate leading-tight">
                                                    Playback Error
                                                </p>
                                            </div>
                                            <p className="text-red-200/70 text-xs truncate leading-tight mt-0.5">
                                                Tap retry to reconnect
                                            </p>
                                        </>
                                    ) : (
                                        <>
                                            <p className="text-white text-sm font-medium truncate leading-tight">
                                                {title}
                                            </p>
                                            <p className="text-gray-300/70 text-xs truncate leading-tight mt-0.5">
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
                                    {/* Vibe button - only for music tracks when embeddings available */}
                                    {!featuresLoading && vibeEmbeddings && canSkip && (
                                        <button
                                            onClick={handleVibeToggle}
                                            disabled={isVibeLoading}
                                            className={cn(
                                                "w-10 h-10 flex items-center justify-center rounded-full transition-colors",
                                                vibeMode
                                                    ? "text-brand"
                                                    : "text-white/80 hover:text-brand"
                                            )}
                                            aria-label={
                                                vibeMode
                                                    ? "Turn off vibe mode"
                                                    : "Match this vibe"
                                            }
                                            aria-pressed={vibeMode}
                                            title={
                                                vibeMode
                                                    ? "Turn off vibe mode"
                                                    : "Match this vibe"
                                            }
                                        >
                                            {isVibeLoading ? (
                                                <Loader2 className="w-5 h-5 animate-spin" />
                                            ) : (
                                                <AudioWaveform className="w-5 h-5" />
                                            )}
                                        </button>
                                    )}

                                    {/* Play/Pause or Retry */}
                                    <button
                                        onClick={() => {
                                            if (audioError) {
                                                clearAudioError();
                                                resume();
                                            } else if (!isBuffering) {
                                                if (isPlaying) {
                                                    pause();
                                                } else {
                                                    resume();
                                                }
                                            }
                                        }}
                                        className={cn(
                                            "w-10 h-10 rounded-full flex items-center justify-center transition shadow-md",
                                            audioError
                                                ? "bg-red-500 text-white hover:bg-red-400"
                                                : isBuffering
                                                ? "bg-[#fca200]/80 text-black"
                                                : "bg-[#fca200] text-black hover:scale-105"
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
                                                ? "Retry playback"
                                                : isBuffering
                                                ? "Buffering..."
                                                : isPlaying
                                                ? "Pause"
                                                : "Play"
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
        <div className="relative">
            {/* Collapsible Vibe Panel - slides up from player */}
            {vibeMode && (
                <div
                    className={cn(
                        "absolute left-0 right-0 bottom-full transition-all duration-300 ease-out overflow-hidden border-t border-white/[0.08]",
                        isVibePanelExpanded ? "max-h-[500px]" : "max-h-0"
                    )}
                >
                    <div className="bg-[#121212]">
                        <Suspense fallback={<div className="p-4 text-center text-white/50">Loading vibe analysis...</div>}>
                            <EnhancedVibeOverlay
                                currentTrackFeatures={currentTrackFeatures}
                                variant="inline"
                                onClose={() => setIsVibePanelExpanded(false)}
                            />
                        </Suspense>
                    </div>
                </div>
            )}

            {/* Vibe Tab - shows when vibe mode is active */}
            {vibeMode && (
                <button
                    onClick={() => setIsVibePanelExpanded(!isVibePanelExpanded)}
                    className={cn(
                        "absolute -top-8 left-1/2 -translate-x-1/2 z-10",
                        "flex items-center gap-1.5 px-3 py-1 rounded-t-lg",
                        "bg-[#121212] border border-b-0 border-white/[0.08]",
                        "text-xs font-medium transition-colors",
                        isVibePanelExpanded
                            ? "text-brand"
                            : "text-white/70 hover:text-brand"
                    )}
                    aria-label={isVibePanelExpanded ? "Hide vibe analysis" : "Show vibe analysis"}
                    aria-expanded={isVibePanelExpanded}
                >
                    <AudioWaveform className="w-3.5 h-3.5" />
                    <span>Vibe Analysis</span>
                    {isVibePanelExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                        <ChevronUp className="w-3.5 h-3.5" />
                    )}
                </button>
            )}

            <div className="bg-gradient-to-t from-[#080808] via-[#0c0c0c] to-[#0a0a0a] border-t border-white/[0.08] relative">
                {/* Brand accent line */}
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent" />

                {/* Progress Bar */}
                <SeekSlider
                    progress={progress}
                    duration={duration}
                    onSeek={handleSeek}
                    canSeek={canSeek}
                    hasMedia={hasMedia}
                    downloadProgress={downloadProgress}
                    variant="minimal"
                    className="absolute top-0 left-0 right-0"
                />


                {/* Player Content */}
                <div className="px-3 py-2.5 pt-3">
                    {/* Artwork & Track Info */}
                    <div className="flex items-center gap-2 mb-2">
                        {/* Artwork */}
                        {mediaLink ? (
                            <Link
                                href={mediaLink}
                                className="relative flex-shrink-0 w-12 h-12"
                            >
                                <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-lg overflow-hidden shadow-lg flex items-center justify-center">
                                    {coverUrl ? (
                                        <Image
                                            key={coverUrl}
                                            src={coverUrl}
                                            alt={title}
                                            fill
                                            sizes="56px"
                                            className="object-cover"
                                            priority
                                            unoptimized
                                        />
                                    ) : (
                                        <MusicIcon className="w-6 h-6 text-gray-500" />
                                    )}
                                </div>
                            </Link>
                        ) : (
                            <div className="relative flex-shrink-0 w-12 h-12">
                                <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-lg overflow-hidden shadow-lg flex items-center justify-center">
                                    <MusicIcon className="w-6 h-6 text-gray-500" />
                                </div>
                            </div>
                        )}

                        {/* Track Info */}
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
                            <p className="text-gray-400 truncate text-xs">
                                {subtitle}
                            </p>
                        </div>

                        {/* Mode Switch Buttons */}
                        <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                                onClick={() => setPlayerMode("full")}
                                className="text-gray-400 hover:text-white transition p-1"
                                aria-label="Show bottom player"
                                title="Show bottom player"
                            >
                                <MonitorUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                                onClick={() => setPlayerMode("overlay")}
                                className={cn(
                                    "transition p-1",
                                    hasMedia
                                        ? "text-gray-400 hover:text-white"
                                        : "text-gray-600 cursor-not-allowed"
                                )}
                                disabled={!hasMedia}
                                aria-label="Expand player"
                                title="Expand to full screen"
                            >
                                <Maximize2 className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>

                    {/* Playback Controls */}
                    <div className="flex items-center justify-between gap-1">
                        {/* Shuffle */}
                        <button
                            onClick={toggleShuffle}
                            disabled={!hasMedia || !canSkip}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                hasMedia && canSkip
                                    ? isShuffle
                                        ? "text-[#a855f7] hover:text-[#c084fc]"
                                        : "text-gray-400 hover:text-white"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            aria-label="Shuffle"
                            aria-pressed={isShuffle}
                            title={canSkip ? "Shuffle" : "Shuffle (music only)"}
                        >
                            <Shuffle className="w-3.5 h-3.5" />
                        </button>

                        {/* Skip Backward 30s */}
                        <button
                            onClick={() => skipBackward(30)}
                            disabled={!hasMedia}
                            className={cn(
                                "rounded p-1.5 transition-colors relative",
                                hasMedia
                                    ? "text-gray-400 hover:text-white"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            aria-label="Skip backward 30 seconds"
                            title="Rewind 30 seconds"
                        >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span className="absolute text-[8px] font-bold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                30
                            </span>
                        </button>

                        {/* Previous */}
                        <button
                            onClick={previous}
                            disabled={!hasMedia || !canSkip}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                hasMedia && canSkip
                                    ? "text-gray-400 hover:text-white"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            aria-label="Previous track"
                            title={
                                canSkip ? "Previous" : "Previous (music only)"
                            }
                        >
                            <SkipBack className="w-4 h-4" />
                        </button>

                        {/* Play/Pause */}
                        <button
                            onClick={
                                isBuffering
                                    ? undefined
                                    : isPlaying
                                    ? pause
                                    : resume
                            }
                            disabled={!hasMedia || isBuffering}
                            className={cn(
                                "w-8 h-8 rounded-full flex items-center justify-center transition",
                                hasMedia && !isBuffering
                                    ? "bg-[#fca200] text-black hover:scale-105"
                                    : isBuffering
                                    ? "bg-[#fca200]/80 text-black"
                                    : "bg-gray-700 text-gray-500 cursor-not-allowed"
                            )}
                            aria-label={isPlaying ? "Pause" : "Play"}
                            title={
                                isBuffering
                                    ? "Buffering..."
                                    : isPlaying
                                    ? "Pause"
                                    : "Play"
                            }
                        >
                            {isBuffering ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : isPlaying ? (
                                <Pause className="w-4 h-4" />
                            ) : (
                                <Play className="w-4 h-4 ml-0.5" />
                            )}
                        </button>

                        {/* Next */}
                        <button
                            onClick={next}
                            disabled={!hasMedia || !canSkip}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                hasMedia && canSkip
                                    ? "text-gray-400 hover:text-white"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            aria-label="Next track"
                            title={canSkip ? "Next" : "Next (music only)"}
                        >
                            <SkipForward className="w-4 h-4" />
                        </button>

                        {/* Skip Forward 30s */}
                        <button
                            onClick={() => skipForward(30)}
                            disabled={!hasMedia}
                            className={cn(
                                "rounded p-1.5 transition-colors relative",
                                hasMedia
                                    ? "text-gray-400 hover:text-white"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            aria-label="Skip forward 30 seconds"
                            title="Forward 30 seconds"
                        >
                            <RotateCw className="w-3.5 h-3.5" />
                            <span className="absolute text-[8px] font-bold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                30
                            </span>
                        </button>

                        {/* Repeat */}
                        <button
                            onClick={toggleRepeat}
                            disabled={!hasMedia || !canSkip}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                hasMedia && canSkip
                                    ? repeatMode !== "off"
                                        ? "text-[#a855f7] hover:text-[#c084fc]"
                                        : "text-gray-400 hover:text-white"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            aria-label={repeatMode === 'one' ? "Repeat one" : repeatMode === 'all' ? "Repeat all" : "Repeat off"}
                            aria-pressed={repeatMode !== 'off'}
                            title={
                                canSkip
                                    ? repeatMode === "off"
                                        ? "Repeat: Off"
                                        : repeatMode === "all"
                                        ? "Repeat: All"
                                        : "Repeat: One"
                                    : "Repeat (music only)"
                            }
                        >
                            {repeatMode === "one" ? (
                                <Repeat1 className="w-3.5 h-3.5" />
                            ) : (
                                <Repeat className="w-3.5 h-3.5" />
                            )}
                        </button>

                        {/* Vibe Mode Toggle - only when embeddings available */}
                        {!featuresLoading && vibeEmbeddings && (
                            <button
                                onClick={handleVibeToggle}
                                disabled={!hasMedia || !canSkip || isVibeLoading}
                                className={cn(
                                    "rounded p-1.5 transition-colors",
                                    !hasMedia || !canSkip
                                        ? "text-gray-600 cursor-not-allowed"
                                        : vibeMode
                                        ? "text-brand hover:text-brand-hover"
                                        : "text-gray-400 hover:text-brand"
                                )}
                                aria-label="Toggle vibe visualization"
                                aria-pressed={vibeMode}
                                title={
                                    vibeMode
                                        ? "Turn off vibe mode"
                                        : "Match this vibe - find similar sounding tracks"
                                }
                            >
                                {isVibeLoading ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <AudioWaveform className="w-3.5 h-3.5" />
                                )}
                            </button>
                        )}

                        {/* Keyboard Shortcuts */}
                        <KeyboardShortcutsTooltip />
                    </div>
                </div>
            </div>
        </div>
    );
}
