import React, { memo, useCallback } from "react";
import { Card } from "@/components/ui/Card";
import { Play, Pause, Volume2, ListPlus, Plus } from "lucide-react";
import { cn } from "@/utils/cn";
import type { Track, Album, AlbumSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatTime } from "@/utils/formatTime";
import { formatNumber } from "@/utils/formatNumber";

interface TrackListProps {
    tracks: Track[];
    album: Album;
    source: AlbumSource;
    currentTrackId: string | undefined;
    colors: ColorPalette | null;
    onPlayTrack: (track: Track, index: number) => void;
    onAddToQueue: (track: Track) => void;
    onAddToPlaylist: (trackId: string) => void;
    previewTrack: string | null;
    previewPlaying: boolean;
    onPreview: (track: Track, e: React.MouseEvent) => void;
}

interface TrackRowProps {
    track: Track;
    index: number;
    album: Album;
    isOwned: boolean;
    isPlaying: boolean;
    isPreviewPlaying: boolean;
    colors: ColorPalette | null;
    onPlayTrack: (track: Track, index: number) => void;
    onAddToQueue: (track: Track) => void;
    onAddToPlaylist: (trackId: string) => void;
    onPreview: (track: Track, e: React.MouseEvent) => void;
}



const TrackRow = memo(
    function TrackRow({
        track,
        index,
        album,
        isOwned,
        isPlaying,
        isPreviewPlaying,
        colors,
        onPlayTrack,
        onAddToQueue,
        onAddToPlaylist,
        onPreview,
    }: TrackRowProps) {
        const isMissingTrack = !!track.isMissing;
        const isPreviewOnly = !isOwned || isMissingTrack;
        const displayTrackNumber =
            typeof track.trackNumber === "number" ? track.trackNumber : index + 1;

        const handleAddToQueue = useCallback(
            (e: React.MouseEvent) => {
                e.stopPropagation();
                onAddToQueue(track);
            },
            [track, onAddToQueue]
        );

        const handleAddToPlaylist = useCallback(
            (e: React.MouseEvent) => {
                e.stopPropagation();
                onAddToPlaylist(track.id);
            },
            [track.id, onAddToPlaylist]
        );

        const handlePreview = useCallback(
            (e: React.MouseEvent) => {
                onPreview(track, e);
            },
            [track, onPreview]
        );

        const handlePlayTrack = useCallback(() => {
            onPlayTrack(track, index);
        }, [track, index, onPlayTrack]);

        const handleRowClick = useCallback(
            (e: React.MouseEvent) => {
                // For unowned tracks, play preview instead of local file
                if (isPreviewOnly) {
                    onPreview(track, e);
                } else {
                    onPlayTrack(track, index);
                }
            },
            [isPreviewOnly, track, index, onPlayTrack, onPreview]
        );

        return (
            <div
                data-track-row
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className={cn(
                    "group relative flex items-center gap-3 md:gap-4 px-3 md:px-4 py-3 hover:bg-[#141414] transition-colors cursor-pointer",
                    isPlaying && "bg-[#1a1a1a] border-l-2",
                    isPreviewOnly && "opacity-70 hover:opacity-90"
                )}
                style={
                    isPlaying
                        ? { borderLeftColor: colors?.vibrant || "#a855f7" }
                        : undefined
                }
                onDoubleClick={handleRowClick}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        if (isPreviewOnly) {
                            onPreview(track, e as unknown as React.MouseEvent);
                        } else {
                            handlePlayTrack();
                        }
                    }
                }}
            >
                <div className="w-6 md:w-8 flex-shrink-0 text-center">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            handleRowClick(e);
                        }}
                        className="w-full flex items-center justify-center"
                        aria-label={isPlaying ? "Pause" : "Play"}
                    >
                        <span
                            className={cn(
                                "group-hover:hidden text-sm",
                                isPlaying
                                    ? "text-purple-400 font-bold"
                                    : "text-gray-500"
                            )}
                        >
                            {displayTrackNumber}
                        </span>
                        <Play
                            className="hidden group-hover:inline-block w-4 h-4 text-white"
                            fill="currentColor"
                        />
                    </button>
                </div>

                <div className="flex-1 min-w-0">
                    <div
                        className={cn(
                            "font-medium truncate text-sm md:text-base flex items-center gap-2",
                            isPlaying ? "text-purple-400" : "text-white"
                        )}
                    >
                        <span className="truncate">
                            {track.displayTitle ?? track.title}
                        </span>
                        {isMissingTrack && (
                            <span className="shrink-0 text-[10px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded border border-amber-500/30 font-medium">
                                MISSING
                            </span>
                        )}
                        {isPreviewOnly && (
                            <span className="shrink-0 text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/30 font-medium">
                                PREVIEW
                            </span>
                        )}
                    </div>
                    {track.artist?.name &&
                        track.artist.name !== album.artist?.name && (
                            <div className="text-xs md:text-sm text-gray-400 truncate">
                                {track.artist.name}
                            </div>
                        )}
                </div>

                {isOwned &&
                    track.playCount !== undefined &&
                    track.playCount > 0 && (
                        <div className="hidden lg:flex items-center gap-1.5 text-xs text-gray-400 bg-[#1a1a1a] px-2 py-1 rounded-full">
                            <Play className="w-3 h-3" />
                            <span>{formatNumber(track.playCount)}</span>
                        </div>
                    )}

                {isOwned && !isMissingTrack && (
                    <>
                        <button
                            onClick={handleAddToQueue}
                            className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-2 hover:bg-[#2a2a2a] rounded-full transition-all text-gray-400 hover:text-white"
                            aria-label="Add to queue"
                            title="Add to queue"
                        >
                            <ListPlus className="w-4 h-4" />
                        </button>
                        <button
                            onClick={handleAddToPlaylist}
                            className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-2 hover:bg-[#2a2a2a] rounded-full transition-all text-gray-400 hover:text-white"
                            aria-label="Add to playlist"
                            title="Add to playlist"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                    </>
                )}

                {isPreviewOnly ? (
                    <button
                        onClick={handlePreview}
                        className="p-2 rounded-full bg-[#1a1a1a] hover:bg-[#2a2a2a] transition-colors text-white"
                        aria-label={
                            isPreviewPlaying ? "Pause preview" : "Play preview"
                        }
                    >
                        {isPreviewPlaying ? (
                            <Pause className="w-4 h-4" />
                        ) : (
                            <Volume2 className="w-4 h-4" />
                        )}
                    </button>
                ) : null}

                {track.duration && (
                    <div className="text-xs md:text-sm text-gray-400 w-10 md:w-12 text-right font-mono tabular-nums">
                        {formatTime(track.duration)}
                    </div>
                )}
            </div>
        );
    },
    (prevProps, nextProps) => {
        return (
            prevProps.track.id === nextProps.track.id &&
            prevProps.isPlaying === nextProps.isPlaying &&
            prevProps.isPreviewPlaying === nextProps.isPreviewPlaying &&
            prevProps.index === nextProps.index &&
            prevProps.isOwned === nextProps.isOwned
        );
    }
);

export const TrackList = memo(function TrackList({
    tracks,
    album,
    source,
    currentTrackId,
    colors,
    onPlayTrack,
    onAddToQueue,
    onAddToPlaylist,
    previewTrack,
    previewPlaying,
    onPreview,
}: TrackListProps) {
    const isOwned = source === "library";

    return (
        <section>
            <Card>
                <div
                    data-tv-section="tracks"
                    className="divide-y divide-[#1c1c1c]"
                >
                    {tracks.map((track, index) => {
                        const isPlaying = currentTrackId === track.id;
                        const isPreviewPlaying =
                            previewTrack === track.id && previewPlaying;

                        return (
                            <TrackRow
                                key={track.id}
                                track={track}
                                index={index}
                                album={album}
                                isOwned={isOwned}
                                isPlaying={isPlaying}
                                isPreviewPlaying={isPreviewPlaying}
                                colors={colors}
                                onPlayTrack={onPlayTrack}
                                onAddToQueue={onAddToQueue}
                                onAddToPlaylist={onAddToPlaylist}
                                onPreview={onPreview}
                            />
                        );
                    })}
                </div>
            </Card>
        </section>
    );
});
