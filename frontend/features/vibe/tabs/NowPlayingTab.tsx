"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { Music } from "lucide-react";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { queryKeys } from "@/hooks/useQueries";
import { CachedImage } from "@/components/ui/CachedImage";

export function NowPlayingTab() {
    const { currentTrack, queue, currentIndex } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const artistId = currentTrack?.artist?.id;

    const { data: artist } = useQuery({
        queryKey: queryKeys.artist(artistId || ""),
        queryFn: () => api.getArtist(artistId as string),
        enabled: !!artistId,
        staleTime: 10 * 60 * 1000,
    });

    const coverUrl = currentTrack?.album?.coverArt
        ? api.getCoverArtUrl(currentTrack.album.coverArt, 200)
        : null;

    if (!currentTrack) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
                <Music className="w-10 h-10 text-[var(--text-muted)] mb-4" />
                <p className="text-sm text-[var(--text-muted)]">
                    Start listening to see what&apos;s playing here
                </p>
            </div>
        );
    }

    const trackNo = currentTrack.displayTrackNo;
    const queueLabel =
        queue.length > 1 ? `${currentIndex + 1} of ${queue.length} in queue` : null;
    const bio =
        (artist as { bio?: string; summary?: string } | undefined)?.bio ||
        (artist as { summary?: string } | undefined)?.summary ||
        "";

    return (
        <div className="flex-1 overflow-y-auto p-4">
            <div className="flex items-start gap-3">
                <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-[#181818]">
                    {coverUrl ? (
                        <CachedImage
                            src={coverUrl}
                            alt={currentTrack.album?.title || "Album art"}
                            fill
                            sizes="96px"
                            className="object-cover"
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center">
                            <Music className="w-8 h-8 text-white/10" />
                        </div>
                    )}
                    {isPlaying && (
                        <div className="absolute bottom-1.5 right-1.5 w-2 h-2 rounded-full bg-brand animate-pulse" />
                    )}
                </div>

                <div className="min-w-0 flex-1">
                    <p className="text-base font-semibold text-white truncate">
                        {currentTrack.title}
                    </p>
                    <p className="text-sm text-[var(--text-secondary)] truncate">
                        {currentTrack.artist?.name || "Unknown Artist"}
                    </p>
                    <p className="text-xs text-[var(--text-secondary)] truncate">
                        {currentTrack.album?.title}
                        {trackNo ? ` · track ${trackNo}` : ""}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                        {formatTime(currentTrack.duration)}
                        {queueLabel ? ` · ${queueLabel}` : ""}
                    </p>
                </div>
            </div>

            {bio && (
                <div className="mt-4 border-t border-white/5 pt-3">
                    <p className="line-clamp-5 text-xs leading-relaxed text-[var(--text-secondary)]">
                        {bio}
                    </p>
                    {artistId && (
                        <Link
                            href={`/artist/${artistId}`}
                            className="mt-1 inline-block text-[11px] text-brand hover:underline"
                        >
                            read more
                        </Link>
                    )}
                </div>
            )}
        </div>
    );
}
