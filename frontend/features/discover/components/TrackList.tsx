import { Heart } from "lucide-react";
import { TrackRow } from "@/components/ui/TrackRow";
import { cn } from "@/lib/cn";
import { DiscoverTrack } from "../types";
import { api } from "@/lib/api";
import { tierColors, tierLabels } from "../constants";
import { useDoubleTapList } from "@/hooks/useDoubleTap";
import { usePlayRow } from "@/hooks/usePlayRow";

interface TrackListProps {
    tracks: DiscoverTrack[];
    currentTrack?: { id: string } | null;
    onPlayTrack: (index: number) => void;
    onLike: (track: DiscoverTrack) => void;
}

export function TrackList({
    tracks,
    currentTrack,
    onPlayTrack,
    onLike,
}: TrackListProps) {
    const { isPlaying, playRow } = usePlayRow();
    // The song that is current pauses or resumes; any other starts the playlist from it. A double click or tap never pauses.
    const activate = (index: number, gesture: "press" | "double" = "press") =>
        playRow(currentTrack?.id === tracks[index]?.id, () => onPlayTrack(index), gesture);
    const onTouchEnd = useDoubleTapList((index) => activate(index, "double"));

    return (
        <div className="w-full">
            <div className="hidden md:grid grid-cols-[40px_minmax(200px,4fr)_minmax(100px,2fr)_80px_80px] gap-4 px-4 py-2 text-xs text-[var(--text-secondary)] border-b border-white/10 mb-2">
                <span className="text-center">#</span>
                <span>Title</span>
                <span>Album</span>
                <span className="text-center">Match</span>
                <span className="text-right">Duration</span>
            </div>

            <div>
                {tracks.map((track, index) => {
                    const isTrackPlaying = currentTrack?.id === track.id;
                    return (
                        <TrackRow
                            key={track.id}
                            rowProps={{ "data-track-index": index }}
                            onDoubleClick={() => activate(index, "double")}
                            onTouchEnd={onTouchEnd}
                            className="px-4"
                            columns="grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,2fr)_80px_80px]"
                            index={index}
                            current={isTrackPlaying}
                            playing={isPlaying}
                            onPlay={() => activate(index)}
                            title={track.title}
                            subtitle={track.artist}
                            coverUrl={track.coverUrl ? api.getCoverArtUrl(track.coverUrl, 80) : null}
                            extras={[
                                <span key="album" className="truncate">{track.album}</span>,
                                <span key="match" className="w-full flex justify-center">
                                    <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium bg-white/5", tierColors[track.tier])}>
                                        {tierLabels[track.tier]?.split(" ")[0]}
                                    </span>
                                </span>,
                            ]}
                            duration={track.duration}
                            actions={
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onLike(track);
                                    }}
                                    aria-label={track.isLiked ? `unlike ${track.title}` : `like ${track.title}`}
                                    aria-pressed={track.isLiked}
                                    className={cn(
                                        "p-1.5 rounded-full opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all touch-reveal",
                                        track.isLiked ? "text-brand hover:text-brand-light" : "text-[var(--text-secondary)] hover:text-white"
                                    )}
                                    title={track.isLiked ? "unlike" : "keep in library"}
                                >
                                    <Heart className={cn("w-4 h-4", track.isLiked && "fill-current")} />
                                </button>
                            }
                        />
                    );
                })}
            </div>
        </div>
    );
}
