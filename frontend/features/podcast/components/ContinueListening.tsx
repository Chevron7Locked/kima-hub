"use client";

import { Play, Pause } from "lucide-react";
import { Episode } from "../types";
import { formatDuration } from "@/lib/format";
import { formatDate } from "../utils";
import { SectionHeader } from "@/components/ui/SectionHeader";

interface ContinueListeningProps {
    inProgressEpisodes: Episode[];
    episodes: Episode[];
    isEpisodePlaying: (episodeId: string) => boolean;
    isPlaying: boolean;
    onPlayEpisode: (episode: Episode) => void;
    onPlayPause: (episode: Episode) => void;
}

export function ContinueListening({
    inProgressEpisodes,
    episodes,
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

    const currentIndex = episodes.findIndex(
        (ep) => ep.id === recentEpisode.id
    );
    const previousEpisode =
        currentIndex > 0 ? episodes[currentIndex - 1] : null;
    const nextEpisode =
        currentIndex < episodes.length - 1
            ? episodes[currentIndex + 1]
            : null;

    const isCurrentPlaying = isEpisodePlaying(recentEpisode.id);

    return (
        <section>
            <SectionHeader title="Continue Listening" type="podcast" />

            <div className="space-y-0.5">
                {previousEpisode && (
                    <AdjacentEpisode
                        episode={previousEpisode}
                        which="previous"
                        delayMs={0}
                        onPlay={onPlayEpisode}
                    />
                )}

                <div
                    className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/5 transition-all cursor-pointer animate-rise"
                    style={{ animationDelay: "45ms" }}
                    onClick={() => onPlayPause(recentEpisode)}
                >
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onPlayPause(recentEpisode);
                        }}
                        aria-label={isCurrentPlaying && isPlaying ? "pause" : "play"}
                        className="w-10 h-10 rounded-lg bg-[var(--color-brand)] hover:bg-[var(--color-brand-hover)] flex items-center justify-center shrink-0"
                    >
                        {isCurrentPlaying && isPlaying ? (
                            <Pause className="w-4 h-4 text-black" />
                        ) : (
                            <Play className="w-4 h-4 text-black ml-0.5" fill="black" />
                        )}
                    </button>
                    <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-[var(--color-brand)] truncate text-sm tracking-tight">
                            {recentEpisode.title}
                        </h3>
                        <div className="flex items-center gap-3 mt-0.5 text-xs tabular-nums text-[var(--text-muted)]">
                            <span>{formatDuration(recentEpisode.duration)}</span>
                            <span className="text-[var(--text-muted)]">|</span>
                            <span>{formatDate(recentEpisode.publishedAt)}</span>
                        </div>
                        {recentEpisode.progress && (
                            <div className="mt-2">
                                <div className="flex items-center gap-2">
                                    <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-[var(--color-brand)] rounded-full transition-all"
                                            style={{
                                                width: `${recentEpisode.progress.progress}%`,
                                            }}
                                        />
                                    </div>
                                    <span className="text-micro tabular-nums text-[var(--color-brand)]">
                                        {Math.floor(recentEpisode.progress.progress)}%
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {nextEpisode && (
                    <AdjacentEpisode episode={nextEpisode} which="next" delayMs={90} onPlay={onPlayEpisode} />
                )}
            </div>
        </section>
    );
}

/** The episode before or after the one in progress, as one control. */
function AdjacentEpisode({ episode, which, delayMs, onPlay }: {
    episode: Episode;
    which: "previous" | "next";
    delayMs: number;
    onPlay: (episode: Episode) => void;
}) {
    return (
        <button
            type="button"
            onClick={() => onPlay(episode)}
            aria-label={`play the ${which} episode, ${episode.title}`}
            className="w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg border border-transparent hover:bg-white/[0.02] hover:border-white/5 transition-all opacity-40 hover:opacity-60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 animate-rise"
            style={{ animationDelay: `${delayMs}ms` }}
        >
            <span className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                <Play className="w-3 h-3 text-[var(--text-secondary)]" />
            </span>
            <span className="flex-1 min-w-0">
                <span className="block font-bold text-[var(--text-primary)] truncate text-sm tracking-tight">
                    {episode.title}
                </span>
                <span className="block text-xs text-[var(--text-muted)]">{which} episode</span>
            </span>
        </button>
    );
}
