"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/api";
import { useAudioState, useAudioPlayback, useAudioControls, Track as AudioTrack } from "@/lib/audio-context";
import { audioEngine } from "@/lib/audio-engine";
import { cn } from "@/utils/cn";
import { shuffleArray } from "@/utils/shuffle";
import { formatTime } from "@/utils/formatTime";
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
    Volume2,
    RefreshCw,
    AlertCircle,
    X,
    Check,
    Pencil,
    Loader2,
    ArrowLeft,
} from "lucide-react";
import { useTrackFormat } from "@/hooks/useTrackFormat";
import { formatTrackDisplay } from "@/lib/track-format";

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
    const { currentTrack } = useAudioState();
    const { format: trackFormat } = useTrackFormat();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, addToQueue, pause, resumeWithGesture } = useAudioControls();
    const playlistId = params.id as string;

    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isHiding, setIsHiding] = useState(false);
    const [playingPreviewId, setPlayingPreviewId] = useState<string | null>(null);
    const [retryingTrackId, setRetryingTrackId] = useState<string | null>(null);
    const [removingTrackId, setRemovingTrackId] = useState<string | null>(null);
    const [retryingAll, setRetryingAll] = useState(false);
    const [isEditingName, setIsEditingName] = useState(false);
    const [editedName, setEditedName] = useState("");
    const [isSavingName, setIsSavingName] = useState(false);
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);

    useEffect(() => {
        return () => {
            if (previewAudioRef.current) {
                previewAudioRef.current.pause();
                previewAudioRef.current = null;
            }
        };
    }, []);

    const handlePlayPreview = async (pendingId: string) => {
        if (playingPreviewId === pendingId && previewAudioRef.current) {
            previewAudioRef.current.pause();
            setPlayingPreviewId(null);
            return;
        }

        if (previewAudioRef.current) {
            previewAudioRef.current.pause();
        }

        setPlayingPreviewId(pendingId);

        try {
            const result = await api.getFreshPreviewUrl(playlistId, pendingId);
            const previewUrl = result.previewUrl;

            const audio = new Audio(previewUrl);
            const { volume, isMuted } = audioEngine.getState();
            audio.volume = isMuted ? 0 : volume;
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

    const handleRetryPendingTrack = async (pendingId: string) => {
        setRetryingTrackId(pendingId);
        try {
            const result = await api.retryPendingTrack(playlistId, pendingId);
            if (result.success) {
                window.dispatchEvent(
                    new CustomEvent("set-activity-panel-tab", {
                        detail: { tab: "active" },
                    })
                );
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
                queryClient.invalidateQueries({ queryKey: ["notifications"] });
                setTimeout(() => {
                    queryClient.invalidateQueries({
                        queryKey: ["playlist", playlistId],
                    });
                }, 10000);
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

    const handleRetryAllPending = async () => {
        setRetryingAll(true);
        try {
            const result = await api.retryAllPendingTracks(playlistId);
            if (result.success && result.queued > 0) {
                window.dispatchEvent(
                    new CustomEvent("set-activity-panel-tab", {
                        detail: { tab: "active" },
                    })
                );
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
                queryClient.invalidateQueries({ queryKey: ["notifications"] });
                toast.success(`Retrying ${result.queued} tracks`);
                setTimeout(() => {
                    queryClient.invalidateQueries({
                        queryKey: ["playlist", playlistId],
                    });
                }, 15000);
            } else {
                toast.info(result.message || "No tracks to retry");
            }
        } catch (error) {
            console.error("Failed to retry all downloads:", error);
            toast.error("Failed to retry downloads");
        } finally {
            setRetryingAll(false);
        }
    };

    const handleRemovePendingTrack = async (pendingId: string) => {
        setRemovingTrackId(pendingId);
        try {
            await api.removePendingTrack(playlistId, pendingId);
            queryClient.invalidateQueries({
                queryKey: ["playlist", playlistId],
            });
        } catch (error) {
            console.error("Failed to remove pending track:", error);
        } finally {
            setRemovingTrackId(null);
        }
    };

    const { data: playlist, isLoading } = usePlaylistQuery(playlistId);

    useEffect(() => {
        if (playlist?.name) {
            setEditedName(playlist.name);
        }
    }, [playlist?.name]);

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

            queryClient.setQueryData(["playlist", playlistId], (old: Record<string, unknown>) => ({
                ...old,
                isHidden: !playlist.isHidden,
            }));

            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } })
            );

            if (!playlist.isHidden) {
                router.push("/playlists");
            }
        } catch (error) {
            console.error("Failed to toggle playlist visibility:", error);
        } finally {
            setIsHiding(false);
        }
    };

    const coverUrls = useMemo(() => {
        if (!playlist?.items || playlist.items.length === 0) return [];

        const tracksWithCovers = playlist.items.filter(
            (item: PlaylistItem) => item.track.album?.coverArt
        );
        if (tracksWithCovers.length === 0) return [];

        // Count tracks per cover art, sort by frequency (most tracks first)
        const coverCounts = new Map<string, number>();
        for (const item of tracksWithCovers) {
            const cover = item.track.album.coverArt!;
            coverCounts.set(cover, (coverCounts.get(cover) || 0) + 1);
        }
        const uniqueCovers = Array.from(coverCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([cover]) => cover);

        if (uniqueCovers.length >= 4) return uniqueCovers.slice(0, 4);
        if (uniqueCovers.length <= 1) return uniqueCovers;

        // Fill all 4 slots, duplicate the most-represented album at its diagonal
        if (uniqueCovers.length === 2)
            return [uniqueCovers[0], uniqueCovers[1], uniqueCovers[1], uniqueCovers[0]];
        return [uniqueCovers[0], uniqueCovers[1], uniqueCovers[2], uniqueCovers[0]];
    }, [playlist]);

    const handleRemoveTrack = async (trackId: string) => {
        try {
            await api.removeTrackFromPlaylist(playlistId, trackId);
        } catch (error) {
            console.error("Failed to remove track:", error);
        }
    };

    const handleDeletePlaylist = async () => {
        try {
            await api.deletePlaylist(playlistId);

            window.dispatchEvent(
                new CustomEvent("playlist-deleted", { detail: { playlistId } })
            );

            router.push("/playlists");
        } catch (error) {
            console.error("Failed to delete playlist:", error);
        }
    };

    const handleSavePlaylistName = async () => {
        if (!playlist) return;
        const trimmedName = editedName.trim();

        if (!trimmedName || trimmedName === playlist.name) {
            setIsEditingName(false);
            setEditedName(playlist.name);
            return;
        }

        setIsSavingName(true);
        try {
            await api.updatePlaylist(
                playlistId,
                trimmedName,
                !!playlist.isPublic
            );

            queryClient.invalidateQueries({ queryKey: ["playlist", playlistId] });
            queryClient.invalidateQueries({ queryKey: ["playlists"] });

            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } })
            );

            toast.success("Playlist renamed");
            setIsEditingName(false);
        } catch (error) {
            console.error("Failed to rename playlist:", error);
            toast.error("Failed to rename playlist");
        } finally {
            setIsSavingName(false);
        }
    };

    const playlistTrackIds = useMemo(() => {
        return new Set(
            playlist?.items?.map((item: PlaylistItem) => item.track.id) || []
        );
    }, [playlist?.items]);

    const isThisPlaylistPlaying = useMemo(() => {
        if (!isPlaying || !currentTrack || !playlist?.items?.length)
            return false;
        return playlistTrackIds.has(currentTrack.id);
    }, [isPlaying, currentTrack, playlistTrackIds, playlist?.items?.length]);

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
            return `${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    const handlePlayPlaylist = () => {
        if (!playlist?.items || playlist.items.length === 0) return;

        if (isThisPlaylistPlaying) {
            if (isPlaying) {
                pause();
            } else {
                resumeWithGesture();
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

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!playlist) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <p className="text-xs font-mono text-white/30 uppercase tracking-wider">Playlist not found</p>
            </div>
        );
    }

    // Get hero image from first cover
    const heroImage = coverUrls.length > 0 ? api.getCoverArtUrl(coverUrls[0] as string, 500) : null;

    return (
        <div className="min-h-screen bg-gradient-to-b from-[#0a0a0a] to-black">
            {/* Hero Section */}
            <div className="relative">
                {/* Blurred background */}
                {heroImage && (
                    <div className="absolute inset-0 overflow-hidden">
                        <div className="absolute inset-0 scale-110 blur-md opacity-20">
                            <Image
                                src={heroImage}
                                alt=""
                                fill
                                sizes="100vw"
                                className="object-cover"
                                priority
                                unoptimized
                            />
                        </div>
                        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#0a0a0a]/80 to-[#0a0a0a]" />
                    </div>
                )}

                <div className="relative px-4 md:px-8 pt-8 pb-6">
                    <div className="max-w-[1800px] mx-auto">
                        {/* Back navigation */}
                        <button
                            onClick={() => router.push("/playlists")}
                            className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white transition-colors mb-6 uppercase tracking-wider"
                        >
                            <ArrowLeft className="w-3.5 h-3.5" />
                            Playlists
                        </button>

                        {/* System status */}
                        <div className="flex items-center gap-2 mb-4">
                            <div className="w-1.5 h-1.5 bg-[#fca208] rounded-full" />
                            <span className="text-xs font-mono text-white/50 uppercase tracking-wider">
                                {isShared ? "Public Playlist" : "Playlist"}
                            </span>
                        </div>

                        <div className="flex items-end gap-6">
                            {/* Cover Art Mosaic */}
                            <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#0a0a0a] rounded-lg shadow-2xl shrink-0 overflow-hidden relative border-2 border-white/10">
                                {coverUrls && coverUrls.length > 0 ? (
                                    <div className="grid grid-cols-2 gap-0 w-full h-full">
                                        {coverUrls.slice(0, 4).map((url: string | undefined, index: number) => {
                                            if (!url) return null;
                                            const proxiedUrl = api.getCoverArtUrl(url, 200);
                                            return (
                                                <div key={index} className="relative bg-[#0a0a0a]">
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
                                    </div>
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <ListMusic className="w-16 h-16 text-white/10" />
                                    </div>
                                )}
                            </div>

                            {/* Playlist Info */}
                            <div className="flex-1 min-w-0 pb-1">
                                {playlist.isOwner && isEditingName ? (
                                    <div className="flex items-center gap-2 mb-2">
                                        <input
                                            autoFocus
                                            value={editedName}
                                            onChange={(e) => setEditedName(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") {
                                                    void handleSavePlaylistName();
                                                }
                                                if (e.key === "Escape") {
                                                    setEditedName(playlist.name);
                                                    setIsEditingName(false);
                                                }
                                            }}
                                            className="w-full max-w-2xl bg-black/40 border border-white/20 rounded px-3 py-2 text-2xl md:text-4xl font-black text-white tracking-tighter leading-tight focus:outline-none focus:border-[#fca208]"
                                            maxLength={200}
                                        />
                                        <button
                                            onClick={() => void handleSavePlaylistName()}
                                            disabled={isSavingName || !editedName.trim()}
                                            className="p-2 rounded-lg hover:bg-white/10 text-green-400 disabled:opacity-40"
                                            title="Save"
                                        >
                                            <Check className="w-5 h-5" />
                                        </button>
                                        <button
                                            onClick={() => {
                                                setEditedName(playlist.name);
                                                setIsEditingName(false);
                                            }}
                                            disabled={isSavingName}
                                            className="p-2 rounded-lg hover:bg-white/10 text-white/50"
                                            title="Cancel"
                                        >
                                            <X className="w-5 h-5" />
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 mb-2">
                                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-black text-white leading-tight line-clamp-2 tracking-tighter flex-1 min-w-0">
                                            {playlist.name}
                                        </h1>
                                        {playlist.isOwner && (
                                            <button
                                                onClick={() => {
                                                    setEditedName(playlist.name);
                                                    setIsEditingName(true);
                                                }}
                                                className="p-2 rounded-lg hover:bg-white/10 text-white/40 hover:text-white transition-colors"
                                                title="Rename playlist"
                                            >
                                                <Pencil className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                )}

                                <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-white/50 uppercase tracking-wider">
                                    {isShared && playlist.user?.username && (
                                        <>
                                            <span className="font-black text-white normal-case tracking-tight text-sm">
                                                {playlist.user.username}
                                            </span>
                                            <span className="text-white/20">|</span>
                                        </>
                                    )}
                                    <span>{playlist.items?.length || 0} songs</span>
                                    {totalDuration > 0 && (
                                        <>
                                            <span className="text-white/20">|</span>
                                            <span>{formatTotalDuration(totalDuration)}</span>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            <div className="px-4 md:px-8 py-4">
                <div className="max-w-[1800px] mx-auto flex items-center gap-4">
                    {/* Play Button */}
                    {playlist.items && playlist.items.length > 0 && (
                        <button
                            onClick={handlePlayPlaylist}
                            className="h-12 w-12 rounded-lg bg-[#fca208] hover:bg-[#f97316] hover:scale-105 flex items-center justify-center shadow-lg shadow-[#fca208]/20 transition-all"
                        >
                            {isThisPlaylistPlaying && isPlaying ? (
                                <Pause className="w-5 h-5 fill-current text-black" />
                            ) : (
                                <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                            )}
                        </button>
                    )}

                    {/* Shuffle */}
                    {playlist.items && playlist.items.length > 1 && (
                        <button
                            onClick={() => {
                                if (!playlist?.items || playlist.items.length === 0) return;
                                const tracks: AudioTrack[] = playlist.items.map(
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
                                const shuffled = shuffleArray(tracks);
                                playTracks(shuffled, 0);
                            }}
                            className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-white/40 hover:text-white transition-all"
                            title="Shuffle play"
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>
                    )}

                    <div className="flex-1" />

                    {/* Hide Button */}
                    <button
                        onClick={handleToggleHide}
                        disabled={isHiding}
                        className={cn(
                            "h-8 w-8 rounded-lg flex items-center justify-center transition-all",
                            playlist.isHidden
                                ? "text-[#fca208] hover:text-[#f97316]"
                                : "text-white/30 hover:text-white/60",
                            isHiding && "opacity-50 cursor-not-allowed"
                        )}
                        title={playlist.isHidden ? "Show playlist" : "Hide playlist"}
                    >
                        {playlist.isHidden ? (
                            <Eye className="w-5 h-5" />
                        ) : (
                            <EyeOff className="w-5 h-5" />
                        )}
                    </button>

                    {/* Delete */}
                    {playlist.isOwner && (
                        <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="h-8 w-8 rounded-lg flex items-center justify-center text-white/30 hover:text-red-400 transition-all"
                            title="Delete Playlist"
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                    )}
                </div>
            </div>

            {/* Track Listing */}
            <div className="px-4 md:px-8 pb-32">
                <div className="max-w-[1800px] mx-auto">
                    {/* Pending tracks notice */}
                    {playlist.pendingCount > 0 && (
                        <div className="mb-4 px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <AlertCircle className="w-4 h-4 text-red-400" />
                                <span className="text-xs font-mono text-red-300 uppercase tracking-wider">
                                    {playlist.pendingCount} track
                                    {playlist.pendingCount !== 1 ? "s" : ""} failed to
                                    download
                                </span>
                            </div>
                            <button
                                onClick={handleRetryAllPending}
                                disabled={retryingAll}
                                className="flex items-center gap-1.5 px-3 py-1 text-xs font-mono uppercase tracking-wider text-red-300 hover:text-red-200 hover:bg-red-500/20 rounded transition-colors disabled:opacity-50"
                            >
                                <RefreshCw className={cn("w-3 h-3", retryingAll && "animate-spin")} />
                                Retry All
                            </button>
                        </div>
                    )}

                    {playlist.items?.length > 0 || playlist.pendingTracks?.length > 0 ? (
                        <div className="w-full">
                            {/* Section header */}
                            <div className="flex items-center gap-3 mb-6">
                                <span className="w-1 h-8 bg-gradient-to-b from-[#fca208] to-[#f97316] rounded-full shrink-0" />
                                <h2 className="text-2xl font-black tracking-tighter uppercase">Tracks</h2>
                                <span className="text-xs font-mono text-[#fca208]">
                                    {playlist.items?.length || 0}
                                </span>
                                <span className="flex-1 border-t border-white/10" />
                            </div>

                            {/* Table Header */}
                            <div className="hidden md:grid grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 text-[10px] font-mono text-white/30 uppercase tracking-wider border-b border-white/10 mb-2">
                                <span className="text-center">#</span>
                                <span>Title</span>
                                <span>Album</span>
                                <span className="text-right">Duration</span>
                            </div>

                            {/* Track Rows */}
                            <div>
                                {(playlist.mergedItems || playlist.items || []).map(
                                    (item: PlaylistItem | PendingTrack, index: number) => {
                                        if (item.type === "pending") {
                                            const pending = (item as PendingTrack).pending;
                                            const isPreviewPlaying = playingPreviewId === pending.id;
                                            const isRetrying = retryingTrackId === pending.id;
                                            const isRemoving = removingTrackId === pending.id;

                                            return (
                                                <div
                                                    key={`pending-${pending.id}`}
                                                    className="grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_120px] gap-4 px-4 py-2 rounded-lg opacity-60 hover:opacity-80 group transition-opacity"
                                                >
                                                    <div className="flex items-center justify-center">
                                                        <AlertCircle className="w-4 h-4 text-red-400" />
                                                    </div>

                                                    <div className="flex items-center gap-3 min-w-0">
                                                        <div className="w-10 h-10 bg-[#0a0a0a] border border-white/10 rounded-lg shrink-0 overflow-hidden flex items-center justify-center">
                                                            <button
                                                                onClick={() => handlePlayPreview(pending.id)}
                                                                className="w-full h-full flex items-center justify-center hover:bg-white/5 transition-colors"
                                                                title="Play 30s Deezer preview"
                                                            >
                                                                {isPreviewPlaying ? (
                                                                    <Volume2 className="w-5 h-5 text-[#fca208] animate-pulse" />
                                                                ) : (
                                                                    <Play className="w-5 h-5 text-white/30 hover:text-white/60" />
                                                                )}
                                                            </button>
                                                        </div>
                                                        <div className="min-w-0">
                                                            <p className="text-sm font-medium truncate text-white/40">
                                                                {pending.title}
                                                            </p>
                                                            <p className="text-[10px] font-mono text-white/20 truncate uppercase tracking-wider">
                                                                {pending.artist}
                                                            </p>
                                                        </div>
                                                    </div>

                                                    <p className="hidden md:flex items-center text-xs font-mono text-white/20 truncate uppercase tracking-wider">
                                                        {pending.album}
                                                    </p>

                                                    <div className="flex items-center justify-end gap-1">
                                                        <span className="text-[10px] font-mono text-red-400 mr-2 hidden sm:inline uppercase tracking-wider">
                                                            Failed
                                                        </span>
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleRetryPendingTrack(pending.id);
                                                            }}
                                                            disabled={isRetrying}
                                                            className={cn(
                                                                "p-1.5 rounded-lg hover:bg-white/10 transition-all",
                                                                isRetrying
                                                                    ? "text-[#fca208]"
                                                                    : "text-white/30 hover:text-white/60"
                                                            )}
                                                            title="Retry download"
                                                        >
                                                            {isRetrying ? (
                                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                            ) : (
                                                                <RefreshCw className="w-4 h-4" />
                                                            )}
                                                        </button>
                                                        {playlist.isOwner && (
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleRemovePendingTrack(pending.id);
                                                                }}
                                                                disabled={isRemoving}
                                                                className="p-1.5 rounded-lg hover:bg-white/10 text-white/30 hover:text-red-400 transition-all"
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

                                        const playlistItem = item as PlaylistItem;
                                        const isCurrentlyPlaying = currentTrack?.id === playlistItem.track.id;
                                        const trackIndex = playlist.items?.findIndex(
                                            (i: PlaylistItem) => i.id === playlistItem.id
                                        ) ?? index;

                                        return (
                                            <div
                                                key={playlistItem.id}
                                                onDoubleClick={() => handlePlayTrack(trackIndex)}
                                                className={cn(
                                                    "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 rounded-lg hover:bg-white/[0.03] transition-all group cursor-pointer border border-transparent hover:border-white/5",
                                                    isCurrentlyPlaying && "bg-white/5 border-[#fca208]/30"
                                                )}
                                            >
                                                {/* Track Number / Play Button */}
                                                <div className="flex items-center justify-center">
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handlePlayTrack(trackIndex);
                                                        }}
                                                        className="w-8 h-8 flex items-center justify-center"
                                                        aria-label={isCurrentlyPlaying && isPlaying ? "Pause" : "Play"}
                                                    >
                                                        <span
                                                            className={cn(
                                                                "text-xs font-mono group-hover:hidden",
                                                                isCurrentlyPlaying
                                                                    ? "text-[#fca208] font-black"
                                                                    : "text-white/30"
                                                            )}
                                                        >
                                                            {isCurrentlyPlaying && isPlaying ? (
                                                                <Music className="w-4 h-4 text-[#fca208] animate-pulse" />
                                                            ) : (
                                                                trackIndex + 1
                                                            )}
                                                        </span>
                                                        <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                                    </button>
                                                </div>

                                                {/* Title + Artist */}
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className="relative w-10 h-10 bg-[#0a0a0a] rounded-lg shrink-0 overflow-hidden border border-white/10">
                                                        {playlistItem.track.album?.coverArt ? (
                                                            <Image
                                                                src={api.getCoverArtUrl(
                                                                    playlistItem.track.album.coverArt,
                                                                    100
                                                                )}
                                                                alt={playlistItem.track.title}
                                                                fill
                                                                sizes="40px"
                                                                className="object-cover"
                                                                unoptimized
                                                            />
                                                        ) : (
                                                            <div className="w-full h-full flex items-center justify-center">
                                                                <Music className="w-5 h-5 text-white/10" />
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p
                                                            className={cn(
                                                                "text-sm font-black truncate tracking-tight",
                                                                isCurrentlyPlaying
                                                                    ? "text-[#fca208]"
                                                                    : "text-white"
                                                            )}
                                                        >
                                                            {formatTrackDisplay(
                                                                {
                                                                    title: playlistItem.track.title,
                                                                    artist: playlistItem.track.album.artist.name,
                                                                    album: playlistItem.track.album.title,
                                                                },
                                                                trackFormat,
                                                            )}
                                                        </p>
                                                        <p className="text-[10px] font-mono text-white/40 truncate uppercase tracking-wider">
                                                            {playlistItem.track.album.artist.name}
                                                        </p>
                                                    </div>
                                                </div>

                                                {/* Album */}
                                                <p className="hidden md:flex items-center text-xs font-mono text-white/30 truncate">
                                                    {playlistItem.track.album.title}
                                                </p>

                                                {/* Duration + Actions */}
                                                <div className="flex items-center justify-end gap-2">
                                                    <button
                                                        className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-white/10 text-white/30 hover:text-white transition-all"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleAddToQueue(playlistItem.track);
                                                        }}
                                                        title="Add to Queue"
                                                    >
                                                        <ListPlus className="w-4 h-4" />
                                                    </button>
                                                    <span className="text-[10px] font-mono text-white/30 w-12 text-right uppercase tracking-wider">
                                                        {formatTime(playlistItem.track.duration)}
                                                    </span>
                                                    {playlist.isOwner && (
                                                        <button
                                                            className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-white/10 text-white/30 hover:text-red-400 transition-all"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleRemoveTrack(playlistItem.track.id);
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
                        <div>
                            <div className="relative overflow-hidden rounded-lg border-2 border-white/10 bg-gradient-to-br from-[#0f0f0f] to-[#0a0a0a] p-12 shadow-2xl shadow-black/40">
                                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-[#fca208] to-[#f97316]" />

                                <div className="flex items-center gap-3 mb-8 pb-4 border-b border-white/10">
                                    <div className="w-2 h-2 bg-[#fca208]" />
                                    <span className="text-xs font-mono text-white/60 uppercase tracking-wider">
                                        Empty Playlist
                                    </span>
                                </div>

                                <div className="flex flex-col items-center text-center">
                                    <div className="w-16 h-16 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center mb-6">
                                        <ListMusic className="w-8 h-8 text-white/10" />
                                    </div>
                                    <h3 className="text-2xl font-black tracking-tighter text-white mb-2 uppercase">
                                        No tracks yet
                                    </h3>
                                    <p className="text-xs font-mono text-white/30 uppercase tracking-wider">
                                        Add some tracks to get started
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
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
