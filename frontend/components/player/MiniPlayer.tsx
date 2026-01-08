"use client";

import { useAudio } from "@/lib/audio-context";
import { api } from "@/lib/api";
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
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/utils/cn";
import { clampTime } from "@/utils/formatTime";
import { useState, useRef, useEffect, lazy, Suspense } from "react";
import { KeyboardShortcutsTooltip } from "./KeyboardShortcutsTooltip";
import { SeekSlider } from "./SeekSlider";

// Lazy load VibeOverlayEnhanced - only loads when vibe mode is active
const EnhancedVibeOverlay = lazy(() => import("./VibeOverlayEnhanced").then(mod => ({ default: mod.EnhancedVibeOverlay })));

export function MiniPlayer() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isPlaying,
        isBuffering,
        isShuffle,
        repeatMode,
        currentTime,
        duration: playbackDuration,
        canSeek,
        downloadProgress,
        vibeMode,
        queue,
        currentIndex,
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
        setUpcoming,
        startVibeMode,
        stopVibeMode,
    } = useAudio();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
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
            const response = await api.getRadioTracks(
                "vibe",
                currentTrack.id,
                50
            );

            if (response.tracks && response.tracks.length > 0) {
                // Get the source track's features from the API response
                const sf = (response as any).sourceFeatures;
                const sourceFeatures = {
                    bpm: sf?.bpm,
                    energy: sf?.energy,
                    valence: sf?.valence,
                    arousal: sf?.arousal,
                    danceability: sf?.danceability,
                    keyScale: sf?.keyScale,
                    instrumentalness: sf?.instrumentalness,
                    analysisMode: sf?.analysisMode,
                    // ML Mood predictions
                    moodHappy: sf?.moodHappy,
                    moodSad: sf?.moodSad,
                    moodRelaxed: sf?.moodRelaxed,
                    moodAggressive: sf?.moodAggressive,
                    moodParty: sf?.moodParty,
                    moodAcoustic: sf?.moodAcoustic,
                    moodElectronic: sf?.moodElectronic,
                };

                // Start vibe mode with the queue IDs (include current track)
                const queueIds = [
                    currentTrack.id,
                    ...response.tracks.map((t: any) => t.id),
                ];
                startVibeMode(sourceFeatures, queueIds);

                // Add vibe tracks as upcoming (after current song finishes)
                setUpcoming(response.tracks, true); // preserveOrder=true for vibe mode

                toast.success(`Vibe mode on`, {
                    description: `${response.tracks.length} matching tracks queued up next`,
                    icon: <AudioWaveform className="w-4 h-4 text-brand" />,
                });
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

    const hasMedia = !!(currentTrack || currentAudiobook || currentPodcast);

    // Get current media info
    let title = "";
    let subtitle = "";
    let coverUrl: string | null = null;
    let mediaLink: string | null = null;

    if (playbackType === "track" && currentTrack) {
        title = currentTrack.title;
        subtitle = currentTrack.artist?.name || "Unknown Artist";
        coverUrl = currentTrack.album?.coverArt
            ? api.getCoverArtUrl(currentTrack.album.coverArt, 100)
            : null;
        mediaLink = currentTrack.album?.id
            ? `/album/${currentTrack.album.id}`
            : null;
    } else if (playbackType === "audiobook" && currentAudiobook) {
        title = currentAudiobook.title;
        subtitle = currentAudiobook.author;
        coverUrl = currentAudiobook.coverUrl
            ? api.getCoverArtUrl(currentAudiobook.coverUrl, 100)
            : null;
        mediaLink = `/audiobooks/${currentAudiobook.id}`;
    } else if (playbackType === "podcast" && currentPodcast) {
        title = currentPodcast.title;
        subtitle = currentPodcast.podcastTitle;
        coverUrl = currentPodcast.coverUrl
            ? api.getCoverArtUrl(currentPodcast.coverUrl, 100)
            : null;
        const podcastId = currentPodcast.id.split(":")[0];
        mediaLink = `/podcasts/${podcastId}`;
    } else {
        title = "Not Playing";
        subtitle = "Select something to play";
    }

    // Check if controls should be enabled (only for tracks)
    const canSkip = playbackType === "track";

    // Calculate progress percentage
    const duration = (() => {
        if (playbackType === "podcast" && currentPodcast?.duration) {
            return currentPodcast.duration;
        }
        if (playbackType === "audiobook" && currentAudiobook?.duration) {
            return currentAudiobook.duration;
        }
        return (
            playbackDuration ||
            currentTrack?.duration ||
            currentAudiobook?.duration ||
            currentPodcast?.duration ||
            0
        );
    })();

    // CRITICAL: Clamp currentTime to prevent invalid progress display
    const clampedCurrentTime = clampTime(currentTime, duration);

    const progress =
        duration > 0
            ? Math.min(100, Math.max(0, (clampedCurrentTime / duration) * 100))
            : 0;

    // Handle progress bar seek
    const handleSeek = (time: number) => {
        seek(time);
    };

    const seekEnabled = hasMedia && canSeek;

    // ============================================
    // MOBILE/TABLET: Spotify-style compact player
    // ============================================
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
                    className="fixed right-0 z-50 shadow-2xl transition-transform hover:scale-105 active:scale-95"
                    style={{
                        bottom: "calc(56px + env(safe-area-inset-bottom, 0px) + 8px)",
                    }}
                    aria-label="Show player"
                    title="Show player"
                >
                    <div
                        className="rounded-l-xl p-[2px]"
                        style={{
                            background: "linear-gradient(90deg, #a855f7 0%, #f5c518 100%)",
                        }}
                    >
                        <div className="rounded-l-[10px] overflow-hidden">
                            <div className="relative bg-gradient-to-r from-[#2d1847] to-[#1a1a2e]">
                                <div className="absolute inset-0 bg-gradient-to-r from-[#a855f7]/40 to-[#f5c518]/30" />
                                
                                {/* Progress bar at top */}
                                <div className="relative h-[2px] bg-white/20 w-full">
                                    <div
                                        className="h-full bg-gradient-to-r from-[#a855f7] to-[#f5c518] transition-all duration-150"
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
                className="fixed left-2 right-2 z-50 shadow-2xl"
                style={{
                    bottom: "calc(56px + env(safe-area-inset-bottom, 0px) + 8px)",
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
                        background: "linear-gradient(90deg, #f5c518 0%, #a855f7 50%, #f5c518 100%)",
                    }}
                >
                    {/* Inner container with overflow hidden for proper clipping */}
                    <div className="rounded-[12px] overflow-hidden">
                        {/* Single solid background with gradient overlay - prevents corner bleed */}
                        <div className="relative bg-gradient-to-r from-[#2a1a3f] via-[#3d2060] to-[#2a1a3f]">
                            <div className="absolute inset-0 bg-gradient-to-r from-[#f5c518]/25 via-[#a855f7]/35 to-[#f5c518]/25" />

                            {/* Progress bar at top - inside the clipped container */}
                            <div className="relative h-[2px] bg-white/20 w-full">
                                <div
                                    className="h-full bg-gradient-to-r from-[#f5c518] via-[#e6a700] to-[#a855f7] transition-all duration-150"
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
                                    <p className="text-white text-sm font-medium truncate leading-tight">
                                        {title}
                                    </p>
                                    <p className="text-gray-300/70 text-xs truncate leading-tight mt-0.5">
                                        {subtitle}
                                    </p>
                                </div>

                                {/* Controls - Vibe button (for music only) & Play/Pause */}
                                <div
                                    className="flex items-center gap-1.5 flex-shrink-0"
                                    onClick={(e) => e.stopPropagation()}
                                    role="group"
                                    aria-label="Playback controls"
                                >
                                    {/* Vibe button - only for music tracks */}
                                    {canSkip && (
                                        <button
                                            onClick={handleVibeToggle}
                                            disabled={isVibeLoading}
                                            className={cn(
                                                "w-10 h-10 flex items-center justify-center rounded-full transition-colors",
                                                vibeMode
                                                    ? "text-[#f5c518]"
                                                    : "text-white/80 hover:text-[#f5c518]"
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

                                    {/* Play/Pause */}
                                    <button
                                        onClick={() => {
                                            if (!isBuffering) {
                                                if (isPlaying) {
                                                    pause();
                                                } else {
                                                    resume();
                                                }
                                            }
                                        }}
                                        className={cn(
                                            "w-10 h-10 rounded-full flex items-center justify-center transition shadow-md",
                                            isBuffering
                                                ? "bg-white/80 text-black"
                                                : "bg-white text-black hover:scale-105"
                                        )}
                                        aria-label={
                                            isBuffering
                                                ? "Buffering..."
                                                : isPlaying
                                                ? "Pause"
                                                : "Play"
                                        }
                                        title={
                                            isBuffering
                                                ? "Buffering..."
                                                : isPlaying
                                                ? "Pause"
                                                : "Play"
                                        }
                                    >
                                        {isBuffering ? (
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

    // ============================================
    // DESKTOP: Full-featured mini player
    // ============================================
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

            <div className="bg-gradient-to-t from-[#0a0a0a] via-[#0f0f0f] to-[#0a0a0a] border-t border-white/[0.08] relative backdrop-blur-xl">
                {/* Subtle top glow */}
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

                {/* Progress Bar */}
                <SeekSlider
                    progress={progress}
                    duration={duration}
                    currentTime={clampedCurrentTime}
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
                                className="relative flex-shrink-0 group w-12 h-12"
                            >
                                <div className="absolute inset-0 bg-gradient-to-br from-white/20 to-transparent rounded-full blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                                <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-full overflow-hidden shadow-lg flex items-center justify-center">
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
                                <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-full overflow-hidden shadow-lg flex items-center justify-center">
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
                                        ? "text-green-500 hover:text-green-400"
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
                                    ? "bg-white text-black hover:scale-105"
                                    : isBuffering
                                    ? "bg-white/80 text-black"
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
                                        ? "text-green-500 hover:text-green-400"
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

                        {/* Vibe Mode Toggle */}
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

                        {/* Keyboard Shortcuts */}
                        <KeyboardShortcutsTooltip />
                    </div>
                </div>
            </div>
        </div>
    );
}
