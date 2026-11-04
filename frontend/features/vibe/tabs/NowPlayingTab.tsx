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
import { useMediaInfo } from "@/hooks/useMediaInfo";
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

/**
 * What is playing, led by its artwork with the title laid over it, as the page's radio tiles do. `compact` gives the
 * lyrics and the artist's story the room; the artwork narrows to a band.
 */
export function NowPlayingHero({ compact = false }: { compact?: boolean }) {
    const { title, subtitle, coverUrl, mediaLink, hasMedia } = useMediaInfo(640);
    const { isPlaying } = useAudioPlayback();
    const { pause, resumeWithGesture } = useAudioControls();

    if (!hasMedia) {
        return (
            <div className="flex h-12 shrink-0 items-center pl-3 pr-10">
                <p className="t-body">nothing playing yet</p>
            </div>
        );
    }

    return (
        <div
            data-queue-now
            className={cn(
                "relative shrink-0 overflow-hidden rounded-lg bg-[var(--bg-secondary)] transition-[height] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
                compact ? "h-[88px]" : "h-[min(380px,40dvh)]",
            )}
        >
            {coverUrl ? (
                <CachedImage src={coverUrl} alt="" fill sizes="380px" className="object-cover" />
            ) : (
                <Music aria-hidden="true" className="absolute inset-0 m-auto h-12 w-12 text-white/10" />
            )}
            <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-3/5 min-h-[88px] bg-gradient-to-t from-black via-black/70 to-transparent" />
            {/* Compact, the play button steps left of the panel's hide button. */}
            <div className={cn("absolute inset-x-0 bottom-0 flex items-end gap-3 p-3", compact && "pr-11")}>
                <div className="min-w-0 flex-1">
                    {mediaLink ? (
                        <Link
                            href={mediaLink}
                            prefetch={false}
                            className="block truncate rounded text-xl font-bold tracking-tight text-white outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/60"
                        >
                            {title}
                        </Link>
                    ) : (
                        <p className="truncate text-xl font-bold tracking-tight text-white">{title}</p>
                    )}
                    <p className="truncate text-sm text-white/75">{subtitle}</p>
                </div>
                <button
                    type="button"
                    onClick={() => (isPlaying ? pause() : resumeWithGesture())}
                    aria-label={isPlaying ? "pause" : "play"}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-[var(--color-on-brand)] outline-none transition-colors duration-150 hover:bg-brand-hover focus-visible:ring-2 focus-visible:ring-white/80"
                >
                    {isPlaying ? (
                        <Pause aria-hidden="true" className="h-4 w-4 fill-current" />
                    ) : (
                        <Play aria-hidden="true" className="ml-0.5 h-4 w-4 fill-current" />
                    )}
                </button>
            </div>
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
            <p className="mb-1.5 text-sm font-bold tracking-tight text-white">{currentTrack.artist?.name}</p>
            {bio ? (
                <ArtistBio bio={bio} artistId={artistId} />
            ) : (
                <p className="text-xs text-[var(--text-muted)]">no biography for this artist yet</p>
            )}
        </div>
    );
}
