"use client";

import { useState, memo, useCallback } from "react";
import Image from "next/image";
import { Track } from "../types";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { AudioLines, ListPlus, Plus, Trash2, Play } from "lucide-react";
import { cn } from "@/utils/cn";
import { api } from "@/lib/api";

interface TracksListProps {
  tracks: Track[];
  onPlay: (tracks: Track[], startIndex?: number) => void;
  onAddToQueue: (track: Track) => void;
  onAddToPlaylist: (playlistId: string, trackId: string) => void;
  onDelete: (trackId: string, trackTitle: string) => void;
  currentTrackId?: string;
  isLoading?: boolean;
}

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

interface TrackRowProps {
  track: Track;
  index: number;
  isCurrentlyPlaying: boolean;
  onPlayTrack: () => void;
  onAddToQueue: (track: Track) => void;
  onShowAddToPlaylist: (trackId: string) => void;
  onDelete: (trackId: string, trackTitle: string) => void;
}

const TrackRow = memo(function TrackRow({
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
      onClick={onPlayTrack}
      data-tv-card
      data-tv-card-index={index}
      tabIndex={0}
      className={cn(
        "grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_auto] items-center gap-3 px-3 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer",
        isCurrentlyPlaying && "bg-white/5"
      )}
    >
      {/* Track number / Play icon */}
      <div className="w-8 flex items-center justify-center">
        <span className={cn(
          "text-sm group-hover:hidden",
          isCurrentlyPlaying ? "text-[#ecb200]" : "text-gray-500"
        )}>
          {isCurrentlyPlaying ? (
            <AudioLines className="w-4 h-4 text-[#ecb200]" />
          ) : (
            index + 1
          )}
        </span>
        <Play className="w-4 h-4 text-white hidden group-hover:block fill-current" />
      </div>

      {/* Cover + Title/Artist */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="relative w-10 h-10 bg-[#282828] rounded flex items-center justify-center overflow-hidden shrink-0">
          {track.album?.coverArt ? (
            <Image
              src={api.getCoverArtUrl(track.album.coverArt, 80)}
              alt={track.title}
              fill
              sizes="40px"
              className="object-cover"
              unoptimized
            />
          ) : (
            <AudioLines className="w-4 h-4 text-gray-600" />
          )}
        </div>
        <div className="min-w-0">
          <h3 className={cn(
            "text-sm font-medium truncate",
            isCurrentlyPlaying ? "text-[#ecb200]" : "text-white"
          )}>
            {track.displayTitle ?? track.title}
          </h3>
          <p className="text-xs text-gray-400 truncate">
            {track.album?.artist?.name}
          </p>
        </div>
      </div>

      {/* Album - hidden on mobile */}
      <div className="hidden md:block min-w-0">
        <p className="text-sm text-gray-400 truncate">
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
          className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all"
          title="Add to Queue"
        >
          <ListPlus className="w-4 h-4" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onShowAddToPlaylist(track.id);
          }}
          className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all"
          title="Add to Playlist"
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(track.id, track.title);
          }}
          className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-all"
          title="Delete Track"
        >
          <Trash2 className="w-4 h-4" />
        </button>
        <span className="text-xs text-gray-500 w-10 text-right">
          {formatDuration(track.duration)}
        </span>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.track.id === nextProps.track.id &&
    prevProps.isCurrentlyPlaying === nextProps.isCurrentlyPlaying &&
    prevProps.index === nextProps.index
  );
});

export function TracksList({
  tracks,
  onPlay,
  onAddToQueue,
  onAddToPlaylist,
  onDelete,
  currentTrackId,
  isLoading = false,
}: TracksListProps) {
  const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

  const handleShowAddToPlaylist = useCallback((trackId: string) => {
    setSelectedTrackId(trackId);
    setShowPlaylistSelector(true);
  }, []);

  const handleAddToPlaylist = useCallback(async (playlistId: string) => {
    if (!selectedTrackId) return;
    onAddToPlaylist(playlistId, selectedTrackId);
    setShowPlaylistSelector(false);
    setSelectedTrackId(null);
  }, [selectedTrackId, onAddToPlaylist]);

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
      {/* Header row */}
      <div className="grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_auto] items-center gap-3 px-3 py-2 border-b border-white/10 text-xs text-gray-500 uppercase tracking-wider">
        <div className="w-8 text-center">#</div>
        <div>Title</div>
        <div className="hidden md:block">Album</div>
        <div className="w-[140px] text-right pr-2">Duration</div>
      </div>

      <div data-tv-section="library-tracks" className="space-y-0.5">
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
