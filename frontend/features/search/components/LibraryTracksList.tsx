"use client";

import { Play, Pause, Music } from "lucide-react";
import Link from "next/link";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import type { LibraryTrack } from "../types";
import { CachedImage } from "@/components/ui/CachedImage";

interface LibraryTracksListProps {
    tracks: LibraryTrack[];
    /** Rows shown; playing any row still queues every track. */
    limit?: number;
}

export function LibraryTracksList({ tracks, limit }: LibraryTracksListProps) {
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, pause, resumeWithGesture } = useAudioControls();

    if (!tracks || tracks.length === 0) {
        return null;
    }

    const handlePlayTrack = (track: LibraryTrack, index: number) => {
        const formattedTracks = tracks.map((t) => ({
            id: t.id,
            title: t.title,
            displayTitle: t.displayTitle,
            duration: t.duration,
            artist: {
                id: t.album.artist.id,
                name: t.album.artist.name,
            },
            album: {
                id: t.album.id,
                title: t.album.title,
                coverArt: t.album.coverUrl ?? undefined,
            },
        }));

        if (currentTrack?.id === track.id) {
            if (isPlaying) {
                pause();
            } else {
                resumeWithGesture();
            }
        } else {
            playTracks(formattedTracks, index);
        }
    };

    return (
        <div className="space-y-1">
            {tracks.slice(0, limit).map((track, index) => {
                const isCurrentTrack = currentTrack?.id === track.id;
                const isPlayingThis = isCurrentTrack && isPlaying;
                const coverUrl = track.album.coverUrl
                    ? api.getCoverArtUrl(track.album.coverUrl, 48)
                    : null;

                return (
                    <div
                        key={track.id}
                        className={cn(
                            "flex items-center gap-3 p-2 rounded-md group transition-colors",
                            isCurrentTrack ? "bg-white/10" : "hover:bg-white/5"
                        )}
                    >
                        <button
                            onClick={() => handlePlayTrack(track, index)}
                            className="w-10 h-10 flex items-center justify-center flex-shrink-0"
                        >
                            {isPlayingThis ? (
                                <Pause className="w-4 h-4 text-brand" />
                            ) : isCurrentTrack ? (
                                <Play className="w-4 h-4 text-brand ml-0.5" />
                            ) : (
                                <>
                                    <span className="text-sm text-[var(--text-secondary)] group-hover:hidden">
                                        {index + 1}
                                    </span>
                                    <Play className="w-4 h-4 text-white hidden group-hover:block ml-0.5" />
                                </>
                            )}
                        </button>

                        <div className="w-10 h-10 bg-[#181818] rounded overflow-hidden flex-shrink-0">
                            {coverUrl ? (
                                <CachedImage
                                    src={coverUrl}
                                    alt={track.album.title}
                                    width={40}
                                    height={40}
                                    className="object-cover w-full h-full"
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <Music className="w-4 h-4 text-[var(--text-muted)]" />
                                </div>
                            )}
                        </div>

                        <div className="flex-1 min-w-0">
                            <p
                                className={cn(
                                    "text-sm font-medium truncate",
                                    isCurrentTrack
                                        ? "text-brand"
                                        : "text-white"
                                )}
                            >
                                {track.title}
                            </p>
                            <p className="text-xs text-[var(--text-secondary)] truncate">
                                <Link
                                    href={`/artist/${track.album.artist.id}`}
                                    className="hover:underline hover:text-white"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {track.album.artist.name}
                                </Link>
                                <span className="mx-1">•</span>
                                <Link
                                    href={`/album/${track.album.id}`}
                                    className="hover:underline hover:text-white"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {track.album.title}
                                </Link>
                            </p>
                        </div>

                        <span className="text-sm text-[var(--text-secondary)] flex-shrink-0">
                            {formatTime(track.duration)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
