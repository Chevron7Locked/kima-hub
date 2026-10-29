"use client";

import { useMediaInfo } from "@/hooks/useMediaInfo";
import { usePlayerControls } from "@/hooks/usePlayerControls";
import { PlayCountLine } from "@/features/stats/PlayCountLine";
import Link from "next/link";
import {
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
    Maximize2,
    Shuffle,
    Repeat,
    Repeat1,
    RotateCcw,
    RotateCw,
    AudioWaveform,
    MicVocal,
} from "lucide-react";
import { KeyboardShortcutsTooltip } from "./KeyboardShortcutsTooltip";
import { shuffleState } from "@/lib/shuffle";
import { cn } from "@/lib/cn";
import { PlayPauseButton } from "./PlayPauseButton";
import { formatTime, formatMediaDuration } from "@/lib/format";
import { SeekSlider } from "./SeekSlider";
import { SleepTimer } from "./SleepTimer";
import { useLyricsToggle } from "@/hooks/useLyricsToggle";
import { VibeToggleButton } from "./VibeToggleButton";
import { PlayerCover } from "@/components/player/PlayerCover";

export function FullPlayer() {
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
        setPlayerMode,
        seek,
        skipForward,
        skipBackward,
        setVolume,
        toggleMute,
        toggleShuffle,
        toggleRepeat,
    } = usePlayerControls();

    const { handleLyricsToggle, isLyricsActive } = useLyricsToggle({ inline: false });

    const currentId = queue[currentIndex]?.id;
    const match = activeOperation.type === 'vibe' && currentId ? activeOperation.matches[currentId] : undefined;
    const vibeMatchScore = match === undefined ? null : Math.round(match * 100);

    const { title, subtitle, coverUrl, artistLink, mediaLink, hasMedia } = useMediaInfo(100);
    const shuffle = shuffleState(hasMedia, playbackType, activeOperation.type);

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseInt(e.target.value) / 100;
        setVolume(newVolume);
    };

    return (
        <div className="relative flex-shrink-0" role="region" aria-label="now playing">
            <div className="bg-black border-t border-white/[0.08] h-24">
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-brand/40 to-transparent" />
                <div className="flex items-center h-full px-6 gap-6">
                    <div className="flex items-center gap-4 w-80">
                        <PlayerCover
                            href={mediaLink}
                            coverUrl={coverUrl}
                            title={title}
                            isPlaying={isPlaying}
                            className="w-14 h-14"
                        />
                        <div className="flex-1 min-w-0">
                            {mediaLink ? (
                                <Link
                                    href={mediaLink}
                                    className="block hover:underline"
                                >
                                    <p data-player-title className="text-white font-semibold truncate text-sm">
                                        {title}
                                    </p>
                                </Link>
                            ) : (
                                <p data-player-title className="text-white font-semibold truncate text-sm">
                                    {title}
                                </p>
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
                            {/* Beneath the subtitle rather than inside it: the
                                subtitle is itself a link to the artist, and a
                                link cannot contain another one. */}
                            <PlayCountLine
                                trackId={playbackType === "track" ? currentTrack?.id : null}
                                className="mt-0.5"
                            />
                            {vibeMatchScore !== null && (
                                <span className="inline-flex items-center gap-1 text-micro font-semibold px-1.5 py-0.5 rounded mt-1 bg-white/[0.06] text-muted">
                                    <AudioWaveform className="w-2.5 h-2.5" />
                                    {vibeMatchScore}% match
                                </span>
                            )}
                        </div>
                        <SleepTimer />
                    </div>

                    <div className="flex-1 flex flex-col items-center gap-2">
                        <div className="flex items-center gap-5" role="group" aria-label="Playback controls">
                            <button
                                onClick={toggleShuffle}
                                className={cn(
                                    "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                    isShuffle
                                        ? "text-brand hover:text-brand-light"
                                        : "text-[var(--text-secondary)] hover:text-white"
                                )}
                                disabled={!shuffle.enabled}
                                aria-label="Shuffle"
                                aria-pressed={isShuffle}
                                title={shuffle.title}
                            >
                                <Shuffle className="w-4 h-4" />
                            </button>

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
                                title="rewind 30 seconds"
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
                                title="previous track"
                            >
                                <SkipBack className="w-5 h-5" />
                            </button>

                            <PlayPauseButton
                                isPlaying={isPlaying}
                                isBuffering={isBuffering}
                                audioError={audioError}
                                onPlay={resumeWithGesture}
                                onPause={pause}
                                disabled={!hasMedia}
                                glow
                            />

                            <button
                                onClick={next}
                                className="text-[var(--text-secondary)] hover:text-white transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                                disabled={!hasMedia || (playbackType !== "track" && playbackType !== "podcast")}
                                aria-label={playbackType === "podcast" ? "next episode" : "Next track"}
                                title={playbackType === "podcast" ? "next episode" : "next track"}
                            >
                                <SkipForward className="w-5 h-5" />
                            </button>

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
                                title="forward 30 seconds"
                            >
                                <RotateCw className="w-4 h-4" />
                                <span className="absolute text-micro font-semibold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                    30
                                </span>
                            </button>

                            <button
                                onClick={toggleRepeat}
                                className={cn(
                                    "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                    repeatMode !== "off"
                                        ? "text-brand hover:text-brand-light"
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
                                        ? "repeat: off"
                                        : repeatMode === "all"
                                        ? "repeat: all (loop queue)"
                                        : "repeat: one (loop this track)"
                                }
                            >
                                {repeatMode === "one" ? (
                                    <Repeat1 className="w-4 h-4" />
                                ) : (
                                    <Repeat className="w-4 h-4" />
                                )}
                            </button>

                            <VibeToggleButton
                                unavailable={!hasMedia || playbackType !== "track"}
                                className="transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                                iconClassName="w-4 h-4"
                                idleClassName="text-[var(--text-secondary)] hover:text-brand"
                                activeClassName="text-brand hover:text-brand-hover"
                            />

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
                                    title="show lyrics"
                                >
                                    <MicVocal className="w-4 h-4" />
                                </button>
                            )}
                        </div>

                        <div className="w-full flex items-center gap-3">
                            <span
                                className={cn(
                                    "text-xs text-right tabular-nums font-medium",
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
                                hasMedia={hasMedia}
                                variant="default"
                                className="flex-1"
                            />
                            <span
                                className={cn(
                                    "text-xs tabular-nums font-medium",
                                    hasMedia
                                        ? "text-[var(--text-secondary)]"
                                        : "text-[var(--text-muted)]",
                                    duration >= 3600 ? "w-14" : "w-10"
                                )}
                            >
                                {formatMediaDuration(playbackType, duration, displayTime)}
                            </span>
                        </div>
                    </div>

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
                                className="w-full h-1 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-brand [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                            />
                        </div>

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
                            title="expand to full screen"
                        >
                            <Maximize2 className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
