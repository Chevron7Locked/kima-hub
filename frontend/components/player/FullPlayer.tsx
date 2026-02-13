"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import Image from "next/image";
import Link from "next/link";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
    Maximize2,
    Music as MusicIcon,
    Shuffle,
    Repeat,
    Repeat1,
    RotateCcw,
    RotateCw,
    Loader2,
    AudioWaveform,
    RefreshCw,
} from "lucide-react";
import { useState, useMemo } from "react";
import { toast } from "sonner";
import { KeyboardShortcutsTooltip } from "./KeyboardShortcutsTooltip";
import { cn } from "@/utils/cn";
import { useFeatures } from "@/lib/features-context";
import { formatTime, clampTime, formatTimeRemaining } from "@/utils/formatTime";
import { SeekSlider } from "./SeekSlider";


/**
 * FullPlayer - UI-only component for desktop bottom player
 * Does NOT manage audio element - that's handled by AudioElement component
 */
export function FullPlayer() {
    // Use split contexts to avoid re-rendering on every currentTime update
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        volume,
        isMuted,
        isShuffle,
        repeatMode,
        vibeMode,
        vibeSourceFeatures,
        queue,
        currentIndex,
    } = useAudioState();

    const {
        isPlaying,
        isBuffering,
        currentTime,
        duration: playbackDuration,
        canSeek,
        downloadProgress,
        audioError,
        clearAudioError,
    } = useAudioPlayback();

    const {
        pause,
        resume,
        next,
        previous,
        setPlayerMode,
        seek,
        skipForward,
        skipBackward,
        setVolume,
        toggleMute,
        toggleShuffle,
        toggleRepeat,
        startVibeMode,
        stopVibeMode,
    } = useAudioControls();

    const [isVibeLoading, setIsVibeLoading] = useState(false);
    const { vibeEmbeddings, loading: featuresLoading } = useFeatures();

    // Get current track's audio features for vibe comparison
    const currentTrackFeatures = queue[currentIndex]?.audioFeatures || null;

    // Calculate vibe match score (simplified version - compares key audio features)
    const vibeMatchScore = useMemo(() => {
        if (!vibeMode || !vibeSourceFeatures || !currentTrackFeatures) return null;

        // Compare key features: energy, valence, danceability, arousal
        const features = ['energy', 'valence', 'danceability', 'arousal'] as const;
        const scores: number[] = [];

        for (const key of features) {
            const sourceVal = vibeSourceFeatures[key as keyof typeof vibeSourceFeatures];
            const currentVal = currentTrackFeatures[key as keyof typeof currentTrackFeatures];

            if (typeof sourceVal === 'number' && typeof currentVal === 'number') {
                const diff = Math.abs(sourceVal - currentVal);
                scores.push(1 - diff);
            }
        }

        if (scores.length === 0) return null;
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        return Math.round(avgScore * 100);
    }, [vibeMode, vibeSourceFeatures, currentTrackFeatures]);

    // Handle Vibe Mode toggle - finds tracks that sound like the current track
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
                toast.success(`Vibe mode on`, {
                    description: `${result.trackCount} similar tracks queued up next`,
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

    const duration = (() => {
        // Prefer canonical durations for long-form media to avoid stale/misreported playbackDuration.
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



    // For audiobooks/podcasts, show saved progress even before playback starts
    // This provides immediate visual feedback of where the user left off
    const displayTime = (() => {
        let time = currentTime;

        // If we're actively playing or have seeked, use the live currentTime
        if (time <= 0) {
            // Otherwise, show saved progress for audiobooks/podcasts
            if (
                playbackType === "audiobook" &&
                currentAudiobook?.progress?.currentTime
            ) {
                time = currentAudiobook.progress.currentTime;
            } else if (
                playbackType === "podcast" &&
                currentPodcast?.progress?.currentTime
            ) {
                time = currentPodcast.progress.currentTime;
            }
        }

        // CRITICAL: Clamp to duration to prevent display of invalid times
        return clampTime(time, duration);
    })();

    const progress =
        duration > 0
            ? Math.min(100, Math.max(0, (displayTime / duration) * 100))
            : 0;

    const handleSeek = (time: number) => {
        seek(time);
    };

    const { title, subtitle, coverUrl, artistLink, mediaLink, hasMedia } = useMediaInfo(100);

    // Determine if seeking is allowed
    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseInt(e.target.value) / 100;
        setVolume(newVolume);
    };

    return (
        <div className="relative flex-shrink-0">
            <div className="bg-black border-t border-white/[0.08] h-24">
                {/* Brand accent line */}
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent" />
                <div className="flex items-center h-full px-6 gap-6">
                    {/* Artwork & Info */}
                    <div className="flex items-center gap-4 w-80">
                        {mediaLink ? (
                            <Link
                                href={mediaLink}
                                className="relative w-14 h-14 flex-shrink-0"
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
                            <div className="relative w-14 h-14 flex-shrink-0">
                                <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-lg overflow-hidden shadow-lg flex items-center justify-center">
                                    <MusicIcon className="w-6 h-6 text-gray-500" />
                                </div>
                            </div>
                        )}
                        <div className="flex-1 min-w-0">
                            {mediaLink ? (
                                <Link
                                    href={mediaLink}
                                    className="block hover:underline"
                                >
                                    <h4 className="text-white font-semibold truncate text-sm">
                                        {title}
                                    </h4>
                                </Link>
                            ) : (
                                <h4 className="text-white font-semibold truncate text-sm">
                                    {title}
                                </h4>
                            )}
                            {artistLink ? (
                                <Link
                                    href={artistLink}
                                    className="block hover:underline"
                                >
                                    <p className="text-xs text-gray-400 truncate">
                                        {subtitle}
                                    </p>
                                </Link>
                            ) : mediaLink ? (
                                <Link
                                    href={mediaLink}
                                    className="block hover:underline"
                                >
                                    <p className="text-xs text-gray-400 truncate">
                                        {subtitle}
                                    </p>
                                </Link>
                            ) : (
                                <p className="text-xs text-gray-400 truncate">
                                    {subtitle}
                                </p>
                            )}
                            {/* Vibe match score when in vibe mode */}
                            {vibeMode && vibeMatchScore !== null && (
                                <span
                                    className={cn(
                                        "inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded mt-1",
                                        vibeMatchScore >= 80
                                            ? "bg-green-500/20 text-green-400"
                                            : vibeMatchScore >= 60
                                            ? "bg-brand/20 text-brand"
                                            : "bg-orange-500/20 text-orange-400"
                                    )}
                                >
                                    <AudioWaveform className="w-2.5 h-2.5" />
                                    {vibeMatchScore}% match
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Controls */}
                    <div className="flex-1 flex flex-col items-center gap-2">
                        {/* Buttons */}
                        <div className="flex items-center gap-5" role="group" aria-label="Playback controls">
                            {/* Shuffle */}
                            <button
                                onClick={toggleShuffle}
                                className={cn(
                                    "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                    isShuffle
                                        ? "text-brand hover:text-brand-hover"
                                        : "text-gray-400 hover:text-white"
                                )}
                                disabled={!hasMedia || playbackType !== "track"}
                                aria-label="Shuffle"
                                aria-pressed={isShuffle}
                                title="Shuffle"
                            >
                                <Shuffle className="w-4 h-4" />
                            </button>

                            {/* Skip Backward 30s */}
                            <button
                                onClick={() => skipBackward(30)}
                                className={cn(
                                    "transition-all duration-200 hover:scale-110 relative disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                    hasMedia
                                        ? "text-gray-400 hover:text-white"
                                        : "text-gray-600"
                                )}
                                disabled={!hasMedia}
                                aria-label="Rewind 30 seconds"
                                title="Rewind 30 seconds"
                            >
                                <RotateCcw className="w-4 h-4" />
                                <span className="absolute text-[8px] font-bold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                    30
                                </span>
                            </button>

                            <button
                                onClick={previous}
                                className="text-gray-400 hover:text-white transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                                disabled={!hasMedia || playbackType !== "track"}
                                aria-label="Previous track"
                                title="Previous track"
                            >
                                <SkipBack className="w-5 h-5" />
                            </button>

                            <button
                                onClick={
                                    audioError
                                        ? () => {
                                            clearAudioError();
                                            resume();
                                        }
                                        : isBuffering
                                        ? undefined
                                        : isPlaying
                                        ? pause
                                        : resume
                                }
                                className={cn(
                                    "w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 relative group",
                                    audioError
                                        ? "bg-red-500 text-white hover:scale-110 hover:bg-red-400"
                                        : hasMedia && !isBuffering
                                        ? "bg-[#fca200] text-black hover:scale-110 shadow-lg shadow-[#fca200]/20 hover:shadow-[#fca200]/30"
                                        : isBuffering
                                        ? "bg-[#fca200]/80 text-black"
                                        : "bg-gray-700 text-gray-500 cursor-not-allowed"
                                )}
                                disabled={!hasMedia || isBuffering}
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
                                {hasMedia && !isBuffering && !audioError && (
                                    <div className="absolute inset-0 rounded-full bg-[#fca200] blur-md opacity-0 group-hover:opacity-50 transition-opacity duration-200" />
                                )}
                                {audioError ? (
                                    <RefreshCw className="w-5 h-5 relative z-10" />
                                ) : isBuffering ? (
                                    <Loader2 className="w-5 h-5 animate-spin relative z-10" />
                                ) : isPlaying ? (
                                    <Pause className="w-5 h-5 relative z-10" />
                                ) : (
                                    <Play className="w-5 h-5 ml-0.5 relative z-10" />
                                )}
                            </button>

                            <button
                                onClick={next}
                                className="text-gray-400 hover:text-white transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                                disabled={!hasMedia || playbackType !== "track"}
                                aria-label="Next track"
                                title="Next track"
                            >
                                <SkipForward className="w-5 h-5" />
                            </button>

                            {/* Skip Forward 30s */}
                            <button
                                onClick={() => skipForward(30)}
                                className={cn(
                                    "transition-all duration-200 hover:scale-110 relative disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                    hasMedia
                                        ? "text-gray-400 hover:text-white"
                                        : "text-gray-600"
                                )}
                                disabled={!hasMedia}
                                aria-label="Forward 30 seconds"
                                title="Forward 30 seconds"
                            >
                                <RotateCw className="w-4 h-4" />
                                <span className="absolute text-[8px] font-bold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                    30
                                </span>
                            </button>

                            {/* Repeat */}
                            <button
                                onClick={toggleRepeat}
                                className={cn(
                                    "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                    repeatMode !== "off"
                                        ? "text-brand hover:text-brand-hover"
                                        : "text-gray-400 hover:text-white"
                                )}
                                disabled={!hasMedia || playbackType !== "track"}
                                aria-label={
                                    repeatMode === "off"
                                        ? "Repeat off"
                                        : repeatMode === "all"
                                        ? "Repeat all"
                                        : "Repeat one"
                                }
                                aria-pressed={repeatMode !== "off"}
                                title={
                                    repeatMode === "off"
                                        ? "Repeat: Off"
                                        : repeatMode === "all"
                                        ? "Repeat: All (loop queue)"
                                        : "Repeat: One (play current track twice)"
                                }
                            >
                                {repeatMode === "one" ? (
                                    <Repeat1 className="w-4 h-4" />
                                ) : (
                                    <Repeat className="w-4 h-4" />
                                )}
                            </button>

                            {/* Vibe Mode Toggle - only when embeddings available */}
                            {!featuresLoading && vibeEmbeddings && (
                                <button
                                    onClick={handleVibeToggle}
                                    className={cn(
                                        "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                        !hasMedia || playbackType !== "track"
                                            ? "text-gray-600"
                                            : vibeMode
                                            ? "text-brand hover:text-brand-hover"
                                            : "text-gray-400 hover:text-brand"
                                    )}
                                    disabled={
                                        !hasMedia ||
                                        playbackType !== "track" ||
                                        isVibeLoading
                                    }
                                    aria-label={
                                        vibeMode
                                            ? "Turn off vibe mode"
                                            : "Match this vibe"
                                    }
                                    aria-pressed={vibeMode}
                                    title={
                                        vibeMode
                                            ? "Turn off vibe mode"
                                            : "Match this vibe - find similar sounding tracks"
                                    }
                                >
                                    {isVibeLoading ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                        <AudioWaveform className="w-4 h-4" />
                                    )}
                                </button>
                            )}
                        </div>

                        {/* Progress Bar */}
                        <div className="w-full flex items-center gap-3">
                            <span
                                className={cn(
                                    "text-xs text-right font-mono font-medium tabular-nums",
                                    hasMedia
                                        ? "text-gray-400"
                                        : "text-gray-600",
                                    duration >= 3600 ? "w-14" : "w-10"
                                )}
                            >
                                {formatTime(displayTime)}
                            </span>
                            <SeekSlider
                                progress={progress}
                                duration={duration}
                                onSeek={handleSeek}
                                canSeek={canSeek}
                                hasMedia={hasMedia}
                                downloadProgress={downloadProgress}
                                variant="default"
                                className="flex-1"
                            />
                            <span
                                className={cn(
                                    "text-xs font-mono font-medium tabular-nums",
                                    hasMedia
                                        ? "text-gray-400"
                                        : "text-gray-600",
                                    duration >= 3600 ? "w-14" : "w-10"
                                )}
                            >
                                {playbackType === "podcast" ||
                                playbackType === "audiobook"
                                    ? formatTimeRemaining(
                                          Math.max(0, duration - displayTime)
                                      )
                                    : formatTime(duration)}
                            </span>
                        </div>
                    </div>

                    {/* Volume & Expand */}
                    <div className="flex items-center gap-3 w-52 justify-end">
                        <button
                            onClick={toggleMute}
                            className="text-gray-400 hover:text-white transition-all duration-200 hover:scale-110"
                            aria-label={volume === 0 ? "Unmute" : "Mute"}
                        >
                            {isMuted || volume === 0 ? (
                                <VolumeX className="w-5 h-5" />
                            ) : (
                                <Volume2 className="w-5 h-5" />
                            )}
                        </button>

                        <div className="relative flex-1">
                            <input
                                type="range"
                                min="0"
                                max="100"
                                value={volume * 100}
                                onChange={handleVolumeChange}
                                aria-label="Volume"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={Math.round(volume * 100)}
                                aria-valuetext={`${Math.round(volume * 100)} percent`}
                                style={{
                                    background: `linear-gradient(to right, #fca200 ${volume * 100}%, rgba(255,255,255,0.15) ${volume * 100}%)`
                                }}
                                className="w-full h-1 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-brand [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-brand/30 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                            />
                        </div>

                        {/* Keyboard Shortcuts Info */}
                        <KeyboardShortcutsTooltip />

                        <button
                            onClick={() => setPlayerMode("overlay")}
                            className={cn(
                                "transition-all duration-200 border-l border-white/[0.08] pl-3",
                                hasMedia
                                    ? "text-gray-400 hover:text-white hover:scale-110"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            disabled={!hasMedia}
                            aria-label="Expand player"
                            title="Expand to full screen"
                        >
                            <Maximize2 className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
