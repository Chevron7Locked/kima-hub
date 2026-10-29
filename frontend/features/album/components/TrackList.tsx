import React, { memo, useCallback, useMemo } from "react";
import { Play, Pause, Volume2, ListPlus, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Track, Album, AlbumSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatNumber, formatTime } from "@/lib/format";
import { useDoubleTap } from "@/hooks/useDoubleTap";
import { cascadeStyle } from "@/lib/motion";
import { shownTitle } from "@/lib/track-title";

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
    onPreview: (track: Track) => void;
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
    onPreview: (track: Track) => void;
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
                e.stopPropagation();
                onPreview(track);
            },
            [track, onPreview]
        );

        const handleRowClick = useCallback(() => {
            if (isPreviewOnly) onPreview(track);
            else onPlayTrack(track, index);
        }, [isPreviewOnly, track, index, onPlayTrack, onPreview]);

        const doubleTapProps = useDoubleTap(handleRowClick);

        return (
            <div
                data-track-row
                data-tv-card
                data-tv-card-index={index}
                data-track-index={index}
                tabIndex={0}
                className={cn(
                    "group grid grid-cols-[40px_minmax(0,1fr)_auto_auto] md:grid-cols-[40px_minmax(0,2fr)_96px_136px_100px] gap-2 md:gap-4 px-4 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2 transition-colors cursor-pointer touch-manipulation",
                    isPlaying && "bg-[var(--bg-hover)] border-l-2",
                    isPreviewOnly && "opacity-70 hover:opacity-90",
                    "animate-rise [animation-delay:calc(var(--i)*var(--stagger))]"
                )}
                style={
                    ((isPlaying
                        ? { "--i": index, borderLeftColor: colors?.vibrant || "#fca200" }
                        : { "--i": index }) as unknown) as React.CSSProperties
                }
                {...doubleTapProps}
                onKeyDown={(e) => {
                    // Enter on a button inside the row belongs to that button.
                    if (e.key === "Enter" && e.target === e.currentTarget) {
                        e.preventDefault();
                        handleRowClick();
                    }
                }}
            >
                {/* Column 1: Track number / play button */}
                <div className="flex items-center justify-center">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            handleRowClick();
                        }}
                        className="w-11 h-11 flex items-center justify-center rounded-lg hover:bg-white/5 transition-colors"
                        aria-label={isPlaying ? "Pause" : "Play"}
                    >
                        <span
                            className={cn(
                                "group-hover:hidden text-sm",
                                isPlaying
                                    ? "text-brand font-bold animate-pulse"
                                    : "text-[var(--text-muted)]"
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

                {/* Column 2: Title + Artist */}
                <div className="flex items-center gap-3 min-w-0">
                    <div className={cn("min-w-0")}>
                        <div
                            className={cn(
                                "font-medium truncate text-sm md:text-base flex items-center gap-2",
                                isPlaying ? "text-brand" : "text-white"
                            )}
                        >
                            <span className="truncate">
                                {shownTitle(track)}
                            </span>
                            {isMissingTrack && (
                                <span className="shrink-0 text-micro bg-warning/20 text-warning px-1.5 py-0.5 rounded border border-warning/30 font-medium">
                                    MISSING
                                </span>
                            )}
                            {isPreviewOnly && (
                                <span className="shrink-0 text-micro bg-white/10 text-[var(--text-secondary)] px-1.5 py-0.5 rounded border border-white/10 font-medium">
                                    Preview
                                </span>
                            )}
                        </div>
                        {track.artist?.name &&
                            track.artist.name !== album.artist?.name && (
                                <div className="text-xs md:text-sm text-[var(--text-secondary)] truncate">
                                    {track.artist.name}
                                </div>
                            )}
                    </div>
                </div>

                {/* Column 3: Play-count badge (hidden below md) */}
                {isOwned &&
                    track.playCount !== undefined &&
                    track.playCount > 0 ? (
                        <div className="hidden md:flex items-center gap-1.5 text-xs text-[var(--text-secondary)] bg-[var(--bg-hover)] px-2 py-1 rounded-full">
                            <Play className="w-3 h-3" />
                            <span>{formatNumber(track.playCount)}</span>
                        </div>
                    ) : (
                        <span aria-hidden="true" className="hidden md:block" />
                    )}

                {/* Column 4: Row actions (Add to queue, Add to playlist) */}
                <div className="flex items-center gap-2 justify-end">
                    {isOwned && !isMissingTrack ? (
                        <>
                            <button
                                onClick={handleAddToQueue}
                                className="p-1.5 rounded-lg hover:bg-white/10 transition-all text-[var(--text-secondary)] hover:text-white"
                                aria-label="Add to queue"
                                title="add to queue"
                            >
                                <ListPlus className="w-4 h-4" />
                            </button>
                            <button
                                onClick={handleAddToPlaylist}
                                className="p-1.5 rounded-lg hover:bg-white/10 transition-all text-[var(--text-secondary)] hover:text-white"
                                aria-label="Add to playlist"
                                title="add to playlist"
                            >
                                <Plus className="w-4 h-4" />
                            </button>
                        </>
                    ) : null}
                    {isPreviewOnly ? (
                        <button
                            onClick={handlePreview}
                            className="p-1.5 rounded-lg bg-[var(--bg-hover)] hover:bg-white/10 transition-colors text-white"
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
                </div>

                {/* Column 5: Duration */}
                {track.duration > 0 && (
                    <span className="self-center text-xs md:text-sm text-[var(--text-secondary)] text-right tabular-nums">
                        {formatTime(track.duration)}
                    </span>
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
    const discNumbers = useMemo(
        () => Array.from(new Set(tracks.map((track) => track.discNumber).filter((disc) => disc != null))),
        [tracks]
    );
    const shouldGroupByDisc = discNumbers.length > 1;

    return (
        <section>
            <div
                data-tv-section="tracks"
                className="divide-y divide-[#1c1c1c]"
                style={cascadeStyle(tracks.length)}
            >
                {tracks.map((track, index) => {
                    const isPlaying = currentTrackId === track.id;
                    const isPreviewPlaying =
                        previewTrack === track.id && previewPlaying;
                    const discNumber = track.discNumber ?? 1;
                    const previousDiscNumber =
                        index > 0 ? tracks[index - 1]?.discNumber ?? 1 : null;
                    const showDiscHeader =
                        shouldGroupByDisc &&
                        (index === 0 || discNumber !== previousDiscNumber);
                    const discLabel = track.discSubtitle?.trim();

                    return (
                        <React.Fragment key={track.id}>
                            {showDiscHeader && (
                                <div className="px-3 md:px-4 py-2 text-xs font-semibold tracking-wide text-[var(--text-secondary)] bg-[#121212]">
                                    Disc {discNumber}{discLabel ? ` -- ${discLabel}` : ""}
                                </div>
                            )}
                            <TrackRow
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
                        </React.Fragment>
                    );
                })}
                </div>
        </section>
    );
});
