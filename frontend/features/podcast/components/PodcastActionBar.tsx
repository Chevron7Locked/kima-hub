"use client";

import { ExternalLink, Trash2, Plus, Play, Pause, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { formatDuration } from "@/lib/format";

interface PodcastActionBarProps {
    isSubscribed: boolean;
    feedUrl?: string;
    isSubscribing: boolean;
    showDeleteConfirm: boolean;
    onSubscribe: () => void;
    onRemove: () => void;
    onShowDeleteConfirm: (show: boolean) => void;
    onPlayLatest?: () => void;
    isPlayingPodcast?: boolean;
    onPause?: () => void;
    onRefresh?: () => Promise<unknown>;
    isRefreshing?: boolean;
    /** The show's first episode, offered before following. */
    snippet?: { title: string; duration: number } | null;
    onToggleSnippet?: () => void;
    snippetPlaying?: boolean;
}

export function PodcastActionBar({
    isSubscribed,
    feedUrl,
    isSubscribing,
    showDeleteConfirm,
    onSubscribe,
    onRemove,
    onShowDeleteConfirm,
    onPlayLatest,
    isPlayingPodcast,
    onPause,
    onRefresh,
    isRefreshing,
    snippet,
    onToggleSnippet,
    snippetPlaying,
}: PodcastActionBarProps) {
    return (
        <div className="flex flex-wrap items-center gap-3">
            {!isSubscribed && snippet && onToggleSnippet && (
                <button
                    onClick={onToggleSnippet}
                    aria-label={snippetPlaying ? "stop the first episode" : `play the first episode, ${snippet.title}`}
                    className="flex min-w-0 items-center gap-3 rounded-full bg-[var(--color-brand)] py-2 pl-2 pr-5 text-left text-[var(--color-on-brand)] transition-transform hover:scale-[1.02] active:scale-95"
                >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-black/15">
                        {snippetPlaying ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current ml-0.5" />}
                    </span>
                    <span className="min-w-0">
                        <span className="block text-sm font-semibold">{snippetPlaying ? "playing the first episode" : "play the first episode"}</span>
                        <span className="block max-w-[16rem] truncate text-xs opacity-80">
                            {snippet.title}
                            {snippet.duration > 0 && ` · ${formatDuration(snippet.duration)}`}
                        </span>
                    </span>
                </button>
            )}

            {isSubscribed && onPlayLatest && (
                <button
                    onClick={isPlayingPodcast ? onPause : onPlayLatest}
                    aria-label={isPlayingPodcast ? "pause" : "play the latest episode"}
                    className="h-12 w-12 rounded-full bg-[var(--color-brand)] hover:bg-[var(--color-brand-hover)] transition-all flex items-center justify-center hover:scale-105 active:scale-95"
                >
                    {isPlayingPodcast ? (
                        <Pause className="w-5 h-5 text-[var(--color-on-brand)] fill-current" />
                    ) : (
                        <Play className="w-5 h-5 text-[var(--color-on-brand)] fill-current ml-0.5" />
                    )}
                </button>
            )}

            {isSubscribed && onRefresh && (
                <button
                    onClick={onRefresh}
                    disabled={isRefreshing}
                    className="p-2.5 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-all disabled:opacity-50"
                    title="check for new episodes"
                    aria-label="check for new episodes"
                >
                    <RefreshCw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
                </button>
            )}

            {!isSubscribed && (
                <Button
                    variant={snippet ? "secondary" : "primary"}
                    onClick={onSubscribe}
                    isLoading={isSubscribing}
                >
                    {isSubscribing ? "following" : (
                        <>
                            <Plus className="w-4 h-4" />
                            follow
                        </>
                    )}
                </Button>
            )}

            {feedUrl && (
                <a
                    href={feedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2.5 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-all"
                    title="rss feed"
                    aria-label="open the rss feed"
                >
                    <ExternalLink className="w-4 h-4" />
                </a>
            )}

            <div className="flex-1" />

            {isSubscribed && (
                <>
                    {!showDeleteConfirm ? (
                        <button
                            onClick={() => onShowDeleteConfirm(true)}
                            aria-label="remove podcast"
                            className="flex items-center gap-2 px-3 py-2 rounded-lg text-danger-light/60 hover:brightness-125 hover:bg-danger/10 border border-transparent hover:border-danger/20 transition-all text-xs tabular-nums"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span className="hidden md:inline">Remove</span>
                        </button>
                    ) : (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-[var(--text-muted)] hidden md:inline">
                                Remove podcast?
                            </span>
                            <button
                                onClick={onRemove}
                                aria-label="confirm removing this podcast"
                                className="px-3 py-2 rounded-lg text-xs font-semibold bg-danger/20 text-danger-light hover:bg-danger/30 border border-danger/20 transition-all"
                            >
                                Confirm
                            </button>
                            <button
                                onClick={() => onShowDeleteConfirm(false)}
                                className="px-3 py-2 rounded-lg text-xs bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 border border-white/10 transition-all"
                            >
                                Cancel
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
