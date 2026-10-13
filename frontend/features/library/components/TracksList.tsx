"use client";

import { useState, memo, useCallback } from "react";
import { Track } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { CachedImage } from "@/components/ui/CachedImage";
import { AudioLines, ListPlus, Plus, Trash2, Play } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { api } from "@/lib/api";
import { useAudioState } from "@/lib/audio-state-context";
import { useDoubleTap } from "@/hooks/useDoubleTap";
import { cascadeStyle } from "@/lib/motion";

interface TracksListProps {
    tracks: Track[];
    onPlay: (tracks: Track[], startIndex?: number) => void;
    onAddToQueue: (track: Track) => void;
    onAddToPlaylist: (playlistId: string, trackId: string) => void;
    onDelete?: (trackId: string, trackTitle: string) => void;
    isLoading?: boolean;
    gridKey?: number;
}

interface TrackRowProps {
    track: Track;
    index: number;
    isCurrentlyPlaying: boolean;
    onPlayTrack: () => void;
    onAddToQueue: (track: Track) => void;
    onShowAddToPlaylist: (trackId: string) => void;
    onDelete?: (trackId: string, trackTitle: string) => void;
}

const TrackRow = memo(
    function TrackRow({
        track,
        index,
        isCurrentlyPlaying,
        onPlayTrack,
        onAddToQueue,
        onShowAddToPlaylist,
        onDelete,
    }: TrackRowProps) {
        const doubleTapProps = useDoubleTap(onPlayTrack);
        const displayTrackNumber =
            typeof track.trackNumber === "number"
                ? track.trackNumber
                : index + 1;
        const displayDiscNumber =
            typeof track.discNumber === "number" ? track.discNumber : null;
        const displayTrackLabel =
            displayDiscNumber && displayDiscNumber > 1
                ? `${displayDiscNumber}-${String(displayTrackNumber).padStart(2, "0")}`
                : String(displayTrackNumber);
        return (
            <div
                key={track.id}
                {...doubleTapProps}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                style={{ "--i": index } as React.CSSProperties}
                className={cn(
                    "grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_auto] items-center gap-3 px-4 py-3 rounded-lg border-2 transition-all duration-200 group cursor-pointer touch-manipulation",
                    isCurrentlyPlaying
                        ? "bg-brand/10 border-brand/30 "
                        : "bg-[var(--bg-primary)] border-white/5 hover:border-brand/30 hover:bg-brand/5",
                    "animate-rise [animation-delay:calc(var(--i)*var(--stagger))]",
                )}
            >
                <div className="w-8 flex items-center justify-center">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onPlayTrack();
                        }}
                        className="group/play w-10 h-10 flex items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                        aria-label={isCurrentlyPlaying ? "Pause" : "Play"}
                    >
                        <span
                            className={cn(
                                "text-sm tabular-nums font-bold group-hover:hidden",
                                isCurrentlyPlaying ? "text-brand" : "text-[var(--text-muted)]",
                            )}
                        >
                            {isCurrentlyPlaying ?
                                <AudioLines className="w-4 h-4 text-brand" />
                            :   displayTrackLabel}
                        </span>
                        <Play className="w-4 h-4 text-brand opacity-0 group-hover:opacity-100 group-focus-visible/play:opacity-100 transition-opacity duration-150 fill-current" />
                    </button>
                </div>

                <div className="flex items-center gap-3 min-w-0">
                    <div className="relative w-11 h-11 bg-[#181818] rounded border border-white/10 flex items-center justify-center overflow-hidden shrink-0">
                        {track.album?.coverArt ?
                            <CachedImage
                                src={api.getCoverArtUrl(
                                    track.album.coverArt,
                                    80,
                                )}
                                alt={track.title}
                                fill
                                sizes="40px"
                                className="object-cover"
                            />
                        :   <AudioLines className="w-5 h-5 text-[var(--text-muted)]" />}
                    </div>
                    <div className="min-w-0">
                        <h3
                            className={cn(
                                "text-sm font-bold truncate tracking-tight",
                                isCurrentlyPlaying ? "text-brand" : "text-white",
                            )}
                        >
                            {track.displayTitle ?? track.title}
                        </h3>
                        <p className="text-xs tabular-nums text-[var(--text-muted)] truncate">
                            {track.album?.artist?.name}
                        </p>
                    </div>
                </div>

                <div className="hidden md:block min-w-0">
                    <p className="text-xs tabular-nums text-[var(--text-muted)] truncate">
                        {track.album?.title}
                    </p>
                </div>

                <div className="flex items-center gap-1">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onAddToQueue(track);
                        }}
                        className="w-10 h-10 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all duration-150 border border-transparent hover:border-white/20 touch-reveal"
                        title="add to queue"
                    >
                        <ListPlus className="w-4 h-4" />
                    </button>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onShowAddToPlaylist(track.id);
                        }}
                        className="w-10 h-10 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all duration-150 border border-transparent hover:border-white/20 touch-reveal"
                        title="add to playlist"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                    {onDelete && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onDelete(track.id, track.title);
                        }}
                        className="w-10 h-10 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:text-danger hover:bg-danger/10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all duration-150 border border-transparent hover:border-danger/30 touch-reveal"
                        title="delete track"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                    )}
                    <span className="text-sm tabular-nums font-bold text-[var(--text-muted)] w-12 text-right">
                        {formatTime(track.duration)}
                    </span>
                </div>
            </div>
        );
    },
    (prevProps, nextProps) => {
        return (
            prevProps.track.id === nextProps.track.id &&
            prevProps.isCurrentlyPlaying === nextProps.isCurrentlyPlaying &&
            prevProps.index === nextProps.index
        );
    },
);

export function TracksList({
    tracks,
    onPlay,
    onAddToQueue,
    onAddToPlaylist,
    onDelete,
    isLoading = false,
    gridKey,
}: TracksListProps) {
    const { currentTrack } = useAudioState();
    const currentTrackId = currentTrack?.id;
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

    const handleShowAddToPlaylist = useCallback((trackId: string) => {
        setSelectedTrackId(trackId);
        setShowPlaylistSelector(true);
    }, []);

    const handleAddToPlaylist = useCallback(
        async (playlistId: string) => {
            if (!selectedTrackId) return;
            onAddToPlaylist(playlistId, selectedTrackId);
            setShowPlaylistSelector(false);
            setSelectedTrackId(null);
        },
        [selectedTrackId, onAddToPlaylist],
    );

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (tracks.length === 0) {
        return (
            <EmptyState
                icon={<AudioLines className="w-12 h-12" />}
                title="No songs yet"
                description="Your library is empty. Sync your music to get started."
            />
        );
    }

    return (
        <>
            <div className="grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_auto] items-center gap-3 px-4 py-3 bg-[var(--bg-primary)] border-2 border-white/10 rounded-lg mb-2">
                <div className="w-8 text-center text-xs font-semibold text-[var(--text-muted)]">#</div>
                <div className="text-xs font-semibold text-[var(--text-muted)]">Title</div>
                <div className="hidden md:block text-xs font-semibold text-[var(--text-muted)]">Album</div>
                <div className="w-[140px] text-right pr-2 text-xs font-semibold text-[var(--text-muted)]">Duration</div>
            </div>

            <div key={gridKey} data-tv-section="library-tracks" className="space-y-1" style={cascadeStyle(tracks.length)}>
                {tracks.map((track, index) => {
                    const isCurrentlyPlaying = currentTrackId === track.id;
                    return (
                        <TrackRow
                            key={track.id}
                            track={track}
                            index={index}
                            isCurrentlyPlaying={isCurrentlyPlaying}
                            onPlayTrack={() => onPlay(tracks, index)}
                            onAddToQueue={onAddToQueue}
                            onShowAddToPlaylist={handleShowAddToPlaylist}
                            onDelete={onDelete}
                        />
                    );
                })}
            </div>

            <PlaylistSelector
                isOpen={showPlaylistSelector}
                onClose={() => {
                    setShowPlaylistSelector(false);
                    setSelectedTrackId(null);
                }}
                onSelectPlaylist={handleAddToPlaylist}
            />
        </>
    );
}
