import { Play, Heart, Music } from "lucide-react";
import { cn } from "@/lib/cn";
import { DiscoverTrack } from "../types";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { tierColors, tierLabels } from "../constants";
import { CachedImage } from "@/components/ui/CachedImage";
import { useDoubleTapList } from "@/hooks/useDoubleTap";

interface TrackListProps {
    tracks: DiscoverTrack[];
    currentTrack?: { id: string } | null;
    isPlaying: boolean;
    onPlayTrack: (index: number) => void;
    onTogglePlay: () => void;
    onLike: (track: DiscoverTrack) => void;
}

export function TrackList({
    tracks,
    currentTrack,
    isPlaying,
    onPlayTrack,
    onTogglePlay,
    onLike,
}: TrackListProps) {
    const activate = (index: number) => {
        if (isPlaying && currentTrack?.id === tracks[index]?.id) {
            onTogglePlay();
        } else {
            onPlayTrack(index);
        }
    };
    const onTouchEnd = useDoubleTapList(activate);

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
                        <div
                            key={track.id}
                            data-track-index={index}
                            onDoubleClick={() => activate(index)}
                            onTouchEnd={onTouchEnd}
                            className={cn(
                                "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,2fr)_80px_80px] gap-4 px-4 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer touch-manipulation",
                                isTrackPlaying && "bg-white/10"
                            )}
                        >
                            <div className="flex items-center justify-center">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        activate(index);
                                    }}
                                    className="group/play w-8 h-8 flex items-center justify-center"
                                    aria-label={isTrackPlaying && isPlaying ? "Pause" : "Play"}
                                >
                                    <span
                                        className={cn(
                                            "group-hover:hidden group-focus-visible/play:hidden text-sm",
                                            isTrackPlaying
                                                ? "text-brand"
                                                : "text-[var(--text-secondary)]"
                                        )}
                                    >
                                        {isTrackPlaying && isPlaying ? (
                                            <Music className="w-4 h-4 text-brand animate-pulse" />
                                        ) : (
                                            index + 1
                                        )}
                                    </span>
                                    <Play className="w-4 h-4 text-white hidden group-hover:block group-focus-visible/play:block" />
                                </button>
                            </div>

                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                                    {track.coverUrl ? (
                                        <CachedImage
                                            src={api.getCoverArtUrl(
                                                track.coverUrl,
                                                80
                                            )}
                                            alt={track.album}
                                            width={40}
                                            height={40}
                                            className="object-cover"
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                            <Music className="w-5 h-5 text-[var(--text-muted)]" />
                                        </div>
                                    )}
                                </div>
                                <div className="min-w-0">
                                    <p
                                        className={cn(
                                            "text-sm font-medium truncate",
                                            isTrackPlaying
                                                ? "text-brand"
                                                : "text-white"
                                        )}
                                    >
                                        {track.title}
                                    </p>
                                    <p className="text-xs text-[var(--text-secondary)] truncate">
                                        {track.artist}
                                    </p>
                                </div>
                            </div>

                            <p className="hidden md:flex items-center text-sm text-[var(--text-secondary)] truncate">
                                {track.album}
                            </p>

                            <div className="hidden md:flex items-center justify-center">
                                <span
                                    className={cn(
                                        "px-2 py-0.5 rounded-full text-xs font-medium bg-white/5",
                                        tierColors[track.tier]
                                    )}
                                >
                                    {tierLabels[track.tier]?.split(" ")[0]}
                                </span>
                            </div>

                            <div className="flex items-center justify-end gap-2">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onLike(track);
                                    }}
                                    aria-label={track.isLiked ? `unlike ${track.title}` : `like ${track.title}`}
                                    aria-pressed={track.isLiked}
                                    className={cn(
                                        "p-1.5 rounded-full opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all touch-reveal",
                                        track.isLiked
                                            ? "text-brand hover:text-brand-light"
                                            : "text-[var(--text-secondary)] hover:text-white"
                                    )}
                                    title={
                                        track.isLiked
                                            ? "unlike"
                                            : "keep in library"
                                    }
                                >
                                    <Heart
                                        className={cn(
                                            "w-4 h-4",
                                            track.isLiked && "fill-current"
                                        )}
                                    />
                                </button>
                                <span className="text-sm text-[var(--text-secondary)] w-10 text-right">
                                    {formatTime(track.duration)}
                                </span>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
