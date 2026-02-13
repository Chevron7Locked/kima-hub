"use client";

import { useState, memo, useCallback } from "react";
import { Track } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { CachedImage } from "@/components/ui/CachedImage";
import { AudioLines, ListPlus, Plus, Trash2, Play } from "lucide-react";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import { api } from "@/lib/api";
import { useAudioState } from "@/lib/audio-state-context";

interface TracksListProps {
    tracks: Track[];
    onPlay: (tracks: Track[], startIndex?: number) => void;
    onAddToQueue: (track: Track) => void;
    onAddToPlaylist: (playlistId: string, trackId: string) => void;
    onDelete: (trackId: string, trackTitle: string) => void;
    isLoading?: boolean;
}


interface TrackRowProps {
    track: Track;
    index: number;
    isCurrentlyPlaying: boolean;
    onPlayTrack: () => void;
    onAddToQueue: (track: Track) => void;
    onShowAddToPlaylist: (trackId: string) => void;
    onDelete: (trackId: string, trackTitle: string) => void;
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
        return (
            <div
                key={track.id}
                onDoubleClick={onPlayTrack}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className={cn(
                    "grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_auto] items-center gap-3 px-4 py-3 rounded-lg border-2 transition-all group cursor-pointer",
                    isCurrentlyPlaying
                        ? "bg-[#a855f7]/10 border-[#a855f7]/30 shadow-lg shadow-[#a855f7]/10"
                        : "bg-[#0a0a0a] border-white/5 hover:border-[#a855f7]/30 hover:bg-[#a855f7]/5",
                )}
            >
                {/* Track number / Play button */}
                <div className="w-8 flex items-center justify-center">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onPlayTrack();
                        }}
                        className="w-8 h-8 flex items-center justify-center"
                        aria-label="Play"
                    >
                        <span
                            className={cn(
                                "text-sm font-mono font-bold group-hover:hidden",
                                isCurrentlyPlaying ? "text-[#a855f7]" : "text-gray-600",
                            )}
                        >
                            {isCurrentlyPlaying ?
                                <AudioLines className="w-4 h-4 text-[#a855f7]" />
                            :   index + 1}
                        </span>
                        <Play className="w-4 h-4 text-[#a855f7] hidden group-hover:block fill-current" />
                    </button>
                </div>

                {/* Cover + Title/Artist */}
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
                        :   <AudioLines className="w-5 h-5 text-gray-700" />}
                    </div>
                    <div className="min-w-0">
                        <h3
                            className={cn(
                                "text-sm font-bold truncate tracking-tight",
                                isCurrentlyPlaying ? "text-[#a855f7]" : "text-white",
                            )}
                        >
                            {track.displayTitle ?? track.title}
                        </h3>
                        <p className="text-xs font-mono text-gray-500 truncate">
                            {track.album?.artist?.name}
                        </p>
                    </div>
                </div>

                {/* Album - hidden on mobile */}
                <div className="hidden md:block min-w-0">
                    <p className="text-sm font-mono text-gray-500 truncate">
                        {track.album?.title}
                    </p>
                </div>

                {/* Actions + Duration */}
                <div className="flex items-center gap-1">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onAddToQueue(track);
                        }}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all border border-transparent hover:border-white/20"
                        title="Add to Queue"
                    >
                        <ListPlus className="w-4 h-4" />
                    </button>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onShowAddToPlaylist(track.id);
                        }}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all border border-transparent hover:border-white/20"
                        title="Add to Playlist"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onDelete(track.id, track.title);
                        }}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all border border-transparent hover:border-red-500/30"
                        title="Delete Track"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                    <span className="text-sm font-mono font-bold text-gray-600 w-12 text-right">
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
            {/* Header row - terminal style */}
            <div className="grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_auto] items-center gap-3 px-4 py-3 bg-[#0a0a0a] border-2 border-white/10 rounded-lg mb-2">
                <div className="w-8 text-center text-xs font-mono font-black text-[#a855f7] uppercase">#</div>
                <div className="text-xs font-mono font-black text-[#a855f7] uppercase tracking-wider">Title</div>
                <div className="hidden md:block text-xs font-mono font-black text-[#a855f7] uppercase tracking-wider">Album</div>
                <div className="w-[140px] text-right pr-2 text-xs font-mono font-black text-[#a855f7] uppercase tracking-wider">Duration</div>
            </div>

            <div data-tv-section="library-tracks" className="space-y-1">
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
