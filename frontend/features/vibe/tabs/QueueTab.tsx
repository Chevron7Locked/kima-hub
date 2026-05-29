"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { cn } from "@/utils/cn";
import { Play, Pause } from "lucide-react";
import Image from "next/image";
import { api } from "@/lib/api";
import { formatTime } from "@/utils/formatTime";

const OPERATION_STYLES: Record<string, { label: string; borderColor: string }> = {
    drift: { label: "Drift", borderColor: "var(--color-brand)" },
    vibe: { label: "Vibe", borderColor: "#1db954" },
    blend: { label: "Blend", borderColor: "#a056e0" },
    similar: { label: "Similar", borderColor: "#5c8dd6" },
};

export function QueueTab() {
    const { currentTrack, queue, currentIndex, activeOperation } = useAudioState();
    const { playTracks, pause, resume } = useAudioControls();
    const { isPlaying } = useAudioPlayback();

    const opStyle = OPERATION_STYLES[activeOperation.type];
    const trackCount = queue.length;

    const handlePlayFromIndex = (index: number) => {
        playTracks(queue, index);
    };

    const handleTogglePlayback = () => {
        if (isPlaying) {
            pause();
        } else {
            resume();
        }
    };

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            {/* Operation header */}
            {opStyle && (
                <div
                    className="bg-white/5 border-l-2 px-3 py-2 text-xs text-white/70 shrink-0"
                    style={{ borderColor: opStyle.borderColor }}
                >
                    <span className="font-medium text-white/90">{opStyle.label}</span>
                    {" -- "}
                    {trackCount} track{trackCount !== 1 ? "s" : ""}
                </div>
            )}

            {/* Currently playing -- pinned */}
            {currentTrack && (
                <button
                    onClick={handleTogglePlayback}
                    className="flex items-center gap-3 px-3 py-2.5 bg-white/5 border-b border-white/5 shrink-0 w-full text-left hover:bg-white/8 transition-colors"
                >
                    <div className="relative w-8 h-8 rounded overflow-hidden bg-[#181818] shrink-0">
                        {currentTrack.album?.coverArt ? (
                            <Image
                                src={api.getCoverArtUrl(currentTrack.album.coverArt, 64)}
                                alt=""
                                fill
                                sizes="32px"
                                className="object-cover"
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <div className="w-2 h-2 rounded-full bg-white/10" />
                            </div>
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{currentTrack.title}</p>
                        <p className="text-xs text-white/40 truncate">
                            {currentTrack.artist?.name}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <div className="w-2 h-2 rounded-full bg-[#1db954] animate-pulse" />
                        {isPlaying ? (
                            <Pause className="w-3.5 h-3.5 text-white/40" />
                        ) : (
                            <Play className="w-3.5 h-3.5 text-white/40" />
                        )}
                    </div>
                </button>
            )}

            {/* Queue tracks */}
            <div className="flex-1 overflow-y-auto">
                {queue.length === 0 && (
                    <div className="flex items-center justify-center py-12 text-center">
                        <p className="text-sm text-white/30">Queue is empty</p>
                    </div>
                )}
                {queue.map((track, index) => {
                    if (index === currentIndex) return null;
                    const coverUrl = track.album?.coverArt
                        ? api.getCoverArtUrl(track.album.coverArt, 64)
                        : null;

                    return (
                        <button
                            key={`${track.id}-${index}`}
                            onClick={() => handlePlayFromIndex(index)}
                            className={cn(
                                "flex items-center gap-3 px-3 py-2 w-full text-left hover:bg-white/5 transition-colors",
                                index < currentIndex && "opacity-50",
                            )}
                        >
                            <div className="relative w-8 h-8 rounded overflow-hidden bg-[#181818] shrink-0">
                                {coverUrl ? (
                                    <Image
                                        src={coverUrl}
                                        alt=""
                                        fill
                                        sizes="32px"
                                        className="object-cover"
                                        unoptimized
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <div className="w-2 h-2 rounded-full bg-white/10" />
                                    </div>
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-white/90 truncate">{track.title}</p>
                                <p className="text-xs text-white/40 truncate">
                                    {track.artist?.name}
                                </p>
                            </div>
                            <span className="text-xs text-white/25 tabular-nums shrink-0">
                                {formatTime(track.duration)}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
