"use client";

import Image from "next/image";
import Link from "next/link";
import { Music, Play, ListMusic, AudioWaveform, X } from "lucide-react";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";

export function QueueTab() {
    const { queue, currentTrack, currentIndex, playbackType } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, removeFromQueue } = useAudioControls();

    const upNextTracks = queue.slice(currentIndex + 1);

    const handlePlayFromQueue = (queueIndex: number) => {
        playTracks(queue, queueIndex);
    };

    // Non-track playback (podcast/audiobook) — queue tab is track-only
    if (playbackType && playbackType !== "track") {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
                <ListMusic className="w-8 h-8 text-gray-700" />
                <p className="text-xs font-mono text-gray-600">
                    Queue is only available for music tracks
                </p>
            </div>
        );
    }

    if (!currentTrack && queue.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
                <ListMusic className="w-8 h-8 text-gray-700" />
                <p className="text-xs font-mono text-gray-600">
                    No tracks in queue
                </p>
                <p className="text-[11px] text-gray-700">
                    Start playing music to see what&apos;s up next
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            {/* Now Playing */}
            {currentTrack && (
                <div className="px-3 pt-3 pb-2">
                    <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-gray-600 mb-2 px-1">
                        Now Playing
                    </p>
                    <div className="flex items-center gap-3 px-2 py-2.5 bg-[#111] border-l-2 border-[#eab308] rounded-sm">
                        {/* Cover Art */}
                        <div className="relative flex-shrink-0 w-10 h-10">
                            {currentTrack.album?.coverArt ? (
                                <Image
                                    src={api.getCoverArtUrl(
                                        currentTrack.album.coverArt,
                                        80
                                    )}
                                    alt={currentTrack.album.title}
                                    fill
                                    sizes="40px"
                                    className="object-cover rounded-sm"
                                    unoptimized
                                />
                            ) : (
                                <div className="w-10 h-10 bg-[#1a1a1a] rounded-sm flex items-center justify-center">
                                    <Music className="w-4 h-4 text-gray-600" />
                                </div>
                            )}
                            {/* Playing indicator overlay */}
                            {isPlaying && (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-sm">
                                    <AudioWaveform className="w-4 h-4 text-[#eab308] animate-pulse" />
                                </div>
                            )}
                        </div>

                        {/* Track Info */}
                        <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-[#eab308] truncate">
                                {currentTrack.displayTitle ?? currentTrack.title}
                            </p>
                            <p className="text-[11px] text-gray-500 truncate">
                                {currentTrack.artist?.name}
                            </p>
                        </div>

                        {/* Duration */}
                        <span className="text-[11px] text-gray-600 font-mono shrink-0">
                            {currentTrack.duration
                                ? formatTime(currentTrack.duration)
                                : "--:--"}
                        </span>
                    </div>
                </div>
            )}

            {/* Up Next */}
            {upNextTracks.length > 0 ? (
                <div className="px-3 pt-2 pb-3">
                    <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-gray-600 mb-2 px-1">
                        Up Next{" "}
                        <span className="text-gray-700">· {upNextTracks.length}</span>
                    </p>
                    <div className="space-y-0.5">
                        {upNextTracks.map((track, idx) => {
                            const queueIndex = currentIndex + 1 + idx;
                            return (
                                <div
                                    key={`${track.id}-${queueIndex}`}
                                    className="flex items-center gap-2.5 px-2 py-2 hover:bg-[#141414] transition-colors rounded-sm group"
                                >
                                    {/* Position number */}
                                    <span className="text-[11px] text-gray-700 font-mono w-4 shrink-0 text-center">
                                        {idx + 1}
                                    </span>

                                    {/* Cover Art - click to play */}
                                    <button
                                        onClick={() => handlePlayFromQueue(queueIndex)}
                                        className="relative flex-shrink-0 w-9 h-9 focus:outline-none"
                                        title={`Play ${track.displayTitle ?? track.title}`}
                                    >
                                        {track.album?.coverArt ? (
                                            <Image
                                                src={api.getCoverArtUrl(
                                                    track.album.coverArt,
                                                    80
                                                )}
                                                alt={track.album.title}
                                                fill
                                                sizes="36px"
                                                className="object-cover rounded-sm"
                                                unoptimized
                                            />
                                        ) : (
                                            <div className="w-9 h-9 bg-[#1a1a1a] rounded-sm flex items-center justify-center">
                                                <Music className="w-3.5 h-3.5 text-gray-600" />
                                            </div>
                                        )}
                                        {/* Play hover overlay */}
                                        <div className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity rounded-sm">
                                            <Play className="w-3.5 h-3.5 text-white fill-white" />
                                        </div>
                                    </button>

                                    {/* Track Info - click to play */}
                                    <button
                                        onClick={() => handlePlayFromQueue(queueIndex)}
                                        className="flex-1 min-w-0 text-left focus:outline-none"
                                    >
                                        <p
                                            className={cn(
                                                "text-xs font-medium truncate transition-colors",
                                                "text-white/70 group-hover:text-white"
                                            )}
                                        >
                                            {track.displayTitle ?? track.title}
                                        </p>
                                        <p className="text-[11px] text-gray-600 truncate">
                                            {track.artist?.name}
                                        </p>
                                    </button>

                                    {/* Duration */}
                                    <span className="text-[11px] text-gray-700 font-mono shrink-0">
                                        {track.duration
                                            ? formatTime(track.duration)
                                            : "--:--"}
                                    </span>

                                    {/* Remove button */}
                                    <button
                                        onClick={() => removeFromQueue(queueIndex)}
                                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-white/10 rounded text-gray-600 hover:text-red-400 shrink-0"
                                        title="Remove from queue"
                                    >
                                        <X className="w-3 h-3" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : (
                currentTrack && (
                    <div className="px-4 pt-3 pb-2">
                        <p className="text-[11px] font-mono text-gray-700 italic">
                            Nothing queued after this track
                        </p>
                    </div>
                )
            )}

            <div className="mt-auto px-3 py-3 border-t border-white/5">
                <Link
                    href="/queue"
                    className="block w-full text-center text-[11px] font-mono text-gray-600 hover:text-gray-400 transition-colors py-1"
                >
                    View full queue →
                </Link>
            </div>
        </div>
    );
}
