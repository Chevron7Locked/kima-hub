"use client";

import { Play, Pause } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import type { LibraryTrack } from "../types";

interface LibraryTracksListProps {
    tracks: LibraryTrack[];
}

export function LibraryTracksList({ tracks }: LibraryTracksListProps) {
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, pause, resumeWithGesture } = useAudioControls();

    if (!tracks || tracks.length === 0) {
        return null;
    }

    const handlePlayTrack = (track: LibraryTrack, index: number) => {
        // Format tracks for playback
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
            // Toggle play/pause if clicking the same track
            if (isPlaying) {
                pause();
            } else {
                resumeWithGesture();
            }
        } else {
            // Play from this track
            playTracks(formattedTracks, index);
        }
    };

    return (
        <div className="space-y-1">
            {tracks.map((track, index) => {
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
                        {/* Play Button / Track Number */}
                        <button
                            onClick={() => handlePlayTrack(track, index)}
                            className="w-8 h-8 flex items-center justify-center flex-shrink-0"
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

                        {/* Cover Art */}
                        <div className="w-10 h-10 bg-[#282828] rounded overflow-hidden flex-shrink-0">
                            {coverUrl ? (
                                <Image
                                    src={coverUrl}
                                    alt={track.album.title}
                                    width={40}
                                    height={40}
                                    className="object-cover w-full h-full"
                                    unoptimized
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <span className="text-[var(--text-muted)] text-xs">
                                        ♪
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* Track Info */}
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
                                    href={`/artist/${
                                        track.album.artist.mbid ||
                                        track.album.artist.id
                                    }`}
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

                        {/* Duration */}
                        <span className="text-sm text-[var(--text-secondary)] flex-shrink-0">
                            {formatTime(track.duration)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
