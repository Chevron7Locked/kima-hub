import React from "react";
import { Play, Pause, Volume2, Music } from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import type { Track, Artist } from "../types";
import { formatNumber, formatTime } from "@/lib/format";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { cascadeStyle } from "@/lib/motion";
import { useDoubleTapList } from "@/hooks/useDoubleTap";
import { CachedImage } from "@/components/ui/CachedImage";
import { shownTitle } from "@/lib/track-title";

// A top track without a library album is not owned, so it can only be previewed.
const isUnownedTrack = (track: Track) =>
    !track.album?.id || !track.album?.title || track.album.title === "Unknown Album";

interface PopularTracksProps {
    tracks: Track[];
    artist: Artist;
    currentTrackId: string | undefined;
    onPlayTrack: (track: Track) => void;
    previewTrack: string | null;
    previewPlaying: boolean;
    onPreview: (track: Track) => void;
}

export const PopularTracks: React.FC<PopularTracksProps> = ({
    tracks,
    artist,
    currentTrackId,
    onPlayTrack,
    previewTrack,
    previewPlaying,
    onPreview,
}) => {
    const activate = (track: Track) => {
        if (isUnownedTrack(track)) onPreview(track);
        else onPlayTrack(track);
    };
    const onTouchEnd = useDoubleTapList((index) => {
        if (tracks[index]) activate(tracks[index]);
    });

    return (
        <section>
            <SectionHeader type="track" title="Popular" />
            <div data-tv-section="tracks" style={cascadeStyle(Math.min(tracks.length, 10))}>
                {tracks.slice(0, 10).map((track, index) => {
                    const isPlaying = currentTrackId === track.id;
                    const isPreviewPlaying =
                        previewTrack === track.id && previewPlaying;
                    const isUnowned = isUnownedTrack(track);
                    const coverUrl = track.album?.coverArt
                        ? api.getCoverArtUrl(track.album.coverArt, 80)
                        : null;

                    return (
                        <div
                            key={track.id}
                            data-track-row
                            data-tv-card
                            data-tv-card-index={index}
                            data-track-index={index}
                            tabIndex={0}
                            className={cn(
                                "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(80px,1fr)_80px] gap-4 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer touch-manipulation",
                                isPlaying && "bg-white/10",
                                "animate-rise [animation-delay:calc(var(--i)*var(--stagger))]",
                            )}
                            style={{ "--i": index } as unknown as React.CSSProperties}
                            onDoubleClick={() => activate(track)}
                            onTouchEnd={onTouchEnd}
                        >
                            <div className="flex items-center justify-center">
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        activate(track);
                                    }}
                                    className="group/play w-8 h-8 flex items-center justify-center"
                                    aria-label={isPlaying ? "Pause" : "Play"}
                                >
                                    <span
                                        className={cn(
                                            "text-sm group-hover:hidden group-focus-visible/play:hidden",
                                            isPlaying
                                                ? "text-brand"
                                                : "text-[var(--text-secondary)]"
                                        )}
                                    >
                                        {isPlaying ? (
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
                                    {coverUrl ? (
                                        <CachedImage
                                            src={coverUrl}
                                            alt={shownTitle(track)}
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
                                    <div
                                        className={cn(
                                            "text-sm font-medium truncate flex items-center gap-2",
                                            isPlaying
                                                ? "text-brand"
                                                : "text-white"
                                        )}
                                    >
                                        <span className="truncate">
                                            {shownTitle(track)}
                                        </span>
                                        {isUnowned && (
                                            <span className="shrink-0 text-micro bg-white/10 text-[var(--text-secondary)] px-1.5 py-0.5 rounded font-medium">
                                                Preview
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-[var(--text-secondary)] truncate">
                                        {artist.name}
                                    </p>
                                </div>
                            </div>

                            <div className="hidden md:flex items-center text-sm text-[var(--text-secondary)]">
                                {track.playCount !== undefined &&
                                    track.playCount > 0 && (
                                        <span className="flex items-center gap-1">
                                            <Play className="w-3 h-3" />
                                            {formatNumber(track.playCount)}
                                        </span>
                                    )}
                            </div>

                            <div className="flex items-center justify-end gap-2">
                                {isUnowned && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onPreview(track);
                                        }}
                                        aria-label={isPreviewPlaying ? `stop the preview of ${shownTitle(track)}` : `play a preview of ${shownTitle(track)}`}
                                        className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-hover:translate-y-0 focus-visible:translate-y-0 can-hover:translate-y-1 transition-[opacity,transform] duration-150 hover:bg-white/10 text-[var(--text-secondary)] hover:text-white touch-reveal"
                                    >
                                        {isPreviewPlaying ? (
                                            <Pause className="w-4 h-4" />
                                        ) : (
                                            <Volume2 className="w-4 h-4" />
                                        )}
                                    </button>
                                )}
                                {track.duration && (
                                    <span className="text-sm text-[var(--text-secondary)] w-10 text-right tabular-nums">
                                        {formatTime(track.duration)}
                                    </span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
};
