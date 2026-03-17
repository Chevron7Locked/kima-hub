"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { Music } from "lucide-react";
import Image from "next/image";
import { api } from "@/lib/api";

export function NowPlayingTab() {
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();

    const coverUrl = currentTrack?.album?.coverArt
        ? api.getCoverArtUrl(currentTrack.album.coverArt, 300)
        : null;

    if (!currentTrack) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
                <Music className="w-10 h-10 text-white/15 mb-4" />
                <p className="text-sm text-white/30">
                    Start listening to see what&apos;s playing here
                </p>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto">
            <div className="p-4 space-y-4">
                {/* Album art */}
                <div className="relative aspect-square w-full max-w-[280px] mx-auto rounded-lg overflow-hidden bg-[#181818]">
                    {coverUrl ? (
                        <Image
                            src={coverUrl}
                            alt={currentTrack.album?.title || "Album art"}
                            fill
                            sizes="280px"
                            className="object-cover"
                            unoptimized
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center">
                            <Music className="w-16 h-16 text-white/10" />
                        </div>
                    )}
                    {isPlaying && (
                        <div className="absolute bottom-2 right-2 w-2.5 h-2.5 rounded-full bg-[#1db954] animate-pulse" />
                    )}
                </div>

                {/* Track info */}
                <div className="text-center">
                    <p className="text-lg font-semibold text-white truncate">
                        {currentTrack.title}
                    </p>
                    <p className="text-sm text-white/70 truncate">
                        {currentTrack.artist?.name || "Unknown Artist"}
                    </p>
                    <p className="text-xs text-white/50 truncate">
                        {currentTrack.album?.title}
                    </p>
                </div>
            </div>
        </div>
    );
}
