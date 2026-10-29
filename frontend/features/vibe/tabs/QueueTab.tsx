"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Play, Pause, Music, ChevronUp, ChevronDown, X, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { CachedImage } from "@/components/ui/CachedImage";
import { shownTitle } from "@/lib/track-title";

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

/** The queue. `withNowPlaying` false leaves out the playing row, for a panel that shows it above. */
export function QueueTab({ withNowPlaying = true }: { withNowPlaying?: boolean }) {
    const { currentTrack, queue, currentIndex, activeOperation, setQueue } = useAudioState();
    const { playTracks, pause, resume, removeFromQueue, clearQueue } = useAudioControls();
    const { isPlaying } = useAudioPlayback();
    const [confirmClear, setConfirmClear] = useState(false);

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

    // Only what is still to play moves; what already played stays where it was.
    const swap = (index: number, other: number) =>
        setQueue((prev) => {
            const next = [...prev];
            [next[index], next[other]] = [next[other], next[index]];
            return next;
        });

    const rowAction =
        "flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] outline-none transition-colors hover:bg-white/[0.08] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-brand/60 disabled:pointer-events-none disabled:opacity-30";

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

            {withNowPlaying && currentTrack && (
                <button
                    data-queue-now
                    onClick={handleTogglePlayback}
                    aria-label={isPlaying ? `pause ${shownTitle(currentTrack)}` : `play ${shownTitle(currentTrack)}`}
                    className="flex items-center gap-3 px-3 py-2.5 bg-white/5 border-b border-white/5 shrink-0 w-full text-left hover:bg-white/8 transition-colors"
                >
                    <QueueCover coverArt={currentTrack.album?.coverArt} />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{shownTitle(currentTrack)}</p>
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

            {queue.length > 0 && (
                <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/5 px-3 text-xs text-[var(--text-muted)]">
                    <span data-queue-count className="tabular-nums">
                        {queue.length} {queue.length === 1 ? "track" : "tracks"} in the queue
                    </span>
                    <button
                        type="button"
                        onClick={() => setConfirmClear(true)}
                        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 outline-none transition-colors hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-brand/60"
                    >
                        <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                        clear queue
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto">
                {queue.length === 0 && (
                    <div className="flex items-center justify-center py-12 text-center">
                        <p className="text-sm text-[var(--text-muted)]">the queue is empty</p>
                    </div>
                )}
                {queue.length > 0 && !withNowPlaying && queue.length - currentIndex - 1 <= 0 && (
                    <p className="px-3 py-4 text-xs text-[var(--text-muted)]">nothing up next: add songs, or play an album</p>
                )}
                {queue.map((track, index) => {
                    if (index === currentIndex) return null;
                    const upcoming = index > currentIndex;

                    return (
                        <div
                            key={`${track.id}-${index}`}
                            data-queue-row
                            className={cn(
                                "group flex items-center gap-1 pr-2 transition-colors hover:bg-white/5 focus-within:bg-white/5",
                                !upcoming && "opacity-50",
                            )}
                        >
                            <button
                                type="button"
                                onClick={() => handlePlayFromIndex(index)}
                                aria-label={`play ${shownTitle(track)}`}
                                className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60"
                            >
                                <QueueCover coverArt={track.album?.coverArt} />
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm text-[var(--text-primary)] truncate">{shownTitle(track)}</p>
                                    <p className="text-xs text-[var(--text-muted)] truncate">
                                        {track.artist?.name}
                                    </p>
                                </div>
                                <span
                                    className={cn(
                                        "text-xs text-[var(--text-muted)] tabular-nums shrink-0",
                                        // The actions take the duration's place on rows that have them.
                                        upcoming && "hidden can-hover:block can-hover:group-hover:hidden can-hover:group-focus-within:hidden",
                                    )}
                                >
                                    {formatTime(track.duration)}
                                </span>
                            </button>
                            {/* Shown on hover or focus where there is a pointer; always on a touch screen. */}
                            {upcoming && (
                                <div className="flex shrink-0 items-center can-hover:hidden can-hover:group-hover:flex can-hover:group-focus-within:flex">
                                    <button
                                        type="button"
                                        onClick={() => swap(index, index - 1)}
                                        disabled={index <= currentIndex + 1}
                                        aria-label={`move ${shownTitle(track)} up`}
                                        className={rowAction}
                                    >
                                        <ChevronUp aria-hidden="true" className="h-4 w-4" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => swap(index, index + 1)}
                                        disabled={index >= queue.length - 1}
                                        aria-label={`move ${shownTitle(track)} down`}
                                        className={rowAction}
                                    >
                                        <ChevronDown aria-hidden="true" className="h-4 w-4" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => removeFromQueue(index)}
                                        aria-label={`remove ${shownTitle(track)} from the queue`}
                                        className={cn(rowAction, "hover:bg-danger/10 hover:text-danger-light")}
                                    >
                                        <X aria-hidden="true" className="h-4 w-4" />
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            <ConfirmDialog
                isOpen={confirmClear}
                onClose={() => setConfirmClear(false)}
                onConfirm={clearQueue}
                title="clear the queue?"
                message={`this removes ${queue.length === 1 ? "the only track" : `all ${queue.length} tracks`} from the queue.`}
                confirmText="clear queue"
                variant="danger"
            />
        </div>
    );
}
