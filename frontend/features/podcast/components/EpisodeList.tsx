"use client";

import { Play, Pause, Check, ArrowUpDown, CheckCircle } from "lucide-react";
import { cn } from "@/utils/cn";
import { Podcast, Episode } from "../types";
import { formatDuration, formatDate } from "../utils";

interface EpisodeListProps {
    podcast: Podcast;
    episodes: Episode[];
    sortOrder: "newest" | "oldest";
    onSortOrderChange: (order: "newest" | "oldest") => void;
    isEpisodePlaying: (episodeId: string) => boolean;
    isPlaying: boolean;
    onPlayPause: (episode: Episode) => void;
    onPlay: (episode: Episode) => void;
    onMarkComplete?: (episodeId: string, duration: number) => void;
}

export function EpisodeList({
    podcast,
    episodes,
    sortOrder,
    onSortOrderChange,
    isEpisodePlaying,
    isPlaying,
    onPlayPause,
    onPlay,
    onMarkComplete,
}: EpisodeListProps) {
    return (
        <section>
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-white">All Episodes</h2>
                <button
                    onClick={() =>
                        onSortOrderChange(
                            sortOrder === "newest" ? "oldest" : "newest"
                        )
                    }
                    className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-sm text-white/70 hover:text-white transition-all"
                >
                    <ArrowUpDown className="w-4 h-4" />
                    {sortOrder === "newest" ? "Newest First" : "Oldest First"}
                </button>
            </div>

            <div className="space-y-1">
                {episodes.map((episode, index) => {
                    const isCurrentEpisode = isEpisodePlaying(episode.id);
                    const isInProgress =
                        episode.progress &&
                        !episode.progress.isFinished &&
                        episode.progress.currentTime > 0;

                    return (
                        <div
                            key={episode.id}
                            className={cn(
                                "group relative rounded-md transition-all",
                                isCurrentEpisode ? "bg-white/10" : "hover:bg-white/5"
                            )}
                        >
                            {/* Progress bar at the bottom */}
                            {episode.progress && episode.progress.progress > 0 && (
                                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-[#ecb200]/60 transition-all"
                                        style={{
                                            width: `${episode.progress.progress}%`,
                                        }}
                                    />
                                </div>
                            )}

                            <div
                                onClick={() => {
                                    if (!isCurrentEpisode) {
                                        onPlay(episode);
                                    }
                                }}
                                className="flex items-center gap-4 px-3 py-3 cursor-pointer"
                            >
                                {/* Number / Play/Pause Icon */}
                                <div className="w-8 flex items-center justify-center shrink-0">
                                    {episode.progress?.isFinished ? (
                                        <Check className="w-4 h-4 text-green-400" />
                                    ) : (
                                        <>
                                            <span
                                                className={cn(
                                                    "text-sm",
                                                    isCurrentEpisode && isPlaying
                                                        ? "hidden"
                                                        : "group-hover:hidden",
                                                    isCurrentEpisode
                                                        ? "text-[#ecb200] font-bold"
                                                        : "text-white/40"
                                                )}
                                            >
                                                {index + 1}
                                            </span>
                                            {isCurrentEpisode && isPlaying ? (
                                                <Pause
                                                    className="w-4 h-4 text-[#ecb200] cursor-pointer"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onPlayPause(episode);
                                                    }}
                                                />
                                            ) : (
                                                <Play
                                                    className={cn(
                                                        "w-4 h-4 cursor-pointer",
                                                        isCurrentEpisode
                                                            ? "text-[#ecb200]"
                                                            : "text-white hidden group-hover:block"
                                                    )}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onPlayPause(episode);
                                                    }}
                                                />
                                            )}
                                        </>
                                    )}
                                </div>

                                {/* Episode Info */}
                                <div className="flex-1 min-w-0">
                                    <h3
                                        className={cn(
                                            "font-medium truncate text-sm",
                                            isCurrentEpisode
                                                ? "text-[#ecb200]"
                                                : "text-white"
                                        )}
                                    >
                                        {episode.title}
                                    </h3>
                                    <div className="flex items-center gap-2 text-xs text-white/50 mt-0.5">
                                        <span>{formatDate(episode.publishedAt)}</span>
                                        {episode.season && (
                                            <>
                                                <span>•</span>
                                                <span>S{episode.season}</span>
                                            </>
                                        )}
                                        {episode.episodeNumber && (
                                            <>
                                                <span>•</span>
                                                <span>E{episode.episodeNumber}</span>
                                            </>
                                        )}
                                        {episode.progress?.isFinished && (
                                            <>
                                                <span>•</span>
                                                <span className="text-green-400">Finished</span>
                                            </>
                                        )}
                                        {isInProgress && episode.progress && (
                                            <>
                                                <span>•</span>
                                                <span className="text-[#ecb200]">
                                                    {Math.floor(episode.progress.progress)}%
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Duration */}
                                <span className="text-xs text-white/40 shrink-0">
                                    {formatDuration(episode.duration)}
                                </span>

                                {/* Complete Button - visible on hover for incomplete episodes */}
                                {onMarkComplete && !episode.progress?.isFinished && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onMarkComplete(episode.id, episode.duration);
                                        }}
                                        className="opacity-0 group-hover:opacity-100 transition-opacity ml-2 p-1.5 rounded-full hover:bg-white/10"
                                        title="Mark as complete"
                                    >
                                        <CheckCircle className="w-4 h-4 text-white/60 hover:text-green-400" />
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
