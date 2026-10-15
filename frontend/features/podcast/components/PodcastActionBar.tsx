"use client";

import { ExternalLink, Trash2, Plus, Play, Pause, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button, buttonClass } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PlayDisc } from "@/components/ui/MediaActionBar";
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
                <PlayDisc
                    showPause={!!isPlayingPodcast}
                    onClick={isPlayingPodcast && onPause ? onPause : onPlayLatest}
                    shape="circle"
                    label={isPlayingPodcast ? "pause" : "play the latest episode"}
                />
            )}

            {isSubscribed && onRefresh && (
                <Button
                    variant="icon"
                    onClick={onRefresh}
                    disabled={isRefreshing}
                    title="check for new episodes"
                    aria-label="check for new episodes"
                >
                    <RefreshCw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
                </Button>
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
                    className={buttonClass("icon")}
                    title="rss feed"
                    aria-label="open the rss feed"
                >
                    <ExternalLink className="w-4 h-4" />
                </a>
            )}

            <div className="flex-1" />

            {isSubscribed && (
                <>
                    <Button variant="danger" size="sm" onClick={() => onShowDeleteConfirm(true)} aria-label="remove podcast">
                        <Trash2 className="w-3.5 h-3.5" />
                        <span className="hidden md:inline">remove</span>
                    </Button>
                    <ConfirmDialog
                        isOpen={showDeleteConfirm}
                        onClose={() => onShowDeleteConfirm(false)}
                        onConfirm={onRemove}
                        title="remove this podcast?"
                        message="you stop following it, and your place in its episodes and your downloads of them go too."
                        confirmText="remove"
                        cancelText="keep it"
                    />
                </>
            )}
        </div>
    );
}
