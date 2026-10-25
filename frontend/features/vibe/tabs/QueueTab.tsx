"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Play, Pause, Music } from "lucide-react";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { CachedImage } from "@/components/ui/CachedImage";

const OPERATION_STYLES: Record<string, { label: string; borderColor: string }> = {
    drift: { label: "Song Path", borderColor: "var(--color-brand)" },
    vibe: { label: "Vibe", borderColor: "#fca200" },
    blend: { label: "Blend", borderColor: "#a056e0" },
    similar: { label: "Similar", borderColor: "#5c8dd6" },
};

function QueueCover({ coverArt }: { coverArt?: string | null }) {
    const [failed, setFailed] = useState(false);
    return (
        <div className="relative w-8 h-8 rounded overflow-hidden bg-[#181818] shrink-0">
            {coverArt && !failed ? (
                <CachedImage
                    src={api.getCoverArtUrl(coverArt, 64)}
                    alt=""
                    fill
                    sizes="32px"
                    className="object-cover"
                    onError={() => setFailed(true)}
                />
            ) : (
                <div className="w-full h-full flex items-center justify-center">
                    <Music className="w-3.5 h-3.5 text-white/25" />
                </div>
            )}
        </div>
    );
}

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
            {opStyle && (
                <div
                    className="bg-white/5 border-l-2 px-3 py-2 text-xs text-[var(--text-secondary)] shrink-0"
                    style={{ borderColor: opStyle.borderColor }}
                >
                    <span className="font-medium text-[var(--text-primary)]">{opStyle.label}</span>
                    {" -- "}
                    {trackCount} track{trackCount !== 1 ? "s" : ""}
                </div>
            )}

            {currentTrack && (
                <button
                    onClick={handleTogglePlayback}
                    className="flex items-center gap-3 px-3 py-2.5 bg-white/5 border-b border-white/5 shrink-0 w-full text-left hover:bg-white/8 transition-colors"
                >
                    <QueueCover coverArt={currentTrack.album?.coverArt} />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{currentTrack.title}</p>
                        <p className="text-xs text-[var(--text-muted)] truncate">
                            {currentTrack.artist?.name}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <div className="w-2 h-2 rounded-full bg-brand animate-pulse" />
                        {isPlaying ? (
                            <Pause className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                        ) : (
                            <Play className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                        )}
                    </div>
                </button>
            )}

            <div className="flex-1 overflow-y-auto">
                {queue.length === 0 && (
                    <div className="flex items-center justify-center py-12 text-center">
                        <p className="text-sm text-[var(--text-muted)]">Queue is empty</p>
                    </div>
                )}
                {queue.map((track, index) => {
                    if (index === currentIndex) return null;

                    return (
                        <button
                            key={`${track.id}-${index}`}
                            onClick={() => handlePlayFromIndex(index)}
                            className={cn(
                                "flex items-center gap-3 px-3 py-2 w-full text-left hover:bg-white/5 transition-colors",
                                index < currentIndex && "opacity-50",
                            )}
                        >
                            <QueueCover coverArt={track.album?.coverArt} />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-[var(--text-primary)] truncate">{track.title}</p>
                                <p className="text-xs text-[var(--text-muted)] truncate">
                                    {track.artist?.name}
                                </p>
                            </div>
                            <span className="text-xs text-[var(--text-muted)] tabular-nums shrink-0">
                                {formatTime(track.duration)}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
