"use client";

import { useRef, useState, useEffect } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import {
    Play,
    Pause,
    SkipForward,
    SkipBack,
    Volume2,
    VolumeX,
    X,
    RotateCcw,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";

interface Episode {
    id: string;
    title: string;
    description?: string;
    duration: number;
    publishedAt: string;
    episodeNumber?: number;
    season?: number;
    progress?: {
        currentTime: number;
        progress: number;
        isFinished: boolean;
        lastPlayedAt: Date;
    };
}

interface PodcastPlayerProps {
    podcastId: string;
    episode: Episode;
    onClose: () => void;
    onEpisodeChange?: (episode: Episode) => void;
}

export function PodcastPlayer({
    podcastId,
    episode,
    onClose,
    onEpisodeChange,
}: PodcastPlayerProps) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(
        episode.progress?.currentTime || 0
    );
    const [duration, setDuration] = useState(episode.duration || 0);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [playbackSpeed, setPlaybackSpeed] = useState(1);
    const [showConfirmModal, setShowConfirmModal] = useState(false);
    const [isRemovingProgress, setIsRemovingProgress] = useState(false);

    const { toast } = useToast();

    // Resume from last position
    useEffect(() => {
        if (audioRef.current && episode.progress?.currentTime) {
            audioRef.current.currentTime = episode.progress.currentTime;
            setCurrentTime(episode.progress.currentTime);
        }
    }, [episode]);

    // Save progress periodically while playing
    useEffect(() => {
        if (!isPlaying || !audioRef.current) {
            if (progressIntervalRef.current) {
                clearInterval(progressIntervalRef.current);
                progressIntervalRef.current = null;
            }
            return;
        }

        // Save progress every 10 seconds
        progressIntervalRef.current = setInterval(async () => {
            if (audioRef.current && currentTime > 0) {
                const duration =
                    audioRef.current.duration || episode.duration || 0;
                const isFinished = duration - currentTime < 30;

                try {
                    await api.updatePodcastEpisodeProgress(
                        podcastId,
                        episode.id,
                        currentTime,
                        duration,
                        isFinished
                    );
                } catch (error) {
                    console.error("Failed to sync podcast progress:", error);
                }
            }
        }, 10000);

        return () => {
            if (progressIntervalRef.current) {
                clearInterval(progressIntervalRef.current);
            }
        };
    }, [isPlaying, currentTime, podcastId, episode.id, episode.duration]);

    // Track time updates
    const handleTimeUpdate = () => {
        if (audioRef.current) {
            setCurrentTime(audioRef.current.currentTime);
        }
    };

    // Track duration
    const handleLoadedMetadata = () => {
        if (audioRef.current) {
            setDuration(audioRef.current.duration);
        }
    };

    // Play/pause handler
    const handlePlayPause = () => {
        if (!audioRef.current) return;

        if (isPlaying) {
            audioRef.current.pause();
        } else {
            audioRef.current.play();
        }
    };

    // Save on pause
    const handlePause = async () => {
        setIsPlaying(false);
        if (audioRef.current) {
            try {
                await api.updatePodcastEpisodeProgress(
                    podcastId,
                    episode.id,
                    audioRef.current.currentTime,
                    audioRef.current.duration || duration,
                    false
                );
            } catch (error) {
                console.error(
                    "Failed to save podcast progress on pause:",
                    error
                );
            }
        }
    };

    // Save when finished
    const handleEnded = async () => {
        setIsPlaying(false);
        if (audioRef.current) {
            try {
                await api.updatePodcastEpisodeProgress(
                    podcastId,
                    episode.id,
                    audioRef.current.duration,
                    audioRef.current.duration,
                    true
                );
                toast.success("Episode finished!");
                onEpisodeChange?.(episode);
            } catch (error) {
                console.error("Failed to save podcast progress on end:", error);
            }
        }
    };

    const handleSkip = (seconds: number) => {
        if (audioRef.current) {
            audioRef.current.currentTime += seconds;
        }
    };

    const handleSeek = (value: number) => {
        if (audioRef.current) {
            audioRef.current.currentTime = value;
            setCurrentTime(value);
        }
    };

    const handleVolumeChange = (value: number) => {
        setVolume(value);
        if (audioRef.current) {
            audioRef.current.volume = value;
        }
        setIsMuted(value === 0);
    };

    const handleMuteToggle = () => {
        if (isMuted) {
            handleVolumeChange(volume || 0.5);
        } else {
            handleVolumeChange(0);
        }
    };

    const handleSpeedChange = (speed: number) => {
        setPlaybackSpeed(speed);
        if (audioRef.current) {
            audioRef.current.playbackRate = speed;
        }
    };

    const handleRemoveProgress = async () => {
        setShowConfirmModal(false);
        setIsRemovingProgress(true);

        try {
            await api.deletePodcastEpisodeProgress(podcastId, episode.id);
            if (audioRef.current) {
                audioRef.current.currentTime = 0;
                setCurrentTime(0);
            }
            toast.success("Progress removed");
            onEpisodeChange?.(episode);
        } catch (error) {
            console.error("Failed to remove progress:", error);
            toast.error("Failed to remove progress");
        } finally {
            setIsRemovingProgress(false);
        }
    };

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
    const streamUrl = api.getPodcastEpisodeStreamUrl(podcastId, episode.id);

    return (
        <>
            <div className="fixed bottom-0 left-0 right-0 bg-gradient-to-br from-[#141414] to-[#0f0f0f] border-t border-[#262626] shadow-2xl z-50">
                <div className="max-w-7xl mx-auto px-4 md:px-6 py-4">
                    {/* Audio Element */}
                    <audio
                        ref={audioRef}
                        src={streamUrl}
                        preload="metadata"
                        onPlay={() => setIsPlaying(true)}
                        onPause={handlePause}
                        onEnded={handleEnded}
                        onTimeUpdate={handleTimeUpdate}
                        onLoadedMetadata={handleLoadedMetadata}
                    />

                    <div className="space-y-3">
                        {/* Top Row: Episode Info and Close Button */}
                        <div className="flex items-center justify-between gap-4">
                            <div className="flex-1 min-w-0">
                                <h3 className="font-semibold text-white truncate text-sm">
                                    {episode.title}
                                </h3>
                                <p className="text-xs text-gray-400">
                                    {formatTime(currentTime)} /{" "}
                                    {formatTime(duration)}
                                </p>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-2">
                                {episode.progress && (
                                    <button
                                        onClick={() =>
                                            setShowConfirmModal(true)
                                        }
                                        disabled={isRemovingProgress}
                                        className="text-gray-400 hover:text-red-400 transition-colors p-2"
                                        title="Reset progress"
                                    >
                                        <RotateCcw className="w-4 h-4" />
                                    </button>
                                )}
                                <button
                                    onClick={onClose}
                                    className="text-gray-400 hover:text-white transition-colors p-2"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        {/* Progress Bar */}
                        <div
                            onClick={(e) => {
                                const rect =
                                    e.currentTarget.getBoundingClientRect();
                                const clickX = e.clientX - rect.left;
                                const percentage = clickX / rect.width;
                                handleSeek(percentage * duration);
                            }}
                            className="relative h-1.5 bg-gray-800 rounded-full cursor-pointer group"
                        >
                            {/* Played portion */}
                            <div
                                className="absolute top-0 left-0 h-full bg-gray-700 rounded-full transition-all"
                                style={{ width: `${progress}%` }}
                            />
                            {/* Current position */}
                            <div
                                className="absolute top-0 left-0 h-full bg-purple-500 rounded-full transition-all group-hover:bg-purple-400"
                                style={{ width: `${progress}%` }}
                            />
                            {/* Playhead */}
                            <div
                                className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                                style={{ left: `calc(${progress}% - 6px)` }}
                            />
                        </div>

                        {/* Controls Row */}
                        <div className="flex items-center justify-between gap-4">
                            {/* Left: Playback controls */}
                            <div className="flex items-center gap-2">
                                {/* 15s Rewind */}
                                <button
                                    onClick={() => handleSkip(-15)}
                                    className="text-gray-400 hover:text-white transition-colors p-2"
                                    title="Rewind 15 seconds"
                                >
                                    <SkipBack className="w-5 h-5" />
                                    <span className="text-xs">15</span>
                                </button>

                                {/* Play/Pause */}
                                <button
                                    onClick={handlePlayPause}
                                    className="bg-purple-500 hover:bg-purple-600 text-white rounded-full p-2.5 transition-colors"
                                >
                                    {isPlaying ? (
                                        <Pause className="w-5 h-5" />
                                    ) : (
                                        <Play className="w-5 h-5 fill-current" />
                                    )}
                                </button>

                                {/* 15s Forward */}
                                <button
                                    onClick={() => handleSkip(15)}
                                    className="text-gray-400 hover:text-white transition-colors p-2"
                                    title="Forward 15 seconds"
                                >
                                    <SkipForward className="w-5 h-5" />
                                    <span className="text-xs">15</span>
                                </button>
                            </div>

                            {/* Center: Playback speed */}
                            <div className="flex items-center gap-1">
                                {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(
                                    (speed) => (
                                        <button
                                            key={speed}
                                            onClick={() =>
                                                handleSpeedChange(speed)
                                            }
                                            className={cn(
                                                "px-2 py-1 text-xs rounded transition-colors",
                                                playbackSpeed === speed
                                                    ? "bg-purple-500 text-white"
                                                    : "text-gray-400 hover:text-white"
                                            )}
                                        >
                                            {speed}x
                                        </button>
                                    )
                                )}
                            </div>

                            {/* Right: Volume control */}
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handleMuteToggle}
                                    className="text-gray-400 hover:text-white"
                                >
                                    {isMuted || volume === 0 ? (
                                        <VolumeX className="w-5 h-5" />
                                    ) : (
                                        <Volume2 className="w-5 h-5" />
                                    )}
                                </button>
                                <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={volume}
                                    onChange={(e) =>
                                        handleVolumeChange(
                                            parseFloat(e.target.value)
                                        )
                                    }
                                    className="w-20 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer slider"
                                />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Remove Progress Confirmation Modal */}
            <Modal
                isOpen={showConfirmModal}
                onClose={() => setShowConfirmModal(false)}
                title="Remove Progress"
                footer={
                    <>
                        <Button
                            variant="secondary"
                            onClick={() => setShowConfirmModal(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleRemoveProgress}
                            className="bg-red-600 hover:bg-red-700"
                        >
                            Remove Progress
                        </Button>
                    </>
                }
            >
                <p className="text-gray-300">
                    Remove your progress for this episode? This will reset your
                    position to the beginning.
                </p>
                <p className="text-gray-400 text-sm mt-2">
                    This action cannot be undone.
                </p>
            </Modal>
        </>
    );
}
