"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import { usePlaybackProgress } from "@/hooks/usePlaybackProgress";
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
    MicVocal,
    ListMusic,
    ListPlus,
} from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { useState, useMemo } from "react";
import { useToast } from "@/lib/toast-context";
import { useVibeToggle } from "@/hooks/useVibeToggle";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { useAddToPlaylistMutation } from "@/hooks/useQueries";
import { KeyboardShortcutsTooltip } from "./KeyboardShortcutsTooltip";
import { cn } from "@/utils/cn";
import { computeVibeMatchScore } from "@/utils/vibeMatchScore";
import { useFeatures } from "@/lib/features-context";
import { formatTime, formatTimeRemaining } from "@/utils/formatTime";
import { SeekSlider } from "./SeekSlider";
import { SleepTimer } from "./SleepTimer";
import { useLyricsToggle } from "@/hooks/useLyricsToggle";


export function FullPlayer() {
    const { toast } = useToast();
    // Use split contexts to avoid re-rendering on every currentTime update
    const {
        currentTrack,
        playbackType,
        volume,
        isMuted,
        isShuffle,
        repeatMode,
        activeOperation,
        queue,
        currentIndex,
    } = useAudioState();

    const {
        isPlaying,
        isBuffering,
        canSeek,
        downloadProgress,
        audioError,
    } = useAudioPlayback();

    const { duration, displayTime, progress } = usePlaybackProgress();

    const {
        pause,
        resumeWithGesture,
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
    } = useAudioControls();

    const router = useRouter();
    const pathname = usePathname();
    const { handleVibeToggle, isVibeLoading } = useVibeToggle();
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const { vibeEmbeddings, loading: featuresLoading } = useFeatures();
    const { handleLyricsToggle, isLyricsActive } = useLyricsToggle({ isMobile: false });
    const { mutateAsync: addToPlaylist } = useAddToPlaylistMutation();

    const currentTrackFeatures = queue[currentIndex]?.audioFeatures || null;

    const vibeMatchScore = useMemo(() => {
        if (activeOperation.type === 'idle' || !('sourceFeatures' in activeOperation)) return null;
        return computeVibeMatchScore(activeOperation.sourceFeatures, currentTrackFeatures);
    }, [activeOperation, currentTrackFeatures]);


    const { title, subtitle, coverUrl, artistLink, mediaLink, hasMedia } = useMediaInfo(100);

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseInt(e.target.value) / 100;
        setVolume(newVolume);
    };

    return (
        <>
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
                                <div className={cn("relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-lg overflow-hidden shadow-lg flex items-center justify-center", "transition-transform duration-300", isPlaying && "scale-[1.03]")}>
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
                                        <MusicIcon className="w-6 h-6 text-[var(--text-muted)]" />
                                    )}
                                </div>
                            </Link>
                        ) : (
                            <div className="relative w-14 h-14 flex-shrink-0">
                                <div className={cn("relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-lg overflow-hidden shadow-lg flex items-center justify-center", "transition-transform duration-300", isPlaying && "scale-[1.03]")}>
                                    <MusicIcon className="w-6 h-6 text-[var(--text-muted)]" />
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
                                    <p className="text-xs text-[var(--text-secondary)] truncate">
                                        {subtitle}
                                    </p>
                                </Link>
                            ) : mediaLink ? (
                                <Link
                                    href={mediaLink}
                                    className="block hover:underline"
                                >
                                    <p className="text-xs text-[var(--text-secondary)] truncate">
                                        {subtitle}
                                    </p>
                                </Link>
                            ) : (
                                <p className="text-xs text-[var(--text-secondary)] truncate">
                                    {subtitle}
                                </p>
                            )}
                            {/* Vibe match score when in vibe mode */}
                            {activeOperation.type !== 'idle' && vibeMatchScore !== null && (
                                <span
                                    className={cn(
                                        "inline-flex items-center gap-1 text-micro font-semibold px-1.5 py-0.5 rounded mt-1",
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
                        <SleepTimer />
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
                                        ? "text-[#a855f7] hover:text-[#c084fc]"
                                        : "text-[var(--text-secondary)] hover:text-white"
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
                                        ? "text-[var(--text-secondary)] hover:text-white"
                                        : "text-[var(--text-muted)]"
                                )}
                                disabled={!hasMedia}
                                aria-label="Rewind 30 seconds"
                                title="Rewind 30 seconds"
                            >
                                <RotateCcw className="w-4 h-4" />
                                <span className="absolute text-micro font-semibold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                    30
                                </span>
                            </button>

                            <button
                                onClick={previous}
                                className="text-[var(--text-secondary)] hover:text-white transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                                disabled={!hasMedia || playbackType !== "track"}
                                aria-label="Previous track"
                                title="Previous track"
                            >
                                <SkipBack className="w-5 h-5" />
                            </button>

                            <button
                                onClick={isPlaying ? pause : resumeWithGesture}
                                className={cn(
                                    "w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 relative group",
                                    audioError
                                        ? "bg-red-500 text-white hover:scale-110 hover:bg-red-400"
                                        : hasMedia && !isBuffering
                                        ? "bg-brand text-black hover:scale-110 hover:shadow-[#fca200]/30"
                                        : isBuffering
                                        ? "bg-brand/80 text-black"
                                        : "bg-gray-700 text-[var(--text-muted)] cursor-not-allowed"
                                )}
                                disabled={!hasMedia}
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
                                    <div className="absolute inset-0 rounded-full bg-brand blur-md opacity-0 group-hover:opacity-50 transition-opacity duration-200" />
                                )}
                                {audioError ? (
                                    <RefreshCw className="w-5 h-5 relative z-(--z-raised)" />
                                ) : isBuffering ? (
                                    <Loader2 className="w-5 h-5 animate-spin relative z-(--z-raised)" />
                                ) : isPlaying ? (
                                    <span className="animate-pop"><Pause className="w-5 h-5 relative z-(--z-raised)" /></span>
                                ) : (
                                    <span className="animate-pop"><Play className="w-5 h-5 ml-0.5 relative z-(--z-raised)" /></span>
                                )}
                            </button>

                            <button
                                onClick={next}
                                className="text-[var(--text-secondary)] hover:text-white transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
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
                                        ? "text-[var(--text-secondary)] hover:text-white"
                                        : "text-[var(--text-muted)]"
                                )}
                                disabled={!hasMedia}
                                aria-label="Forward 30 seconds"
                                title="Forward 30 seconds"
                            >
                                <RotateCw className="w-4 h-4" />
                                <span className="absolute text-micro font-semibold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                    30
                                </span>
                            </button>

                            {/* Repeat */}
                            <button
                                onClick={toggleRepeat}
                                className={cn(
                                    "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                    repeatMode !== "off"
                                        ? "text-[#a855f7] hover:text-[#c084fc]"
                                        : "text-[var(--text-secondary)] hover:text-white"
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
                                            ? "text-[var(--text-muted)]"
                                            : activeOperation.type !== 'idle'
                                            ? "text-brand hover:text-brand-hover"
                                            : "text-[var(--text-secondary)] hover:text-brand"
                                    )}
                                    disabled={
                                        !hasMedia ||
                                        playbackType !== "track" ||
                                        isVibeLoading
                                    }
                                    aria-label={
                                        activeOperation.type !== 'idle'
                                            ? "Turn off vibe mode"
                                            : "Match this vibe"
                                    }
                                    aria-pressed={activeOperation.type !== 'idle'}
                                    title={
                                        activeOperation.type !== 'idle'
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

                            {/* Lyrics Toggle */}
                            {playbackType === "track" && (
                                <button
                                    onClick={handleLyricsToggle}
                                    className={cn(
                                        "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                        !hasMedia
                                            ? "text-[var(--text-muted)]"
                                            : isLyricsActive
                                            ? "text-brand hover:text-brand-hover"
                                            : "text-[var(--text-secondary)] hover:text-brand"
                                    )}
                                    disabled={!hasMedia}
                                    aria-label="Toggle lyrics"
                                    title="Show lyrics"
                                >
                                    <MicVocal className="w-4 h-4" />
                                </button>
                            )}

                            {/* Queue Toggle */}
                            <button
                                onClick={() => router.push("/queue")}
                                className={`p-1.5 rounded-md transition-colors ${
                                    pathname === "/queue"
                                        ? "text-brand"
                                        : "text-[var(--text-muted)] hover:text-white/70"
                                }`}
                                aria-label="View play queue"
                                title="Play queue"
                            >
                                <ListMusic className="w-4 h-4" />
                            </button>

                            {/* Add to Playlist */}
                            {playbackType === "track" && currentTrack && (
                                <button
                                    onClick={() => setShowPlaylistSelector(true)}
                                    className="p-1.5 rounded-md transition-colors text-[var(--text-muted)] hover:text-white/70"
                                    aria-label="Add to playlist"
                                    title="Add to playlist"
                                >
                                    <ListPlus className="w-4 h-4" />
                                </button>
                            )}
                        </div>

                        {/* Progress Bar */}
                        <div className="w-full flex items-center gap-3">
                            <span
                                className={cn(
                                    "text-xs text-right tabular-nums font-medium tabular-nums",
                                    hasMedia
                                        ? "text-[var(--text-secondary)]"
                                        : "text-[var(--text-muted)]",
                                    duration >= 3600 ? "w-14" : "w-10"
                                )}
                            >
                                {formatTime(displayTime)}
                            </span>
                            <SeekSlider
                                progress={progress}
                                duration={duration}
                                onSeek={seek}
                                canSeek={canSeek}
                                hasMedia={hasMedia}
                                downloadProgress={downloadProgress}
                                variant="default"
                                className="flex-1"
                            />
                            <span
                                className={cn(
                                    "text-xs tabular-nums font-medium tabular-nums",
                                    hasMedia
                                        ? "text-[var(--text-secondary)]"
                                        : "text-[var(--text-muted)]",
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
                            className="text-[var(--text-secondary)] hover:text-white transition-all duration-200 hover:scale-110"
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
                                    background: isMuted
                                        ? "rgba(255,255,255,0.15)"
                                        : `linear-gradient(to right, #fca200 ${volume * 100}%, rgba(255,255,255,0.15) ${volume * 100}%)`
                                }}
                                className="w-full h-1 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-[#eab308] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                            />
                        </div>

                        {/* Keyboard Shortcuts Info */}
                        <KeyboardShortcutsTooltip />

                        <button
                            onClick={() => setPlayerMode("overlay")}
                            className={cn(
                                "transition-all duration-200 border-l border-white/[0.08] pl-3",
                                hasMedia
                                    ? "text-[var(--text-secondary)] hover:text-white hover:scale-110"
                                    : "text-[var(--text-muted)] cursor-not-allowed"
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
        {showPlaylistSelector && currentTrack && (
            <PlaylistSelector
                isOpen={showPlaylistSelector}
                mode="multi"
                onSelectPlaylists={async (playlistIds) => {
                    try {
                        let added = 0;
                        for (const playlistId of playlistIds) {
                            const result = await addToPlaylist({ playlistId, trackId: currentTrack.id });
                            if (!result.duplicated) added++;
                        }
                        toast.success(
                            added > 0
                                ? `Added to ${added} playlist${added > 1 ? "s" : ""}`
                                : "Already in selected playlists"
                        );
                        setShowPlaylistSelector(false);
                    } catch {
                        toast.error("Failed to add to playlists");
                    }
                }}
                onClose={() => setShowPlaylistSelector(false)}
            />
        )}
        </>
    );
}
