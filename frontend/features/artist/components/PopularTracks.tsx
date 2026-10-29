import React from "react";
import { TrackRow } from "@/components/ui/TrackRow";
import { Play, Pause, Volume2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Track, Artist } from "../types";
import { formatNumber } from "@/lib/format";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { cascadeStyle } from "@/lib/motion";
import { useDoubleTapList } from "@/hooks/useDoubleTap";
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
                        <TrackRow
                            key={track.id}
                            rowProps={{
                                "data-track-row": true,
                                "data-tv-card": true,
                                "data-tv-card-index": index,
                                "data-track-index": index,
                                tabIndex: 0,
                            }}
                            className="animate-rise [animation-delay:calc(var(--i)*var(--stagger))]"
                            style={{ "--i": index } as unknown as React.CSSProperties}
                            onDoubleClick={() => activate(track)}
                            onTouchEnd={onTouchEnd}
                            columns="grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(80px,1fr)_80px]"
                            index={index}
                            current={isPlaying}
                            playing={isPlaying}
                            onPlay={() => activate(track)}
                            title={shownTitle(track)}
                            subtitle={artist.name}
                            coverUrl={coverUrl}
                            titleBadge={
                                isUnowned ? (
                                    <span className="shrink-0 text-micro bg-white/10 text-[var(--text-secondary)] px-1.5 py-0.5 rounded font-medium">
                                        Preview
                                    </span>
                                ) : undefined
                            }
                            extras={[
                                track.playCount !== undefined && track.playCount > 0 ? (
                                    <span key="plays" className="flex items-center gap-1">
                                        <Play className="w-3 h-3" />
                                        {formatNumber(track.playCount)}
                                    </span>
                                ) : null,
                            ]}
                            duration={track.duration}
                            actions={
                                isUnowned ? (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onPreview(track);
                                        }}
                                        aria-label={isPreviewPlaying ? `stop the preview of ${shownTitle(track)}` : `play a preview of ${shownTitle(track)}`}
                                        className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-hover:translate-y-0 focus-visible:translate-y-0 can-hover:translate-y-1 transition-[opacity,transform] duration-150 hover:bg-white/10 text-[var(--text-secondary)] hover:text-white touch-reveal"
                                    >
                                        {isPreviewPlaying ? <Pause className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                                    </button>
                                ) : undefined
                            }
                        />
                    );
                })}
            </div>
        </section>
    );
};
