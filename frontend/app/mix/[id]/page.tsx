"use client";

import { useState, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { api } from "@/lib/api";
import { useAudioState, useAudioPlayback, useAudioControls } from "@/lib/audio-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { Play, Pause, Music, Shuffle, Save, ListPlus } from "lucide-react";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import { shuffleArray } from "@/utils/shuffle";
import { toast } from "sonner";
import { useMixQuery } from "@/hooks/useQueries";

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
    const { playTracks, addToQueue, pause, resume } = useAudioControls();

    const { data: mix, isLoading } = useMixQuery(mixId);
    const [isSaving, setIsSaving] = useState(false);

    // Calculate total duration
    const totalDuration = useMemo(() => {
        if (!mix?.tracks) return 0;
        return mix.tracks.reduce((sum: number, track: MixTrack) => sum + (track.duration || 0), 0);
    }, [mix?.tracks]);

    const formatTotalDuration = (seconds: number) => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `about ${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };


    // Check if this mix is currently playing
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

        // If this mix is playing, toggle pause/resume
        if (isThisMixPlaying) {
            if (isPlaying) {
                pause();
            } else {
                resume();
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

    const handleShuffle = () => {
        if (!mix?.tracks) return;
        const tracks = formatTracksForPlayback(mix.tracks);
        const shuffled = shuffleArray(tracks);
        playTracks(shuffled, 0);
    };

    const handleAddToQueue = (track: MixTrack) => {
        const formattedTrack = {
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
        };
        addToQueue(formattedTrack);
        toast.success(`Added ${track.title} to queue`);
    };

    const handleSaveAsPlaylist = async () => {
        if (!mix) return;

        setIsSaving(true);
        try {
            const result = await api.saveMixAsPlaylist(mixId);
            toast.success(`Saved as "${result.name}" playlist!`);
            window.dispatchEvent(new Event("playlist-created"));
            setTimeout(() => {
                router.push(`/playlist/${result.id}`);
            }, 1000);
        } catch (error: unknown) {
            console.error("Failed to save mix as playlist:", error);
            const err = error as { status?: number; data?: { playlistId?: string } };
            if (err?.status === 409) {
                toast.info("You've already saved this mix as a playlist.");
                if (err?.data?.playlistId) {
                    setTimeout(() => {
                        router.push(`/playlist/${err.data!.playlistId}`);
                    }, 1000);
                }
            } else if (error instanceof Error) {
                toast.error(error.message);
            } else {
                toast.error("Failed to save mix as playlist");
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
        return (
            <div className="flex items-center justify-center min-h-screen">
                <p className="text-gray-500">Mix not found</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            {/* Compact Hero - Spotify Style */}
            <div 
                className="relative pt-16 pb-10 px-4 md:px-8"
                style={{ 
                    background: mix.color 
                        ? `${mix.color}, linear-gradient(to bottom, transparent, #1a1a1a)` 
                        : 'linear-gradient(to bottom, rgba(88, 28, 135, 0.4), #1a1a1a, transparent)' 
                }}
            >
                <div className="flex items-end gap-6">
                        {/* Cover Art Mosaic */}
                        <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shadow-2xl shrink-0 overflow-hidden">
                            {mix.coverUrls && mix.coverUrls.length > 0 ? (
                                <div className="grid grid-cols-2 gap-0 w-full h-full">
                                    {mix.coverUrls.slice(0, 4).map((url: string, index: number) => {
                                        const proxiedUrl = api.getCoverArtUrl(url, 200);
                                        return (
                                            <div key={index} className="relative bg-[#181818]">
                                                <Image
                                                    src={proxiedUrl}
                                                    alt=""
                                                    fill
                                                    className="object-cover"
                                                    sizes="96px"
                                                    unoptimized
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
                                    <Music className="w-16 h-16 text-gray-600" />
                                </div>
                            )}
                        </div>

                        {/* Mix Info - Bottom Aligned */}
                        <div className="flex-1 min-w-0 pb-1">
                            <p className="text-xs font-medium text-white/90 mb-1">Mix</p>
                            <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                                {mix.name}
                            </h1>
                            {mix.description && (
                                <p className="text-sm text-white/60 mb-2 line-clamp-2">
                                    {mix.description}
                                </p>
                            )}
                            <div className="flex items-center gap-1 text-sm text-white/70">
                                <span>{mix.trackCount || mix.tracks?.length || 0} songs</span>
                                {totalDuration > 0 && (
                                    <span>, {formatTotalDuration(totalDuration)}</span>
                                )}
                            </div>
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent px-4 md:px-8 py-4">
                <div className="flex items-center gap-4">
                    {/* Play Button */}
                    {mix.tracks && mix.tracks.length > 0 && (
                        <button
                            onClick={handlePlayMix}
                            className="h-12 w-12 rounded-full bg-[#ecb200] hover:bg-[#d4a000] hover:scale-105 flex items-center justify-center shadow-lg transition-all"
                        >
                            {isThisMixPlaying && isPlaying ? (
                                <Pause className="w-5 h-5 fill-current text-black" />
                            ) : (
                                <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                            )}
                        </button>
                    )}

                    {/* Shuffle Button */}
                    {mix.tracks && mix.tracks.length > 1 && (
                        <button
                            onClick={handleShuffle}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Shuffle play"
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>
                    )}

                    {/* Save as Playlist Button */}
                    <button
                        onClick={handleSaveAsPlaylist}
                        disabled={isSaving}
                        className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium bg-white/5 hover:bg-white/10 text-white/80 hover:text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Save className="w-4 h-4" />
                        <span className="hidden sm:inline">
                            {isSaving ? "Saving..." : "Save as Playlist"}
                        </span>
                    </button>
                </div>
            </div>

            {/* Track Listing */}
            <div className="px-4 md:px-8 pb-32">
                {mix.tracks && mix.tracks.length > 0 ? (
                    <div className="w-full">
                        {/* Table Header */}
                        <div className="hidden md:grid grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 text-xs text-gray-400 uppercase tracking-wider border-b border-white/10 mb-2">
                            <span className="text-center">#</span>
                            <span>Title</span>
                            <span>Album</span>
                            <span className="text-right">Duration</span>
                        </div>

                        {/* Track Rows */}
                        <div>
                            {mix.tracks.map((track: MixTrack, index: number) => {
                                const isCurrentlyPlaying = currentTrack?.id === track.id;
                                return (
                                    <div
                                        key={track.id}
                                        onDoubleClick={() => handlePlayTrack(index)}
                                        className={cn(
                                            "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer",
                                            isCurrentlyPlaying && "bg-white/10"
                                        )}
                                    >
                                        {/* Track Number / Play Button */}
                                        <div className="flex items-center justify-center">
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handlePlayTrack(index);
                                                }}
                                                className="w-8 h-8 flex items-center justify-center"
                                                aria-label="Play"
                                            >
                                                <span
                                                    className={cn(
                                                        "text-sm group-hover:hidden",
                                                        isCurrentlyPlaying ? "text-[#ecb200]" : "text-gray-400"
                                                    )}
                                                >
                                                    {isCurrentlyPlaying && isPlaying ? (
                                                        <Music className="w-4 h-4 text-[#ecb200] animate-pulse" />
                                                    ) : (
                                                        index + 1
                                                    )}
                                                </span>
                                                <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                            </button>
                                        </div>

                                        {/* Title + Artist */}
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="relative w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                                                {track.album?.coverUrl ? (
                                                    <Image
                                                        src={api.getCoverArtUrl(track.album.coverUrl, 100)}
                                                        alt={track.title}
                                                        fill
                                                        sizes="40px"
                                                        className="object-cover"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center">
                                                        <Music className="w-5 h-5 text-gray-600" />
                                                    </div>
                                                )}
                                            </div>
                                            <div className="min-w-0">
                                                <p
                                                    className={cn(
                                                        "text-sm font-medium truncate",
                                                        isCurrentlyPlaying ? "text-[#ecb200]" : "text-white"
                                                    )}
                                                >
                                                    {track.title}
                                                </p>
                                                <p className="text-xs text-gray-400 truncate">
                                                    {track.album.artist.name}
                                                </p>
                                            </div>
                                        </div>

                                        {/* Album (hidden on mobile) */}
                                        <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                                            {track.album.title}
                                        </p>

                                        {/* Duration + Actions */}
                                        <div className="flex items-center justify-end gap-2">
                                            <button
                                                className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-400 hover:text-white transition-all"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleAddToQueue(track);
                                                }}
                                                title="Add to Queue"
                                            >
                                                <ListPlus className="w-4 h-4" />
                                            </button>
                                            <span className="text-sm text-gray-400 w-12 text-right">
                                                {formatTime(track.duration)}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-20 h-20 bg-[#282828] rounded-full flex items-center justify-center mb-4">
                            <Music className="w-10 h-10 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-1">No tracks</h3>
                        <p className="text-sm text-gray-500">This mix is empty</p>
                    </div>
                )}
            </div>
        </div>
    );
}
