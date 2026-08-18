"use client";

import DOMPurify from "dompurify";
import { Plus, Loader2 } from "lucide-react";
import { PodcastPreview } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatDuration } from "@/utils/formatTime";
import { formatDate } from "../utils";

interface PreviewEpisodesProps {
    previewData: PodcastPreview;
    colors: ColorPalette | null;
    isSubscribing: boolean;
    onSubscribe: () => void;
}

export function PreviewEpisodes({
    previewData,
    isSubscribing,
    onSubscribe,
}: PreviewEpisodesProps) {
    return (
        <section>
            <div className="flex items-center gap-3 mb-6">
                <span className="w-1 h-8 bg-gradient-to-b from-[#3b82f6] to-[#2563eb] rounded-full shrink-0" />
                <h2 className="text-2xl font-bold tracking-tight">Latest Episodes</h2>
                <span className="flex-1 border-t border-white/10" />
            </div>

            <div className="relative">
                {previewData.previewEpisodes &&
                previewData.previewEpisodes.length > 0 ? (
                    <>
                        <div className="space-y-0.5">
                            {previewData.previewEpisodes.map((episode, index) => (
                                <div
                                    key={index}
                                    className="flex items-center gap-4 px-3 py-3 rounded-lg opacity-50 cursor-not-allowed"
                                >
                                    <div className="w-8 flex items-center justify-center shrink-0">
                                        <span className="text-xs font-mono text-white/30">
                                            {index + 1}
                                        </span>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="font-bold truncate text-sm text-white tracking-tight">
                                            {episode.title}
                                        </h3>
                                        <div className="flex items-center gap-2 text-micro font-mono text-white/40 uppercase tracking-wider">
                                            <span>{formatDate(episode.publishedAt)}</span>
                                            {episode.duration > 0 && (
                                                <>
                                                    <span className="text-white/20">|</span>
                                                    <span>{formatDuration(episode.duration)}</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Subscribe overlay */}
                        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#0a0a0a]/80 to-[#0a0a0a] flex items-end justify-center pb-8 pointer-events-none">
                            <button
                                onClick={onSubscribe}
                                disabled={isSubscribing}
                                className="flex items-center gap-2 pointer-events-auto h-10 px-5 rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] transition-all font-bold text-sm text-white uppercase tracking-wider disabled:opacity-50 shadow-xl hover:scale-[1.02] active:scale-[0.98]"
                            >
                                {isSubscribing ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        <span>Subscribing</span>
                                    </>
                                ) : (
                                    <>
                                        <Plus className="w-4 h-4" />
                                        <span>Subscribe to Unlock All Episodes</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </>
                ) : (
                    <div className="relative overflow-hidden rounded-lg border-2 border-white/10 bg-gradient-to-br from-[#0f0f0f] to-[#0a0a0a] p-8 text-center">
                        <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-[#3b82f6] to-[#2563eb]" />
                        <p className="text-xs font-mono text-gray-500 uppercase tracking-wider mb-4">
                            No episodes available for preview
                        </p>
                        <button
                            onClick={onSubscribe}
                            disabled={isSubscribing}
                            className="flex items-center gap-2 mx-auto h-10 px-5 rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] transition-all font-bold text-sm text-white uppercase tracking-wider disabled:opacity-50 hover:scale-[1.02] active:scale-[0.98]"
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
                    </div>
                )}
            </div>

            {/* About Section */}
            {previewData.description && (
                <div className="mt-8">
                    <div className="flex items-center gap-3 mb-4">
                        <span className="w-1 h-6 bg-gradient-to-b from-[#3b82f6] to-[#2563eb] rounded-full shrink-0" />
                        <h2 className="text-xl font-bold tracking-tight">About</h2>
                        <span className="flex-1 border-t border-white/10" />
                    </div>
                    <div className="relative overflow-hidden rounded-lg border border-white/10 bg-[var(--bg-primary)] p-4">
                        <div
                            className="prose prose-invert prose-sm max-w-none text-white/60 [&_a]:text-[#3b82f6] [&_a]:no-underline [&_a:hover]:underline font-mono text-xs leading-relaxed"
                            dangerouslySetInnerHTML={{
                                __html: DOMPurify.sanitize(previewData.description || ""),
                            }}
                        />
                    </div>
                </div>
            )}
        </section>
    );
}
