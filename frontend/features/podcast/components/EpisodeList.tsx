"use client";

/**
 * The episode shelf: filter by what you've heard, grouped by season (or by
 * month when a feed has no seasons). Progress never exceeds 100% and lives on
 * the artwork, so a row says "played 62%" once, not twice.
 */

import { useMemo, useState } from "react";
import { Play, Pause, Check, ArrowUpDown, CheckCircle, ChevronDown, ChevronUp, Disc3 } from "lucide-react";
import DOMPurify from "dompurify";
import { cn } from "@/lib/cn";
import { Episode } from "../types";
import { formatDuration } from "@/lib/format";
import { formatDate } from "../utils";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { CachedImage } from "@/components/ui/CachedImage";
import { coverArtUrl } from "@/lib/cover-art";
import { cascadeStyle } from "@/lib/motion";
import { GradientSpinner } from "@/components/ui/GradientSpinner";

/** Feeds advertise durations that drift; a listened-past-the-end row shows 100, not 107. */
const clampPercent = (p: number) => Math.min(100, Math.max(0, Math.round(p)));

type Filter = "all" | "unplayed" | "inProgress" | "finished";

function listenState(ep: Episode): Filter {
    if (ep.progress?.isFinished) return "finished";
    if (ep.progress && ep.progress.currentTime > 0) return "inProgress";
    return "unplayed";
}

function EpisodeRow({
    episode,
    index,
    fallbackCoverUrl,
    isCurrentEpisode,
    isPlaying,
    onPlayPause,
    onMarkComplete,
}: {
    episode: Episode;
    index: number;
    fallbackCoverUrl?: string;
    isCurrentEpisode: boolean;
    isPlaying: boolean;
    onPlayPause: (episode: Episode) => void;
    onMarkComplete?: (episodeId: string, duration: number) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const percent = episode.progress ? clampPercent(episode.progress.progress) : 0;
    const finished = Boolean(episode.progress?.isFinished);
    const hasDescription = Boolean(episode.description?.trim());
    // Through the cover proxy like every other image: the page's policy lets only a few image hosts load directly.
    const cover = coverArtUrl(episode.imageUrl || fallbackCoverUrl, 112);

    const metaBits = [
        formatDate(episode.publishedAt),
        formatDuration(episode.duration),
        episode.season != null ? `S${episode.season} E${episode.episodeNumber ?? ""}`.trimEnd() : undefined,
    ].filter(Boolean) as string[];

    return (
        <div
            data-episode-row
            className={cn(
                "group rounded-xl transition-colors animate-rise [animation-delay:calc(var(--i)*var(--stagger))]",
                isCurrentEpisode ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
            )}
            style={{ "--i": index } as React.CSSProperties}
        >
            <div className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5">
                {/* Artwork carries play and progress; the tap target is the whole tile. */}
                <button
                    type="button"
                    onClick={() => onPlayPause(episode)}
                    aria-label={`${isCurrentEpisode && isPlaying ? "Pause" : "Play"} ${episode.title}`}
                    className="relative w-14 h-14 shrink-0 rounded-lg overflow-hidden bg-[var(--color-type-podcast)]/20 border border-white/10 focus-visible:outline-2 focus-visible:outline-brand"
                >
                    {cover ? (
                        <CachedImage src={cover} alt="" sizes="56px" fill className="object-cover" />
                    ) : (
                        <Disc3 className="absolute inset-0 m-auto w-6 h-6 text-white/40" />
                    )}
                    <span
                        className={cn(
                            "absolute inset-0 flex items-center justify-center bg-black/45 transition-opacity",
                            isCurrentEpisode ? "opacity-100" : "opacity-0 group-hover:opacity-100 touch-reveal",
                        )}
                    >
                        {isCurrentEpisode && isPlaying ? (
                            <Pause className="w-5 h-5 text-white" />
                        ) : (
                            <Play className="w-5 h-5 text-white fill-current ml-0.5" />
                        )}
                    </span>
                    {percent > 0 && !finished && (
                        <span className="absolute bottom-0 left-0 right-0 h-[3px] bg-black/60">
                            <span className="block h-full bg-brand" style={{ width: `${percent}%` }} />
                        </span>
                    )}
                </button>

                <button
                    type="button"
                    onClick={() => setExpanded((e) => !e)}
                    aria-expanded={expanded}
                    className="min-w-0 text-left rounded-md focus-visible:outline-2 focus-visible:outline-brand"
                >
                    <h3
                        className={cn(
                            "text-sm font-semibold leading-snug tracking-tight line-clamp-2",
                            isCurrentEpisode ? "text-brand" : "text-white",
                        )}
                    >
                        {episode.title}
                    </h3>
                    <p className="mt-0.5 text-xs tabular-nums text-[var(--text-muted)] truncate">
                        {metaBits.join(" · ")}
                        {finished && (
                            <span className="ml-2 inline-flex items-center gap-1 align-middle text-[var(--color-success)]">
                                <Check className="w-3 h-3" />
                                Finished
                            </span>
                        )}
                        {!finished && percent > 0 && (
                            <span className="ml-2 align-middle text-brand">{percent}%</span>
                        )}
                    </p>
                </button>

                <div className="flex items-center gap-1 shrink-0">
                    {onMarkComplete && !finished && (
                        <button
                            type="button"
                            onClick={() => onMarkComplete(episode.id, episode.duration)}
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-2 rounded-lg hover:bg-white/10 text-[var(--text-muted)] hover:text-white transition-all touch-reveal"
                            title="mark as complete"
                            aria-label={`Mark ${episode.title} as complete`}
                        >
                            <CheckCircle className="w-4 h-4" />
                        </button>
                    )}
                    {hasDescription && (
                        <button
                            type="button"
                            onClick={() => setExpanded((e) => !e)}
                            aria-label={expanded ? "Hide description" : "Show description"}
                            className="p-2 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/10 transition-colors"
                        >
                            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                    )}
                </div>
            </div>

            {expanded && hasDescription && (
                <div className="px-3 pb-3 pl-[80px]">
                    <div
                        className="text-xs leading-relaxed text-[var(--text-secondary)] max-w-3xl"
                        dangerouslySetInnerHTML={{
                            __html: DOMPurify.sanitize(episode.description || ""),
                        }}
                    />
                </div>
            )}
        </div>
    );
}

interface EpisodeListProps {
    episodes: Episode[];
    sortOrder: "newest" | "oldest";
    onSortOrderChange: (order: "newest" | "oldest") => void;
    isEpisodePlaying: (episodeId: string) => boolean;
    isPlaying: boolean;
    onPlayPause: (episode: Episode) => void;
    onMarkComplete?: (episodeId: string, duration: number) => void;
    fallbackCoverUrl?: string;
    /** Every episode the podcast has, loaded or not. */
    total: number;
    /** The list is being fetched again in a new order. */
    updating?: boolean;
    onLoadMore?: () => void;
    loadingMore?: boolean;
}

export function EpisodeList({
    episodes,
    sortOrder,
    onSortOrderChange,
    isEpisodePlaying,
    isPlaying,
    onPlayPause,
    onMarkComplete,
    fallbackCoverUrl,
    total,
    updating,
    onLoadMore,
    loadingMore,
}: EpisodeListProps) {
    const [filter, setFilter] = useState<Filter>("all");

    // Listen-state counts cover every episode only once all are loaded.
    const allLoaded = !onLoadMore;
    const counts = useMemo(() => {
        const c = { all: total, unplayed: 0, inProgress: 0, finished: 0 };
        for (const ep of episodes) c[listenState(ep)] += 1;
        return c;
    }, [episodes, total]);

    const groups = useMemo(() => {
        const visible = episodes.filter((ep) => filter === "all" || listenState(ep) === filter);
        const map = new Map<string, Episode[]>();
        for (const ep of visible) {
            const key =
                ep.season != null
                    ? `Season ${ep.season}`
                    : new Date(ep.publishedAt).toLocaleDateString("en", { month: "long", year: "numeric" });
            (map.get(key) ?? map.set(key, []).get(key)!).push(ep);
        }
        return [...map.entries()];
    }, [episodes, filter]);

    let runningIndex = 0; // cascade position across groups, so the animation window spans the page

    return (
        <section>
            <SectionHeader
                title="Episodes"
                type="podcast"
                action={
                    <Button
                        size="sm"
                        onClick={() => onSortOrderChange(sortOrder === "newest" ? "oldest" : "newest")}
                    >
                        <ArrowUpDown className="w-3.5 h-3.5" />
                        {sortOrder === "newest" ? "Newest" : "Oldest"}
                    </Button>
                }
            />

            <div className="flex flex-wrap gap-1.5 px-3 pb-3" role="tablist" aria-label="Filter episodes">
                {(
                    [
                        ["all", "All"],
                        ["unplayed", "Unplayed"],
                        ["inProgress", "In progress"],
                        ["finished", "Finished"],
                    ] as [Filter, string][]
                ).map(([key, label]) => (
                    <button
                        key={key}
                        role="tab"
                        aria-selected={filter === key}
                        onClick={() => setFilter(key)}
                        className={cn(
                            "px-3 py-1.5 rounded-full text-xs tabular-nums border transition-colors",
                            filter === key
                                ? "bg-brand/15 border-brand/40 text-brand"
                                : "bg-white/[0.03] border-white/10 text-[var(--text-secondary)] hover:text-white hover:border-white/20",
                        )}
                    >
                        {label}
                        {(key === "all" || allLoaded) && <span className="ml-1.5 opacity-60">{counts[key]}</span>}
                    </button>
                ))}
            </div>

            {updating ? (
                <div className="flex justify-center py-8" aria-busy="true">
                    <GradientSpinner size="sm" />
                </div>
            ) : groups.length === 0 ? (
                <p className="px-3 py-8 text-sm text-[var(--text-muted)]">
                    {allLoaded ? "Nothing in this filter." : "Nothing in this filter among the episodes loaded so far."}
                </p>
            ) : (
                <div style={cascadeStyle(Math.min(groups.reduce((n, [, g]) => n + g.length, 0), 40))}>
                    {groups.map(([label, group]) => (
                        <div key={label} className="pb-2">
                            <div className="sticky top-0 z-[5] flex items-baseline gap-2 px-3 py-2 bg-[var(--bg-secondary)]/95 backdrop-blur-sm">
                                <h4 className="text-[0.6875rem] tracking-[0.12em] text-[var(--text-muted)]">
                                    {label}
                                </h4>
                                <span className="text-[0.6875rem] tabular-nums text-[var(--text-muted)] opacity-60">
                                    {group.length}
                                </span>
                            </div>
                            <div className="space-y-0.5">
                                {group.map((episode) => (
                                    <EpisodeRow
                                        key={episode.id}
                                        episode={episode}
                                        index={runningIndex++}
                                        fallbackCoverUrl={fallbackCoverUrl}
                                        isCurrentEpisode={isEpisodePlaying(episode.id)}
                                        isPlaying={isPlaying}
                                        onPlayPause={onPlayPause}
                                        onMarkComplete={onMarkComplete}
                                    />
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {onLoadMore && !updating && (
                <div className="flex justify-center px-3 pt-2 pb-4">
                    <Button size="sm" onClick={onLoadMore} disabled={loadingMore}>
                        {loadingMore ? "Loading…" : `Show more (${total - episodes.length} left)`}
                    </Button>
                </div>
            )}
        </section>
    );
}
