"use client";

import { useState, useRef } from "react";
import { Play, Pause, Check, ArrowUpDown, CheckCircle, ChevronDown, ChevronUp } from "lucide-react";
import DOMPurify from "dompurify";
import { cn } from "@/utils/cn";
import { Podcast, Episode } from "../types";
import { formatDuration } from "@/utils/formatTime";
import { formatDate } from "../utils";

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

function EpisodeRow({
    episode,
    index,
    isCurrentEpisode,
    isPlaying,
    onPlayPause,
    onPlay,
    onMarkComplete,
}: {
    episode: Episode;
    index: number;
    isCurrentEpisode: boolean;
    isPlaying: boolean;
    onPlayPause: (episode: Episode) => void;
    onPlay: (episode: Episode) => void;
    onMarkComplete?: (episodeId: string, duration: number) => void;
}) {
    const lastTapRef = useRef<{ time: number; index: number }>({ time: 0, index: -1 });
    const [expanded, setExpanded] = useState(false);
    const isInProgress =
        episode.progress &&
        !episode.progress.isFinished &&
        episode.progress.currentTime > 0;
    const hasDescription = episode.description && episode.description.trim().length > 0;

    return (
        <div
            className={cn(
                "group relative rounded-lg transition-all",
                isCurrentEpisode
                    ? "bg-white/5 border border-[#3b82f6]/30"
                    : "border border-transparent hover:bg-white/[0.03] hover:border-white/5"
            )}
        >
            {/* Progress bar */}
            {episode.progress && episode.progress.progress > 0 && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-[#3b82f6]/60 transition-all"
                        style={{
                            width: `${episode.progress.progress}%`,
                        }}
                    />
                </div>
            )}

            <div
                data-track-index={index}
                onDoubleClick={() => {
                    if (!isCurrentEpisode) {
                        onPlay(episode);
                    }
                }}
                onTouchEnd={(e) => {
                    const idx = Number(e.currentTarget.dataset.trackIndex);
                    if (isNaN(idx)) return;
                    const now = Date.now();
                    if (now - lastTapRef.current.time < 300 && lastTapRef.current.index === idx) {
                        if (!isCurrentEpisode) {
                            onPlay(episode);
                        }
                        lastTapRef.current = { time: 0, index: -1 };
                    } else {
                        lastTapRef.current = { time: now, index: idx };
                    }
                }}
                className="flex items-center gap-4 px-3 py-3 cursor-pointer touch-manipulation"
            >
                {/* Number / Play/Pause */}
                <div className="w-8 flex items-center justify-center shrink-0">
                    {episode.progress?.isFinished ? (
                        <Check className="w-4 h-4 text-green-400" />
                    ) : (
                        <>
                            <span
                                className={cn(
                                    "text-xs font-mono",
                                    isCurrentEpisode && isPlaying
                                        ? "hidden"
                                        : "group-hover:hidden",
                                    isCurrentEpisode
                                        ? "text-[#3b82f6] font-bold"
                                        : "text-white/30"
                                )}
                            >
                                {index + 1}
                            </span>
                            {isCurrentEpisode && isPlaying ? (
                                <Pause
                                    className="w-4 h-4 text-[#3b82f6] cursor-pointer"
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
                                            ? "text-[#3b82f6]"
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
                            "font-bold truncate text-sm tracking-tight",
                            isCurrentEpisode
                                ? "text-[#3b82f6]"
                                : "text-white"
                        )}
                    >
                        {episode.title}
                    </h3>
                    <div className="flex items-center gap-2 text-micro font-mono text-white/40 uppercase tracking-wider mt-0.5">
                        <span>{formatDate(episode.publishedAt)}</span>
                        {episode.season && (
                            <>
                                <span className="text-white/20">|</span>
                                <span>S{episode.season}</span>
                            </>
                        )}
                        {episode.episodeNumber && (
                            <>
                                <span className="text-white/20">|</span>
                                <span>E{episode.episodeNumber}</span>
                            </>
                        )}
                        {episode.progress?.isFinished && (
                            <>
                                <span className="text-white/20">|</span>
                                <span className="text-green-400">Finished</span>
                            </>
                        )}
                        {isInProgress && episode.progress && (
                            <>
                                <span className="text-white/20">|</span>
                                <span className="text-[#3b82f6]">
                                    {Math.floor(episode.progress.progress)}%
                                </span>
                            </>
                        )}
                    </div>
                </div>

                {/* Duration */}
                <span className="text-micro font-mono text-white/30 shrink-0 uppercase tracking-wider">
                    {formatDuration(episode.duration)}
                </span>

                {/* Expand description */}
                {hasDescription && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            setExpanded(!expanded);
                        }}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-white/30 hover:text-white/60 transition-all shrink-0"
                    >
                        {expanded ? (
                            <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                            <ChevronDown className="w-3.5 h-3.5" />
                        )}
                    </button>
                )}

                {/* Complete Button */}
                {onMarkComplete && !episode.progress?.isFinished && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onMarkComplete(episode.id, episode.duration);
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg hover:bg-white/10"
                        title="Mark as complete"
                    >
                        <CheckCircle className="w-4 h-4 text-white/40 hover:text-green-400 transition-colors" />
                    </button>
                )}
            </div>

            {/* Expanded description */}
            {expanded && hasDescription && (
                <div className="px-3 pb-3 pl-[52px]">
                    <div
                        className="text-xs text-white/40 leading-relaxed max-w-3xl line-clamp-6 [&_a]:text-[#3b82f6] [&_a]:no-underline [&_a:hover]:underline"
                        dangerouslySetInnerHTML={{
                            __html: DOMPurify.sanitize(episode.description || ""),
                        }}
                    />
                </div>
            )}
        </div>
    );
}

export function EpisodeList({
    podcast: _podcast,
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
            <div className="flex items-center gap-3 mb-6">
                <span className="w-1 h-8 bg-gradient-to-b from-[#3b82f6] to-[#2563eb] rounded-full shrink-0" />
                <h2 className="text-2xl font-bold tracking-tight uppercase">All Episodes</h2>
                <span className="text-xs font-mono text-[#3b82f6]">
                    {episodes.length}
                </span>
                <span className="flex-1 border-t border-white/10" />
                <button
                    onClick={() =>
                        onSortOrderChange(
                            sortOrder === "newest" ? "oldest" : "newest"
                        )
                    }
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-xs font-mono uppercase tracking-wider text-white/50 hover:text-white transition-all"
                >
                    <ArrowUpDown className="w-3.5 h-3.5" />
                    {sortOrder === "newest" ? "Newest" : "Oldest"}
                </button>
            </div>

            <div className="space-y-0.5">
                {episodes.map((episode, index) => (
                    <EpisodeRow
                        key={episode.id}
                        episode={episode}
                        index={index}
                        isCurrentEpisode={isEpisodePlaying(episode.id)}
                        isPlaying={isPlaying}
                        onPlayPause={onPlayPause}
                        onPlay={onPlay}
                        onMarkComplete={onMarkComplete}
                    />
                ))}
            </div>
        </section>
    );
}
