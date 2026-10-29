"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Music, Pause, Play } from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { queryKeys } from "@/hooks/useQueries";
import { CachedImage } from "@/components/ui/CachedImage";
import { shownTitle } from "@/lib/track-title";

export function NowPlayingTab() {
    const { currentTrack, queue, currentIndex } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const artistId = currentTrack?.artist?.id;

    const bio = useArtistBio(artistId);

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
                        {shownTitle(currentTrack)}
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
                    <ArtistBio bio={bio} artistId={artistId} />
                </div>
            )}
        </div>
    );
}

function useArtistBio(artistId: string | undefined): string {
    const { data: artist } = useQuery({
        queryKey: queryKeys.artist(artistId || ""),
        queryFn: () => api.getArtist(artistId as string),
        enabled: !!artistId,
        staleTime: 10 * 60 * 1000,
    });
    const found = artist as { bio?: string; summary?: string } | undefined;
    return found?.bio || found?.summary || "";
}

function ArtistBio({ bio, artistId }: { bio: string; artistId?: string }) {
    return (
        <>
            <p className="line-clamp-5 text-xs leading-relaxed text-[var(--text-secondary)]">{bio}</p>
            {artistId && (
                <Link href={`/artist/${artistId}`} className="mt-1 inline-block text-[11px] text-brand hover:underline">
                    read more
                </Link>
            )}
        </>
    );
}

/** The playing song as one compact row: cover, title, artist and album, and play or pause. */
export function NowPlayingStrip() {
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { pause, resume } = useAudioControls();

    if (!currentTrack) {
        return (
            <div className="flex h-[68px] shrink-0 items-center gap-3 px-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-white/[0.04]">
                    <Music aria-hidden="true" className="h-4 w-4 text-[var(--text-muted)]" />
                </span>
                <p className="text-xs text-[var(--text-muted)]">nothing playing yet</p>
            </div>
        );
    }

    const cover = currentTrack.album?.coverArt;
    return (
        <div data-queue-now className="flex h-[68px] shrink-0 items-center gap-3 px-3">
            <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md bg-white/[0.04] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
                {cover ? (
                    <CachedImage src={api.getCoverArtUrl(cover, 120)} alt="" fill sizes="48px" className="object-cover" />
                ) : (
                    <Music aria-hidden="true" className="absolute inset-0 m-auto h-4 w-4 text-[var(--text-muted)]" />
                )}
            </span>
            <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium tracking-[-0.01em] text-[var(--text-primary)]">
                    {shownTitle(currentTrack)}
                </p>
                <p className="truncate text-xs text-[var(--text-secondary)]">
                    {[currentTrack.artist?.name, currentTrack.album?.title].filter(Boolean).join(" · ")}
                </p>
            </div>
            <button
                type="button"
                onClick={() => (isPlaying ? pause() : resume())}
                aria-label={isPlaying ? "pause" : "play"}
                className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-brand/60",
                    isPlaying
                        ? "bg-brand text-black hover:bg-brand/90"
                        : "bg-white/[0.08] text-[var(--text-primary)] hover:bg-white/[0.12]",
                )}
            >
                {isPlaying ? (
                    <Pause aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
                ) : (
                    <Play aria-hidden="true" className="ml-0.5 h-3.5 w-3.5 fill-current" />
                )}
            </button>
        </div>
    );
}

/** What the panel knows about the playing song's artist. */
export function ArtistAbout() {
    const { currentTrack } = useAudioState();
    const artistId = currentTrack?.artist?.id;
    const bio = useArtistBio(artistId);
    if (!currentTrack) return <p className="px-3 py-4 text-xs text-[var(--text-muted)]">play something to see its artist here</p>;
    return (
        <div className="px-3 py-3">
            <p className="mb-1.5 text-xs font-medium text-[var(--text-primary)]">{currentTrack.artist?.name}</p>
            {bio ? (
                <ArtistBio bio={bio} artistId={artistId} />
            ) : (
                <p className="text-xs text-[var(--text-muted)]">no biography for this artist yet</p>
            )}
        </div>
    );
}
