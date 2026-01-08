"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/api";
import { useAudio } from "@/lib/audio-context";
import { cn } from "@/utils/cn";
import { usePlaylistQuery } from "@/hooks/useQueries";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/lib/toast-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import {
    Play,
    Pause,
    Trash2,
    Shuffle,
    Eye,
    EyeOff,
    ListPlus,
    ListMusic,
    Music,
    Clock,
    Volume2,
    RefreshCw,
    AlertCircle,
    X,
    Loader2,
} from "lucide-react";

interface Track {
    id: string;
    title: string;
    duration: number;
    album: {
        id?: string;
        title: string;
        coverArt?: string;
        artist: {
            id?: string;
            name: string;
        };
    };
}

interface PlaylistItem {
    id: string;
    track: Track;
    type?: "track";
    sort?: number;
}

interface PendingTrack {
    id: string;
    type: "pending";
    sort: number;
    pending: {
        id: string;
        artist: string;
        title: string;
        album: string;
        previewUrl: string | null;
    };
}

export default function PlaylistDetailPage() {
    const params = useParams();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { playTracks, addToQueue, currentTrack, isPlaying, pause, resume } =
        useAudio();
    const playlistId = params.id as string;

    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isHiding, setIsHiding] = useState(false);
    const [playingPreviewId, setPlayingPreviewId] = useState<string | null>(
        null
    );
    const [retryingTrackId, setRetryingTrackId] = useState<string | null>(null);
    const [removingTrackId, setRemovingTrackId] = useState<string | null>(null);
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);

    // Clean up preview audio on unmount
    useEffect(() => {
        return () => {
            if (previewAudioRef.current) {
                previewAudioRef.current.pause();
                previewAudioRef.current = null;
            }
        };
    }, []);

    // Handle Deezer preview playback
    const handlePlayPreview = async (pendingId: string) => {
        // If already playing this preview, stop it
        if (playingPreviewId === pendingId && previewAudioRef.current) {
            previewAudioRef.current.pause();
            setPlayingPreviewId(null);
            return;
        }

        // Stop any currently playing preview
        if (previewAudioRef.current) {
            previewAudioRef.current.pause();
        }

        // Show loading state
        setPlayingPreviewId(pendingId);

        try {
            // Always fetch a fresh preview URL since Deezer URLs expire quickly
            const result = await api.getFreshPreviewUrl(playlistId, pendingId);
            const previewUrl = result.previewUrl;

            // Create and play new audio
            const audio = new Audio(previewUrl);
            audio.volume = 0.5;
            audio.onended = () => setPlayingPreviewId(null);
            audio.onerror = (e) => {
                console.error("Deezer preview playback failed:", e);
                setPlayingPreviewId(null);
                toast.error("Preview playback failed");
            };
            previewAudioRef.current = audio;

            await audio.play();
        } catch (err) {
            console.error("Failed to play Deezer preview:", err);
            setPlayingPreviewId(null);
            toast.error("No preview available");
        }
    };

    // Handle retry download for pending track
    const handleRetryPendingTrack = async (pendingId: string) => {
        setRetryingTrackId(pendingId);
        try {
            const result = await api.retryPendingTrack(playlistId, pendingId);
            if (result.success) {
                // Use the activity sidebar (Active tab) instead of a toast/modal
                window.dispatchEvent(
                    new CustomEvent("set-activity-panel-tab", {
                        detail: { tab: "active" },
                    })
                );
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
                // If the backend emits a scan/download notification, refresh it
                window.dispatchEvent(new CustomEvent("notifications-changed"));
                // Refresh playlist data after a delay to allow download + scan to complete
                setTimeout(() => {
                    queryClient.invalidateQueries({
                        queryKey: ["playlist", playlistId],
                    });
                }, 10000); // 10 seconds for download + scan
            } else {
                toast.error(result.message || "Track not found on Soulseek");
            }
        } catch (error) {
            console.error("Failed to retry download:", error);
            toast.error("Failed to retry download");
        } finally {
            setRetryingTrackId(null);
        }
    };

    // Handle remove pending track
    const handleRemovePendingTrack = async (pendingId: string) => {
        setRemovingTrackId(pendingId);
        try {
            await api.removePendingTrack(playlistId, pendingId);
            // Refresh playlist data
            queryClient.invalidateQueries({
                queryKey: ["playlist", playlistId],
            });
        } catch (error) {
            console.error("Failed to remove pending track:", error);
        } finally {
            setRemovingTrackId(null);
        }
    };

    // Use React Query hook for playlist
    const { data: playlist, isLoading } = usePlaylistQuery(playlistId);

    // Check if this is a shared playlist
    const isShared = playlist?.isOwner === false;

    const handleToggleHide = async () => {
        if (!playlist) return;
        setIsHiding(true);
        try {
            if (playlist.isHidden) {
                await api.unhidePlaylist(playlistId);
            } else {
                await api.hidePlaylist(playlistId);
            }

            // Update local state immediately
            queryClient.setQueryData(["playlist", playlistId], (old: any) => ({
                ...old,
                isHidden: !playlist.isHidden,
            }));

            // Dispatch event to update sidebar and other components
            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } })
            );

            // Optionally navigate away if hiding
            if (!playlist.isHidden) {
                router.push("/playlists");
            }
        } catch (error) {
            console.error("Failed to toggle playlist visibility:", error);
        } finally {
            setIsHiding(false);
        }
    };

    // Calculate cover arts from playlist tracks for mosaic (memoized)
    const coverUrls = useMemo(() => {
        if (!playlist?.items || playlist.items.length === 0) return [];

        const tracksWithCovers = playlist.items.filter(
            (item: PlaylistItem) => item.track.album?.coverArt
        );
        if (tracksWithCovers.length === 0) return [];

        // Get unique cover arts (up to 4)
        const uniqueCovers = Array.from(
            new Set(tracksWithCovers.map((item) => item.track.album.coverArt))
        ).slice(0, 4);

        return uniqueCovers;
    }, [playlist]);

    const handleRemoveTrack = async (trackId: string) => {
        try {
            await api.removeTrackFromPlaylist(playlistId, trackId);
            // Track disappearing from list is feedback enough
        } catch (error) {
            console.error("Failed to remove track:", error);
        }
    };

    const handleDeletePlaylist = async () => {
        try {
            await api.deletePlaylist(playlistId);

            // Dispatch event to update sidebar
            window.dispatchEvent(
                new CustomEvent("playlist-deleted", { detail: { playlistId } })
            );

            router.push("/playlists");
        } catch (error) {
            console.error("Failed to delete playlist:", error);
        }
    };

    // Check if this playlist is currently playing
    const playlistTrackIds = useMemo(() => {
        return new Set(
            playlist?.items?.map((item: PlaylistItem) => item.track.id) || []
        );
    }, [playlist?.items]);

    const isThisPlaylistPlaying = useMemo(() => {
        if (!isPlaying || !currentTrack || !playlist?.items?.length)
            return false;
        // Check if current track is in this playlist
        return playlistTrackIds.has(currentTrack.id);
    }, [isPlaying, currentTrack, playlistTrackIds, playlist?.items?.length]);

    // Calculate total duration - MUST be before early returns
    const totalDuration = useMemo(() => {
        if (!playlist?.items) return 0;
        return playlist.items.reduce(
            (sum: number, item: PlaylistItem) =>
                sum + (item.track.duration || 0),
            0
        );
    }, [playlist?.items]);

    const formatTotalDuration = (seconds: number) => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `about ${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    const handlePlayPlaylist = () => {
        if (!playlist?.items || playlist.items.length === 0) return;

        // If this playlist is playing, toggle pause/resume
        if (isThisPlaylistPlaying) {
            if (isPlaying) {
                pause();
            } else {
                resume();
            }
            return;
        }

        const tracks = playlist.items.map((item: PlaylistItem) => ({
            id: item.track.id,
            title: item.track.title,
            artist: {
                name: item.track.album.artist.name,
                id: item.track.album.artist.id,
            },
            album: {
                title: item.track.album.title,
                coverArt: item.track.album.coverArt,
                id: item.track.album.id,
            },
            duration: item.track.duration,
        }));
        playTracks(tracks, 0);
    };

    const handlePlayTrack = (index: number) => {
        if (!playlist?.items || playlist.items.length === 0) return;

        const tracks = playlist.items.map((item: PlaylistItem) => ({
            id: item.track.id,
            title: item.track.title,
            artist: {
                name: item.track.album.artist.name,
                id: item.track.album.artist.id,
            },
            album: {
                title: item.track.album.title,
                coverArt: item.track.album.coverArt,
                id: item.track.album.id,
            },
            duration: item.track.duration,
        }));
        playTracks(tracks, index);
    };

    const handleAddToQueue = (track: Track) => {
        const formattedTrack = {
            id: track.id,
            title: track.title,
            artist: {
                name: track.album.artist.name,
                id: track.album.artist.id,
            },
            album: {
                title: track.album.title,
                coverArt: track.album.coverArt,
                id: track.album.id,
            },
            duration: track.duration,
        };
        addToQueue(formattedTrack);
    };

    const formatDuration = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!playlist) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <p className="text-gray-500">Playlist not found</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            {/* Compact Hero - Spotify Style */}
            <div className="relative bg-gradient-to-b from-[#3d2a1e] via-[#1a1a1a] to-transparent pt-16 pb-10 px-4 md:px-8">
                <div className="flex items-end gap-6">
                    {/* Cover Art */}
                    <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shadow-2xl shrink-0 overflow-hidden">
                        {coverUrls && coverUrls.length > 0 ? (
                            <div className="grid grid-cols-2 gap-0 w-full h-full">
                                {coverUrls
                                    .slice(0, 4)
                                    .map(
                                        (
                                            url: string | undefined,
                                            index: number
                                        ) => {
                                            if (!url) return null;
                                            const proxiedUrl =
                                                api.getCoverArtUrl(url, 200);
                                            return (
                                                <div
                                                    key={index}
                                                    className="relative bg-[#181818]"
                                                >
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
                                        }
                                    )}
                                {Array.from({
                                    length: Math.max(
                                        0,
                                        4 - (coverUrls?.length || 0)
                                    ),
                                }).map((_, index) => (
                                    <div
                                        key={`empty-${index}`}
                                        className="relative bg-[#282828]"
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className="w-full h-full bg-[#282828]" />
                        )}
                    </div>

                    {/* Playlist Info - Bottom Aligned */}
                    <div className="flex-1 min-w-0 pb-1">
                        <p className="text-xs font-medium text-white/90 mb-1">
                            {isShared ? "Public Playlist" : "Playlist"}
                        </p>
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                            {playlist.name}
                        </h1>
                        <div className="flex items-center gap-1 text-sm text-white/70">
                            {isShared && playlist.user?.username && (
                                <>
                                    <span className="font-medium text-white">
                                        {playlist.user.username}
                                    </span>
                                    <span className="mx-1">•</span>
                                </>
                            )}
                            <span>{playlist.items?.length || 0} songs</span>
                            {totalDuration > 0 && (
                                <>
                                    <span>
                                        , {formatTotalDuration(totalDuration)}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent px-4 md:px-8 py-4">
                <div className="flex items-center gap-4">
                    {/* Play Button */}
                    {playlist.items && playlist.items.length > 0 && (
                        <button
                            onClick={handlePlayPlaylist}
                            className="h-12 w-12 rounded-full bg-[#ecb200] hover:bg-[#d4a000] hover:scale-105 flex items-center justify-center shadow-lg transition-all"
                        >
                            {isThisPlaylistPlaying && isPlaying ? (
                                <Pause className="w-5 h-5 fill-current text-black" />
                            ) : (
                                <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                            )}
                        </button>
                    )}

                    {/* Shuffle Button */}
                    {playlist.items && playlist.items.length > 1 && (
                        <button
                            onClick={() => {
                                if (
                                    !playlist?.items ||
                                    playlist.items.length === 0
                                )
                                    return;
                                const tracks = playlist.items.map(
                                    (item: PlaylistItem) => ({
                                        id: item.track.id,
                                        title: item.track.title,
                                        artist: {
                                            name: item.track.album.artist.name,
                                            id: item.track.album.artist.id,
                                        },
                                        album: {
                                            title: item.track.album.title,
                                            coverArt: item.track.album.coverArt,
                                            id: item.track.album.id,
                                        },
                                        duration: item.track.duration,
                                    })
                                );
                                // Shuffle the tracks
                                const shuffled = [...tracks].sort(
                                    () => Math.random() - 0.5
                                );
                                playTracks(shuffled, 0);
                            }}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Shuffle play"
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>
                    )}

                    {/* Spacer */}
                    <div className="flex-1" />

                    {/* Hide Button */}
                    <button
                        onClick={handleToggleHide}
                        disabled={isHiding}
                        className={cn(
                            "h-8 w-8 rounded-full flex items-center justify-center transition-all",
                            playlist.isHidden
                                ? "text-[#ecb200] hover:text-[#d4a000]"
                                : "text-white/40 hover:text-white",
                            isHiding && "opacity-50 cursor-not-allowed"
                        )}
                        title={
                            playlist.isHidden
                                ? "Show playlist"
                                : "Hide playlist"
                        }
                    >
                        {playlist.isHidden ? (
                            <Eye className="w-5 h-5" />
                        ) : (
                            <EyeOff className="w-5 h-5" />
                        )}
                    </button>

                    {/* Delete Button */}
                    {playlist.isOwner && (
                        <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="h-8 w-8 rounded-full flex items-center justify-center text-white/40 hover:text-red-400 transition-all"
                            title="Delete Playlist"
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                    )}
                </div>
            </div>

            {/* Track Listing */}
            <div className="px-4 md:px-8 pb-32">
                {/* Show failed/pending count if any */}
                {playlist.pendingCount > 0 && (
                    <div className="mb-4 px-4 py-2 bg-red-900/20 border border-red-500/30 rounded-lg flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-red-400" />
                        <span className="text-sm text-red-200">
                            {playlist.pendingCount} track
                            {playlist.pendingCount !== 1 ? "s" : ""} failed to
                            download - will auto-import when available
                        </span>
                    </div>
                )}

                {playlist.items?.length > 0 ||
                playlist.pendingTracks?.length > 0 ? (
                    <div className="w-full">
                        {/* Table Header */}
                        <div className="hidden md:grid grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 text-xs text-gray-400 uppercase tracking-wider border-b border-white/10 mb-2">
                            <span className="text-center">#</span>
                            <span>Title</span>
                            <span>Album</span>
                            <span className="text-right">Duration</span>
                        </div>

                        {/* Track Rows - use mergedItems to show tracks and pending in correct order */}
                        <div>
                            {(playlist.mergedItems || playlist.items || []).map(
                                (
                                    item: PlaylistItem | PendingTrack,
                                    index: number
                                ) => {
                                    // Handle pending/failed tracks
                                    if (item.type === "pending") {
                                        const pending = (item as PendingTrack)
                                            .pending;
                                        const isPreviewPlaying =
                                            playingPreviewId === pending.id;
                                        const isRetrying =
                                            retryingTrackId === pending.id;
                                        const isRemoving =
                                            removingTrackId === pending.id;

                                        return (
                                            <div
                                                key={`pending-${pending.id}`}
                                                className="grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_120px] gap-4 px-4 py-2 rounded-md opacity-60 hover:opacity-80 group transition-opacity"
                                            >
                                                {/* Track Number - failed icon */}
                                                <div className="flex items-center justify-center">
                                                    <AlertCircle className="w-4 h-4 text-red-400" />
                                                </div>

                                                {/* Title + Artist */}
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className="w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden flex items-center justify-center">
                                                        <button
                                                            onClick={() =>
                                                                handlePlayPreview(
                                                                    pending.id
                                                                )
                                                            }
                                                            className="w-full h-full flex items-center justify-center hover:bg-white/10 transition-colors"
                                                            title="Play 30s Deezer preview"
                                                        >
                                                            {isPreviewPlaying ? (
                                                                <Volume2 className="w-5 h-5 text-[#ecb200] animate-pulse" />
                                                            ) : (
                                                                <Play className="w-5 h-5 text-gray-400 hover:text-white" />
                                                            )}
                                                        </button>
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-medium truncate text-gray-400">
                                                            {pending.title}
                                                        </p>
                                                        <p className="text-xs text-gray-500 truncate">
                                                            {pending.artist}
                                                        </p>
                                                    </div>
                                                </div>

                                                {/* Album (hidden on mobile) */}
                                                <p className="hidden md:flex items-center text-sm text-gray-500 truncate">
                                                    {pending.album}
                                                </p>

                                                {/* Actions: Retry + Remove */}
                                                <div className="flex items-center justify-end gap-1">
                                                    <span className="text-xs text-red-400 mr-2 hidden sm:inline">
                                                        Failed
                                                    </span>
                                                    {/* Retry button */}
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleRetryPendingTrack(
                                                                pending.id
                                                            );
                                                        }}
                                                        disabled={isRetrying}
                                                        className={cn(
                                                            "p-1.5 rounded-full hover:bg-white/10 transition-all",
                                                            isRetrying
                                                                ? "text-[#ecb200]"
                                                                : "text-gray-400 hover:text-white"
                                                        )}
                                                        title="Retry download"
                                                    >
                                                        {isRetrying ? (
                                                            <Loader2 className="w-4 h-4 animate-spin" />
                                                        ) : (
                                                            <RefreshCw className="w-4 h-4" />
                                                        )}
                                                    </button>
                                                    {/* Remove button */}
                                                    {playlist.isOwner && (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleRemovePendingTrack(
                                                                    pending.id
                                                                );
                                                            }}
                                                            disabled={
                                                                isRemoving
                                                            }
                                                            className="p-1.5 rounded-full hover:bg-white/10 text-gray-400 hover:text-red-400 transition-all"
                                                            title="Remove from playlist"
                                                        >
                                                            {isRemoving ? (
                                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                            ) : (
                                                                <X className="w-4 h-4" />
                                                            )}
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    }

                                    // Handle regular tracks
                                    const playlistItem = item as PlaylistItem;
                                    const isCurrentlyPlaying =
                                        currentTrack?.id ===
                                        playlistItem.track.id;
                                    // Calculate the index for playback (only count actual tracks)
                                    const trackIndex =
                                        playlist.items?.findIndex(
                                            (i: PlaylistItem) =>
                                                i.id === playlistItem.id
                                        ) ?? index;

                                    return (
                                        <div
                                            key={playlistItem.id}
                                            onClick={() =>
                                                handlePlayTrack(trackIndex)
                                            }
                                            className={cn(
                                                "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer",
                                                isCurrentlyPlaying &&
                                                    "bg-white/10"
                                            )}
                                        >
                                            {/* Track Number / Play Icon */}
                                            <div className="flex items-center justify-center">
                                                <span
                                                    className={cn(
                                                        "text-sm group-hover:hidden",
                                                        isCurrentlyPlaying
                                                            ? "text-[#ecb200]"
                                                            : "text-gray-400"
                                                    )}
                                                >
                                                    {isCurrentlyPlaying &&
                                                    isPlaying ? (
                                                        <Music className="w-4 h-4 text-[#ecb200] animate-pulse" />
                                                    ) : (
                                                        trackIndex + 1
                                                    )}
                                                </span>
                                                <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                            </div>

                                            {/* Title + Artist */}
                                            <div className="flex items-center gap-3 min-w-0">
                                                <div className="w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                                                    {playlistItem.track.album
                                                        ?.coverArt ? (
                                                        <img
                                                            src={api.getCoverArtUrl(
                                                                playlistItem
                                                                    .track.album
                                                                    .coverArt,
                                                                100
                                                            )}
                                                            alt={
                                                                playlistItem
                                                                    .track.title
                                                            }
                                                            className="w-full h-full object-cover"
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
                                                            isCurrentlyPlaying
                                                                ? "text-[#ecb200]"
                                                                : "text-white"
                                                        )}
                                                    >
                                                        {
                                                            playlistItem.track
                                                                .title
                                                        }
                                                    </p>
                                                    <p className="text-xs text-gray-400 truncate">
                                                        {
                                                            playlistItem.track
                                                                .album.artist
                                                                .name
                                                        }
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Album (hidden on mobile) */}
                                            <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                                                {playlistItem.track.album.title}
                                            </p>

                                            {/* Duration + Actions */}
                                            <div className="flex items-center justify-end gap-2">
                                                <button
                                                    className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-400 hover:text-white transition-all"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleAddToQueue(
                                                            playlistItem.track
                                                        );
                                                    }}
                                                    title="Add to Queue"
                                                >
                                                    <ListPlus className="w-4 h-4" />
                                                </button>
                                                <span className="text-sm text-gray-400 w-12 text-right">
                                                    {formatDuration(
                                                        playlistItem.track
                                                            .duration
                                                    )}
                                                </span>
                                                {playlist.isOwner && (
                                                    <button
                                                        className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-400 hover:text-red-400 transition-all"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleRemoveTrack(
                                                                playlistItem
                                                                    .track.id
                                                            );
                                                        }}
                                                        title="Remove from Playlist"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                }
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-20 h-20 bg-[#282828] rounded-full flex items-center justify-center mb-4">
                            <ListMusic className="w-10 h-10 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-1">
                            No tracks yet
                        </h3>
                        <p className="text-sm text-gray-500">
                            Add some tracks to get started
                        </p>
                    </div>
                )}
            </div>

            {/* Confirm Dialog */}
            <ConfirmDialog
                isOpen={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                onConfirm={handleDeletePlaylist}
                title="Delete Playlist?"
                message={`Are you sure you want to delete "${playlist.name}"? This action cannot be undone.`}
                confirmText="Delete"
                cancelText="Cancel"
                variant="danger"
            />
        </div>
    );
}
