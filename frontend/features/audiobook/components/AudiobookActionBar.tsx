"use client";

import { Play, Pause, RotateCcw, CheckCircle } from "lucide-react";
import type { Audiobook } from "../types";

interface AudiobookActionBarProps {
    audiobook: Audiobook;
    isThisBookPlaying?: boolean;
    isPlaying?: boolean;
    currentTime?: number;
    onPlayPause?: () => void;
    onResetProgress: () => void;
    onMarkAsCompleted: () => void;
    formatTime?: (seconds: number) => string;
}

export function AudiobookActionBar({
    audiobook,
    isThisBookPlaying = false,
    isPlaying = false,
    currentTime = 0,
    onPlayPause,
    onResetProgress,
    onMarkAsCompleted,
    formatTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
}: AudiobookActionBarProps) {
    const hasProgress = audiobook.progress && audiobook.progress.progress > 0;
    const isFinished = audiobook.progress?.isFinished;
    const showingPause = isThisBookPlaying && isPlaying;

    return (
        <div className="flex items-center gap-4">
            {/* Play/Pause Button */}
            {onPlayPause && (
                <button
                    onClick={onPlayPause}
                    className="w-10 h-10 rounded-lg bg-[#f59e0b] hover:bg-[#d97706] transition-all flex items-center justify-center hover:scale-105 active:scale-95"
                    title={showingPause ? "Pause" : (hasProgress && !isFinished ? "Resume" : "Play")}
                >
                    {showingPause ? (
                        <Pause className="w-4 h-4 text-black" />
                    ) : (
                        <Play className="w-4 h-4 text-black ml-0.5" fill="black" />
                    )}
                </button>
            )}

            {/* Progress indicator */}
            {hasProgress && !isFinished && (
                <div className="hidden sm:flex items-center gap-3">
                    <div className="text-xs tabular-nums text-[var(--text-secondary)]">
                        <span>
                            {formatTime(isThisBookPlaying ? currentTime : audiobook.progress!.currentTime)}
                        </span>
                        <span className="text-[var(--text-muted)] mx-1">/</span>
                        <span>{formatTime(audiobook.duration)}</span>
                    </div>
                    <div className="w-24 h-1 bg-white/10 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-[#f59e0b] rounded-full transition-all"
                            style={{
                                width: `${isThisBookPlaying ? (currentTime / audiobook.duration) * 100 : audiobook.progress!.progress}%`,
                            }}
                        />
                    </div>
                </div>
            )}

            <div className="flex-1" />

            {/* Action buttons */}
            <div className="flex items-center gap-2">
                {hasProgress && !isFinished && (
                    <>
                        <button
                            onClick={onResetProgress}
                            className="p-2 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-all"
                            title="Reset progress"
                        >
                            <RotateCcw className="w-4 h-4" />
                        </button>
                        <button
                            onClick={onMarkAsCompleted}
                            className="p-2 rounded-lg text-green-400/60 hover:text-green-400 hover:bg-green-500/10 border border-transparent hover:border-green-500/20 transition-all"
                            title="Mark as completed"
                        >
                            <CheckCircle className="w-4 h-4" />
                        </button>
                    </>
                )}

                {isFinished && (
                    <button
                        onClick={onResetProgress}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 hover:text-white border border-white/10 hover:border-white/20 transition-all"
                        title="Listen again"
                    >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Listen Again</span>
                    </button>
                )}
            </div>
        </div>
    );
}
