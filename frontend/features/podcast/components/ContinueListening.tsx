"use client";

import { Play, Pause } from "lucide-react";
import { Podcast, Episode } from "../types";
import { formatDuration } from "@/utils/formatTime";
import { formatDate } from "../utils";

interface ContinueListeningProps {
    podcast: Podcast;
    inProgressEpisodes: Episode[];
    sortedEpisodes: Episode[];
    isEpisodePlaying: (episodeId: string) => boolean;
    isPlaying: boolean;
    onPlayEpisode: (episode: Episode) => void;
    onPlayPause: (episode: Episode) => void;
}

export function ContinueListening({
    podcast: _podcast,
    inProgressEpisodes,
    sortedEpisodes,
    isEpisodePlaying,
    isPlaying,
    onPlayEpisode,
    onPlayPause,
}: ContinueListeningProps) {
    if (inProgressEpisodes.length === 0) {
        return null;
    }

    const recentEpisode = inProgressEpisodes.reduce((prev, current) => {
        const prevDate = new Date(prev.progress?.lastPlayedAt || 0);
        const currentDate = new Date(current.progress?.lastPlayedAt || 0);
        return currentDate > prevDate ? current : prev;
    });

    const currentIndex = sortedEpisodes.findIndex(
        (ep) => ep.id === recentEpisode.id
    );
    const previousEpisode =
        currentIndex > 0 ? sortedEpisodes[currentIndex - 1] : null;
    const nextEpisode =
        currentIndex < sortedEpisodes.length - 1
            ? sortedEpisodes[currentIndex + 1]
            : null;

    const isCurrentPlaying = isEpisodePlaying(recentEpisode.id);

    return (
        <section>
            <div className="flex items-center gap-3 mb-6">
                <span className="w-1 h-8 bg-gradient-to-b from-[#3b82f6] to-[#2563eb] rounded-full shrink-0" />
                <h2 className="text-2xl font-bold tracking-tight">Continue Listening</h2>
                <span className="flex-1 border-t border-white/10" />
            </div>

            <div className="space-y-1.5">
                {/* Previous Episode */}
                {previousEpisode && (
                    <div
                        className="flex items-center gap-3 p-3 rounded-lg border border-transparent hover:border-white/5 hover:bg-white/[0.02] transition-all cursor-pointer opacity-40 hover:opacity-60"
                        onClick={() => onPlayEpisode(previousEpisode)}
                    >
                        <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                            <Play className="w-3 h-3 text-[var(--text-secondary)]" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 className="font-bold text-[var(--text-primary)] truncate text-sm tracking-tight">
                                {previousEpisode.title}
                            </h3>
                            <p className="text-xs text-[var(--text-muted)]">Previous episode</p>
                        </div>
                    </div>
                )}

                {/* Current Episode */}
                <div
                    className="flex items-center gap-4 p-4 rounded-lg bg-[var(--bg-primary)] border-2 border-[#3b82f6]/30 hover:border-[#3b82f6]/50 transition-all cursor-pointer"
                    onClick={() => onPlayPause(recentEpisode)}
                >
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onPlayPause(recentEpisode);
                        }}
                        className="w-12 h-12 rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] hover:scale-105 transition-all flex items-center justify-center shrink-0"
                    >
                        {isCurrentPlaying && isPlaying ? (
                            <Pause className="w-5 h-5 text-white" />
                        ) : (
                            <Play className="w-5 h-5 text-white ml-0.5" fill="white" />
                        )}
                    </button>
                    <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-white truncate tracking-tight">
                            {recentEpisode.title}
                        </h3>
                        <div className="flex items-center gap-3 mt-1 text-xs tabular-nums text-[var(--text-muted)]">
                            <span>{formatDuration(recentEpisode.duration)}</span>
                            <span className="text-[var(--text-muted)]">|</span>
                            <span>{formatDate(recentEpisode.publishedAt)}</span>
                        </div>
                        {/* Progress Bar */}
                        {recentEpisode.progress && (
                            <div className="mt-2">
                                <div className="flex items-center gap-2">
                                    <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-[#3b82f6] rounded-full transition-all"
                                            style={{
                                                width: `${recentEpisode.progress.progress}%`,
                                            }}
                                        />
                                    </div>
                                    <span className="text-micro tabular-nums text-[#3b82f6]">
                                        {Math.floor(recentEpisode.progress.progress)}%
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Next Episode */}
                {nextEpisode && (
                    <div
                        className="flex items-center gap-3 p-3 rounded-lg border border-transparent hover:border-white/5 hover:bg-white/[0.02] transition-all cursor-pointer opacity-40 hover:opacity-60"
                        onClick={() => onPlayEpisode(nextEpisode)}
                    >
                        <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                            <Play className="w-3 h-3 text-[var(--text-secondary)]" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 className="font-bold text-[var(--text-primary)] truncate text-sm tracking-tight">
                                {nextEpisode.title}
                            </h3>
                            <p className="text-xs text-[var(--text-muted)]">Next episode</p>
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}
