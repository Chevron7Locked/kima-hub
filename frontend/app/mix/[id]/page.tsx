"use client";

import { useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAudioState, useAudioPlayback, useAudioControls } from "@/lib/audio-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { Play, Pause, Music, Shuffle, Save, ListPlus } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatTime, plural } from "@/lib/format";
import { shuffleArray } from "@/lib/shuffle";
import { notify } from "@/lib/notify";
import { useMixQuery } from "@/hooks/useQueries";
import { useDoubleTapList } from "@/hooks/useDoubleTap";
import { CachedImage } from "@/components/ui/CachedImage";
import { PageMessage } from "@/components/ui/PageMessage";
import { EmptyState } from "@/components/ui/EmptyState";

interface MixTrack {
    id: string;
    title: string;
    duration: number;
    albumId: string;
    album: {
        title: string;
        coverUrl?: string;
        artist: {
            id: string;
            name: string;
        };
    };
}

export default function MixPage() {
    const params = useParams();
    const router = useRouter();
    const mixId = params.id as string;
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, addToQueue, pause, resumeWithGesture } = useAudioControls();

    const { data: mix, isLoading, error, refetch } = useMixQuery(mixId);
    const [isSaving, setIsSaving] = useState(false);

    const mixTracks = mix?.tracks;
    const totalDuration = useMemo(() => {
        if (!mixTracks) return 0;
        return mixTracks.reduce((sum: number, track: MixTrack) => sum + (track.duration || 0), 0);
    }, [mixTracks]);

    const formatTotalDuration = (seconds: number) => {
        const total = Math.max(1, Math.round(seconds / 60));
        const hours = Math.floor(total / 60);
        const mins = total % 60;
        if (hours === 0) return `${mins} min`;
        return mins === 0 ? `${hours} hr` : `${hours} hr ${mins} min`;
    };

    const mixTrackIds = useMemo(() => {
        return new Set(mix?.tracks?.map((track: MixTrack) => track.id) || []);
    }, [mix?.tracks]);

    const isThisMixPlaying = useMemo(() => {
        if (!isPlaying || !currentTrack || !mix?.tracks?.length) return false;
        return mixTrackIds.has(currentTrack.id);
    }, [isPlaying, currentTrack, mixTrackIds, mix?.tracks?.length]);

    const formatTracksForPlayback = (tracks: MixTrack[]) => {
        return tracks.map((track) => ({
            id: track.id,
            title: track.title,
            artist: {
                name: track.album.artist.name,
                id: track.album.artist.id,
            },
            album: {
                title: track.album.title,
                coverArt: track.album.coverUrl,
                id: track.albumId,
            },
            duration: track.duration,
        }));
    };

    const handlePlayMix = () => {
        if (!mix?.tracks || mix.tracks.length === 0) return;

        if (isThisMixPlaying) {
            if (isPlaying) {
                pause();
            } else {
                resumeWithGesture();
            }
            return;
        }

        const tracks = formatTracksForPlayback(mix.tracks);
        playTracks(tracks, 0);
    };

    const handlePlayTrack = (index: number) => {
        if (!mix?.tracks || mix.tracks.length === 0) return;
        const tracks = formatTracksForPlayback(mix.tracks);
        playTracks(tracks, index);
    };

    const handleRowTouchEnd = useDoubleTapList(handlePlayTrack);

    const handleShuffle = () => {
        if (!mix?.tracks) return;
        const tracks = formatTracksForPlayback(mix.tracks);
        const shuffled = shuffleArray(tracks);
        playTracks(shuffled, 0);
    };

    const handleAddToQueue = (track: MixTrack) => addToQueue(formatTracksForPlayback([track])[0]);

    const handleSaveAsPlaylist = async () => {
        if (!mix) return;

        setIsSaving(true);
        try {
            const result = await api.saveMixAsPlaylist(mixId);
            window.dispatchEvent(new Event("playlist-created"));
            setTimeout(() => {
                router.push(`/playlist/${result.id}`);
            }, 1000);
        } catch (error: unknown) {
            console.error("Failed to save mix as playlist:", error);
            const err = error as { status?: number; data?: { playlistId?: string } };
            if (err?.status === 409) {
                notify.info("You've already saved this mix as a playlist.");
                if (err?.data?.playlistId) {
                    setTimeout(() => {
                        router.push(`/playlist/${err.data!.playlistId}`);
                    }, 1000);
                }
            } else {
                notify.error("Failed to save mix as playlist", {
                    message: error instanceof Error ? error.message : undefined,
                });
            }
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!mix) {
        // Only a 404 means the mix is gone (a rebuild makes new mixes); anything else is a failed request.
        return (error as { status?: number } | null)?.status === 404 ? (
            <PageMessage
                title="Mix not found"
                description="This mix no longer exists. Rebuilding mixes replaces them with new ones."
                action={{ label: "Home", href: "/" }}
            />
        ) : (
            <PageMessage
                title="Couldn't load this mix"
                description="The server didn't answer. Try again in a moment."
                action={{ label: "Try again", onClick: () => void refetch() }}
            />
        );
    }

    return (
        <div className="min-h-screen">
            <div
                className="relative pt-16 pb-10 page-shell"
                style={{
                    background: mix.color
                        ? `${mix.color}, linear-gradient(to bottom, transparent, #1a1a1a)`
                        : 'linear-gradient(to bottom, rgba(88, 28, 135, 0.4), #1a1a1a, transparent)'
                }}
            >
                <div className="flex items-end gap-6">
                        <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shrink-0 overflow-hidden">
                            {mix.coverUrls && mix.coverUrls.length > 0 ? (
                                <div className="grid grid-cols-2 gap-0 w-full h-full">
                                    {mix.coverUrls.slice(0, 4).map((url: string, index: number) => {
                                        const proxiedUrl = api.getCoverArtUrl(url, 200);
                                        return (
                                            <div key={index} className="relative bg-[#181818]">
                                                <CachedImage
                                                    src={proxiedUrl}
                                                    alt=""
                                                    fill
                                                    className="object-cover"
                                                    sizes="96px"
                                                />
                                            </div>
                                        );
                                    })}
                                    {Array.from({
                                        length: Math.max(0, 4 - (mix.coverUrls?.length || 0)),
                                    }).map((_, index) => (
                                        <div key={`empty-${index}`} className="relative bg-[#282828]" />
                                    ))}
                                </div>
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <Music className="w-16 h-16 text-[var(--text-muted)]" />
                                </div>
                            )}
                        </div>

                        <div className="flex-1 min-w-0 pb-1">
                            <p className="text-xs font-medium text-[var(--text-primary)] mb-1">Mix</p>
                            <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                                {mix.name}
                            </h1>
                            {mix.description && (
                                <p className="text-sm text-[var(--text-secondary)] mb-2 line-clamp-2">
                                    {mix.description}
                                </p>
                            )}
                            <div className="flex items-center gap-1 text-sm text-[var(--text-secondary)]">
                                <span>{plural(mix.trackCount || mix.tracks?.length || 0, "song")}</span>
                                {totalDuration > 0 && (
                                    <span>, {formatTotalDuration(totalDuration)}</span>
                                )}
                            </div>
                    </div>
                </div>
            </div>

            <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent page-shell py-4">
                <div className="flex items-center gap-4">
                    {mix.tracks && mix.tracks.length > 0 && (
                        <button
                            onClick={handlePlayMix}
                            aria-label={isThisMixPlaying && isPlaying ? `Pause ${mix.name}` : `Play ${mix.name}`}
                            className="h-12 w-12 rounded-full bg-brand hover:bg-brand-hover hover:scale-105 flex items-center justify-center transition-all"
                        >
                            {isThisMixPlaying && isPlaying ? (
                                <Pause className="w-5 h-5 fill-current text-black" />
                            ) : (
                                <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                            )}
                        </button>
                    )}

                    {mix.tracks && mix.tracks.length > 1 && (
                        <button
                            onClick={handleShuffle}
                            aria-label={`Shuffle play ${mix.name}`}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-[var(--text-secondary)] hover:text-white transition-all"
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>
                    )}

                    <button
                        onClick={handleSaveAsPlaylist}
                        disabled={isSaving}
                        className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium bg-white/5 hover:bg-white/10 text-[var(--text-primary)] hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Save className="w-4 h-4" />
                        <span className="hidden sm:inline">
                            {isSaving ? "Saving..." : "Save as Playlist"}
                        </span>
                    </button>
                </div>
            </div>

            <div className="page-shell pb-32">
                {mix.tracks && mix.tracks.length > 0 ? (
                    <div className="w-full">
                        <div className="hidden md:grid grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 text-xs text-[var(--text-secondary)] border-b border-white/10 mb-2">
                            <span className="text-center">#</span>
                            <span>Title</span>
                            <span>Album</span>
                            <span className="text-right">Duration</span>
                        </div>

                        <div>
                            {mix.tracks.map((track: MixTrack, index: number) => {
                                const isCurrentlyPlaying = currentTrack?.id === track.id;
                                return (
                                    <div
                                        key={track.id}
                                        data-track-index={index}
                                        onDoubleClick={() => handlePlayTrack(index)}
                                        onTouchEnd={handleRowTouchEnd}
                                        className={cn(
                                            "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer touch-manipulation",
                                            isCurrentlyPlaying && "bg-white/10"
                                        )}
                                    >
                                        <div className="flex items-center justify-center">
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handlePlayTrack(index);
                                                }}
                                                className="min-h-[44px] min-w-[44px] flex items-center justify-center"
                                                aria-label={isCurrentlyPlaying && isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
                                            >
                                                <span
                                                    className={cn(
                                                        "text-sm group-hover:hidden",
                                                        isCurrentlyPlaying ? "text-brand" : "text-[var(--text-secondary)]"
                                                    )}
                                                >
                                                    {isCurrentlyPlaying && isPlaying ? (
                                                        <Music className="w-4 h-4 text-brand animate-pulse" />
                                                    ) : (
                                                        index + 1
                                                    )}
                                                </span>
                                                <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                            </button>
                                        </div>

                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="relative w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                                                {track.album?.coverUrl ? (
                                                    <CachedImage
                                                        src={api.getCoverArtUrl(track.album.coverUrl, 100)}
                                                        alt={track.title}
                                                        fill
                                                        sizes="40px"
                                                        className="object-cover"
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center">
                                                        <Music className="w-5 h-5 text-[var(--text-muted)]" />
                                                    </div>
                                                )}
                                            </div>
                                            <div className="min-w-0">
                                                <p
                                                    className={cn(
                                                        "text-sm font-medium truncate",
                                                        isCurrentlyPlaying ? "text-brand" : "text-white"
                                                    )}
                                                >
                                                    {track.title}
                                                </p>
                                                <p className="text-xs text-[var(--text-secondary)] truncate">
                                                    {track.album.artist.name}
                                                </p>
                                            </div>
                                        </div>

                                        <p className="hidden md:flex items-center text-sm text-[var(--text-secondary)] truncate">
                                            {track.album.title}
                                        </p>

                                        <div className="flex items-center justify-end gap-2">
                                            <button
                                                className="min-h-[44px] min-w-[44px] rounded-full opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-white/10 text-[var(--text-secondary)] hover:text-white transition-all flex items-center justify-center touch-reveal"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleAddToQueue(track);
                                                }}
                                                aria-label={`Add ${track.title} to queue`}
                                            >
                                                <ListPlus className="w-4 h-4" />
                                            </button>
                                            <span className="text-sm text-[var(--text-secondary)] w-12 text-right">
                                                {formatTime(track.duration)}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ) : (
                    <EmptyState
                        icon={<Music className="w-12 h-12" />}
                        title="No tracks"
                        description="This mix is empty"
                        action={{ label: "Back to Mixes", onClick: () => router.push("/"), variant: "secondary" }}
                    />
                )}
            </div>
        </div>
    );
}
