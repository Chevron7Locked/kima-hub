"use client";

import { ExternalLink, Trash2, Plus, Loader2, Play, Pause, RefreshCw } from "lucide-react";
import { cn } from "@/utils/cn";
import type { ColorPalette } from "@/hooks/useImageColor";

interface PodcastActionBarProps {
    isSubscribed: boolean;
    feedUrl?: string;
    colors: ColorPalette | null;
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
}: PodcastActionBarProps) {
    return (
        <div className="flex items-center gap-3">
            {/* Play / Pause for subscribed podcasts */}
            {isSubscribed && onPlayLatest && (
                <button
                    onClick={isPlayingPodcast ? onPause : onPlayLatest}
                    className="w-10 h-10 rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] transition-all flex items-center justify-center hover:scale-105 active:scale-95"
                >
                    {isPlayingPodcast ? (
                        <Pause className="w-4 h-4 text-white" />
                    ) : (
                        <Play className="w-4 h-4 text-white ml-0.5" fill="white" />
                    )}
                </button>
            )}

            {/* Refresh */}
            {isSubscribed && onRefresh && (
                <button
                    onClick={onRefresh}
                    disabled={isRefreshing}
                    className="p-2.5 rounded-lg text-white/40 hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-all disabled:opacity-50"
                    title="Check for new episodes"
                >
                    <RefreshCw className={cn("w-4 h-4", isRefreshing && "animate-spin")} />
                </button>
            )}

            {/* Subscribe Button */}
            {!isSubscribed && (
                <button
                    onClick={onSubscribe}
                    disabled={isSubscribing}
                    className="h-10 px-5 rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] transition-all flex items-center gap-2 font-black text-sm text-white uppercase tracking-wider disabled:opacity-50 hover:scale-[1.02] active:scale-[0.98]"
                >
                    {isSubscribing ? (
                        <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Subscribing</span>
                        </>
                    ) : (
                        <>
                            <Plus className="w-4 h-4" />
                            <span>Subscribe</span>
                        </>
                    )}
                </button>
            )}

            {/* RSS Feed Link */}
            {feedUrl && (
                <a
                    href={feedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2.5 rounded-lg text-white/40 hover:text-white hover:bg-white/5 border border-transparent hover:border-white/10 transition-all"
                    title="RSS Feed"
                >
                    <ExternalLink className="w-4 h-4" />
                </a>
            )}

            <div className="flex-1" />

            {/* Remove Podcast */}
            {isSubscribed && (
                <>
                    {!showDeleteConfirm ? (
                        <button
                            onClick={() => onShowDeleteConfirm(true)}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg text-red-400/60 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-all text-xs font-mono uppercase tracking-wider"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span className="hidden md:inline">Remove</span>
                        </button>
                    ) : (
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-mono text-white/40 hidden md:inline uppercase tracking-wider">
                                Remove podcast?
                            </span>
                            <button
                                onClick={onRemove}
                                className="px-3 py-2 rounded-lg text-xs font-black uppercase tracking-wider bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/20 transition-all"
                            >
                                Confirm
                            </button>
                            <button
                                onClick={() => onShowDeleteConfirm(false)}
                                className="px-3 py-2 rounded-lg text-xs font-mono uppercase tracking-wider bg-white/5 text-white/50 hover:bg-white/10 border border-white/10 transition-all"
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
