"use client";

import { useState, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/api";
import { useAudioState, useAudioPlayback, useAudioControls, Track as AudioTrack } from "@/lib/audio-context";
import { useAudioController } from "@/lib/audio-controller-context";
import { cn } from "@/utils/cn";
import { shuffleArray } from "@/utils/shuffle";
import { formatTime } from "@/utils/formatTime";
import { queryKeys, usePlaylistQuery, useRemoveFromPlaylistMutation, useDeletePlaylistMutation, useUpdatePlaylistMutation, useMoveTrackInPlaylistMutation } from "@/hooks/useQueries";
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
    Loader2,
    ArrowLeft,
    Share2,
    Copy,
    Check,
    Link as LinkIcon,
    Globe,
    Lock,
    FileX,
    GripVertical,
    ChevronUp,
    ChevronDown,
} from "lucide-react";
import { useTrackFormat } from "@/hooks/useTrackFormat";
import { formatTrackDisplay } from "@/lib/track-format";
import { useDoubleTapList } from "@/hooks/useDoubleTap";

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
        missingFromDisk?: boolean;
    };
}

/**
 * The track table's column track, shared by the header and every row so the two
 * cannot drift apart.
 *
 * Four columns, and each row must render exactly four grid children:
 *
 *   1. the track number / play button, with the drag handle beside it
 *   2. cover art + title + artist
 *   3. album (hidden below `md`, where the mobile three-column track applies)
 *   4. the row actions and duration
 *
 * The play button and the drag handle share one cell deliberately. The handle
 * renders only for the playlist's owner, so giving it a column of its own would
 * leave every other viewer one child short of the track and shift the entire row
 * left — which is exactly what happened when drag-to-reorder first landed: the
 * title block was squeezed into a 24px column and disappeared, and the album
 * moved under the "Title" heading.
 */
/*
 * Both spellings are written out in full on purpose. Tailwind generates only the
 * classes it can find as literal strings in the source, so building the variant
 * at runtime (`md:${TRACK_GRID}`) produces a class that is never compiled and a
 * grid that silently never applies. Keep them adjacent so drift is visible.
 */
const TRACK_GRID = "grid-cols-[64px_minmax(200px,4fr)_minmax(100px,1fr)_80px]";
const TRACK_GRID_MD = "md:grid-cols-[64px_minmax(200px,4fr)_minmax(100px,1fr)_80px]";

export default function PlaylistDetailPage() {
    const controller = useAudioController();
    const params = useParams();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { currentTrack } = useAudioState();
    const { format: trackFormat } = useTrackFormat();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, addToQueue, pause, resumeWithGesture } = useAudioControls();
    const playlistId = params.id as string;

    const { mutateAsync: removeTrack } = useRemoveFromPlaylistMutation();
    const { mutateAsync: deletePlaylistMut } = useDeletePlaylistMutation();
    const { mutateAsync: updatePlaylist, isPending: isUpdatingPlaylist } = useUpdatePlaylistMutation();
    const { mutateAsync: moveTrack } = useMoveTrackInPlaylistMutation();
    const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
    const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);
    const [isEditingName, setIsEditingName] = useState(false);
    const [editName, setEditName] = useState("");
    const editSaveRef = useRef(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isHiding, setIsHiding] = useState(false);
    const [playingPreviewId, setPlayingPreviewId] = useState<string | null>(null);
    const [retryingTrackId, setRetryingTrackId] = useState<string | null>(null);
    const [removingTrackId, setRemovingTrackId] = useState<string | null>(null);
    const [retryingAll, setRetryingAll] = useState(false);
    const [shareUrl, setShareUrl] = useState<string | null>(null);
    const [shareToken, setShareToken] = useState<string | null>(null);
    const [shareLoading, setShareLoading] = useState(false);
    const [shareCopied, setShareCopied] = useState(false);
    const [showSharePopover, setShowSharePopover] = useState(false);
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);

    useEffect(() => {
        return () => {
            if (previewAudioRef.current) {
                previewAudioRef.current.pause();
                previewAudioRef.current = null;
            }
        };
    }, []);

    // Capture the actual scroll container (#main-content) and measure the
    // list's offset within it so the element virtualizer positions rows correctly.
    useLayoutEffect(() => {
        const el = document.getElementById("main-content") as HTMLElement | null;
        scrollContainerRef.current = el;
    }, []);

    useEffect(() => {
        if (!showSharePopover) return;
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target.closest("[data-share-popover]")) {
                setShowSharePopover(false);
            }
        };
        const timer = setTimeout(() => {
            document.addEventListener("click", handleClickOutside);
        }, 0);
        return () => {
            clearTimeout(timer);
            document.removeEventListener("click", handleClickOutside);
        };
    }, [showSharePopover]);

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
            const audio = new Audio(
                api.getPendingTrackPreviewStreamUrl(playlistId, pendingId)
            );
            const { volume, isMuted } = controller?.getState() ?? { volume: 1, isMuted: false };
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
                        queryKey: queryKeys.playlist(playlistId),
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
                        queryKey: queryKeys.playlist(playlistId),
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
                queryKey: queryKeys.playlist(playlistId),
            });
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
        } catch (error) {
            console.error("Failed to remove pending track:", error);
            toast.error("Failed to remove pending track");
        } finally {
            setRemovingTrackId(null);
        }
    };

    const { data: playlist, isLoading } = usePlaylistQuery(playlistId);

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

            queryClient.setQueryData(queryKeys.playlist(playlistId), (old: Record<string, unknown>) => ({
                ...old,
                isHidden: !playlist.isHidden,
            }));
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });

            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } })
            );

            if (!playlist.isHidden) {
                router.push("/playlists");
            }
        } catch (error) {
            console.error("Failed to toggle playlist visibility:", error);
            toast.error("Failed to update playlist visibility");
        } finally {
            setIsHiding(false);
        }
    };

    const handleTogglePublic = async () => {
        if (!playlist?.isOwner) return;
        try {
            await updatePlaylist({
                playlistId,
                data: { isPublic: !playlist.isPublic },
            });
            toast.success(playlist.isPublic ? "Playlist set to private" : "Playlist set to public");
        } catch {
            toast.error("Failed to update playlist visibility");
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
            await removeTrack({ playlistId, trackId });
        } catch (error) {
            console.error("Failed to remove track:", error);
            toast.error("Failed to remove track");
        }
    };

    const handleDeletePlaylist = async () => {
        try {
            await deletePlaylistMut(playlistId);

            window.dispatchEvent(
                new CustomEvent("playlist-deleted", { detail: { playlistId } })
            );

            router.push("/playlists");
        } catch (error) {
            console.error("Failed to delete playlist:", error);
            toast.error("Failed to delete playlist");
        }
    };

    const handleShare = async () => {
        if (shareUrl) {
            setShowSharePopover(true);
            return;
        }
        setShareLoading(true);
        try {
            const result = await api.createShareLink("playlist", playlistId);
            const fullUrl = `${window.location.origin}/share/${result.token}`;
            setShareToken(result.token);
            setShareUrl(fullUrl);
            setShowSharePopover(true);
        } catch (err) {
            console.error("Failed to create share link:", err);
            toast.error("Failed to create share link");
        } finally {
            setShareLoading(false);
        }
    };

    const handleCopyShareUrl = async () => {
        if (!shareUrl) return;
        try {
            await navigator.clipboard.writeText(shareUrl);
            setShareCopied(true);
            toast.success("Link copied to clipboard");
            setTimeout(() => setShareCopied(false), 2000);
        } catch {
            toast.error("Failed to copy link");
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

    const handleRowTouchEnd = useDoubleTapList(handlePlayTrack);

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

    // ── Drag-to-reorder ──────────────────────────────────────────────────────

    const handleDragStart = (itemId: string) => {
        setDraggedItemId(itemId);
    };

    const handleDragOver = (e: React.DragEvent, itemId: string) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragOverItemId !== itemId) {
            setDragOverItemId(itemId);
        }
    };

    const handleDragEnd = () => {
        setDraggedItemId(null);
        setDragOverItemId(null);
    };

    const handleDrop = async (targetItemId: string) => {
        if (!draggedItemId || draggedItemId === targetItemId) {
            handleDragEnd();
            return;
        }
        try {
            await moveTrack({
                playlistId,
                itemId: draggedItemId,
                afterItemId: targetItemId,
            });
        } catch {
            toast.error("Failed to reorder track");
        }
        handleDragEnd();
    };

    // ── Up/down keyboard/touch reorder ───────────────────────────────────────

    const handleMoveTrackUp = async (itemId: string) => {
        if (!playlist?.items || playlist.items.length < 2) return;
        const idx = playlist.items.findIndex((i: PlaylistItem) => i.id === itemId);
        if (idx <= 0) return;
        try {
            await moveTrack({
                playlistId,
                itemId,
                // Move to position idx-1: place after the item two positions above,
                // or null (first position) when idx === 1.
                afterItemId: idx === 1 ? null : playlist.items[idx - 2].id,
            });
        } catch {
            toast.error("Failed to move track");
        }
    };

    const handleMoveTrackDown = async (itemId: string) => {
        if (!playlist?.items || playlist.items.length < 2) return;
        const idx = playlist.items.findIndex((i: PlaylistItem) => i.id === itemId);
        if (idx === -1 || idx >= playlist.items.length - 1) return;
        try {
            await moveTrack({
                playlistId,
                itemId,
                afterItemId: playlist.items[idx + 1].id,
            });
        } catch {
            toast.error("Failed to move track");
        }
    };

    const rows: (PlaylistItem | PendingTrack)[] = useMemo(
        () => (playlist?.mergedItems || playlist?.items || []) as (PlaylistItem | PendingTrack)[],
        [playlist?.mergedItems, playlist?.items]
    );

    // Measure the list container's offset within the scroll container (#main-content)
    // so the virtualizer positions rows correctly. Re-measures on reflow above the
    // list (e.g. the responsive hero crossing the md breakpoint shifts listRef ~52px)
    // via a ResizeObserver, so scrollMargin can't go stale if overscan is later tuned.
    useLayoutEffect(() => {
        const measure = () => {
            if (!listRef.current || !scrollContainerRef.current) return;
            const containerTop = scrollContainerRef.current.getBoundingClientRect().top;
            const listTop = listRef.current.getBoundingClientRect().top;
            const offset = listTop - containerTop + scrollContainerRef.current.scrollTop;
            setScrollMargin(offset);
        };
        measure();
        if (!scrollContainerRef.current || !listRef.current) return;
        const ro = new ResizeObserver(measure);
        ro.observe(scrollContainerRef.current);
        if (listRef.current.parentElement) ro.observe(listRef.current.parentElement);
        return () => ro.disconnect();
    }, [rows.length]);

    const virtualizer = useVirtualizer({
        count: rows.length,
        estimateSize: () => 56,
        overscan: 12,
        getScrollElement: () => scrollContainerRef.current,
        scrollMargin,
    });

    const renderRow = (item: PlaylistItem | PendingTrack, index: number) => {
            if (item.type === "pending") {
                const pending = (item as PendingTrack).pending;
                const isPreviewPlaying = playingPreviewId === pending.id;
                const isRetrying = retryingTrackId === pending.id;
                const isRemoving = removingTrackId === pending.id;
                const isMissing = pending.missingFromDisk === true;

                return (
                    <div
                        key={`pending-${pending.id}`}
                        className="grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_120px] gap-4 px-4 py-2 rounded-lg opacity-60 hover:opacity-80 group transition-opacity"
                    >
                        <div className="flex items-center justify-center">
                            {isMissing ? (
                                <FileX className="w-4 h-4 text-amber-400" />
                            ) : (
                                <AlertCircle className="w-4 h-4 text-red-400" />
                            )}
                        </div>

                        <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 h-10 bg-[var(--bg-primary)] border border-white/10 rounded-lg shrink-0 overflow-hidden flex items-center justify-center">
                                <button
                                    onClick={() => handlePlayPreview(pending.id)}
                                    className="w-full h-full flex items-center justify-center hover:bg-white/5 transition-colors"
                                    title="Play 30s Deezer preview"
                                >
                                    {isPreviewPlaying ? (
                                        <Volume2 className="w-5 h-5 text-brand animate-pulse" />
                                    ) : (
                                        <Play className="w-5 h-5 text-[var(--text-muted)] hover:text-white/60" />
                                    )}
                                </button>
                            </div>
                            <div className="min-w-0">
                                <p className="text-sm font-medium truncate text-[var(--text-muted)]">
                                    {pending.title}
                                </p>
                                <p className="text-xs tabular-nums text-[var(--text-muted)] truncate">
                                    {pending.artist}
                                </p>
                            </div>
                        </div>

                        <p className="hidden md:flex items-center text-xs tabular-nums text-[var(--text-muted)] truncate">
                            {pending.album}
                        </p>

                        <div className="flex items-center justify-end gap-1">
                            <span className={cn(
                                "text-xs tabular-nums mr-2 hidden sm:inline",
                                isMissing ? "text-amber-400" : "text-red-400"
                            )}>
                                {isMissing ? "Missing from disk" : "Failed"}
                            </span>
                            {!isMissing && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleRetryPendingTrack(pending.id);
                                    }}
                                    disabled={isRetrying}
                                    className={cn(
                                        "p-1.5 rounded-lg hover:bg-white/10 transition-all",
                                        isRetrying
                                            ? "text-brand"
                                            : "text-[var(--text-muted)] hover:text-white/60"
                                    )}
                                    title="Retry download"
                                >
                                    {isRetrying ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                        <RefreshCw className="w-4 h-4" />
                                    )}
                                </button>
                            )}
                            {playlist?.isOwner && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleRemovePendingTrack(pending.id);
                                    }}
                                    disabled={isRemoving}
                                    className="p-1.5 rounded-lg hover:bg-white/10 text-[var(--text-muted)] hover:text-red-400 transition-all"
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
            const trackIndex = playlist?.items?.findIndex(
                (i: PlaylistItem) => i.id === playlistItem.id
            ) ?? index;

            return (
                <div
                    key={playlistItem.id}
                    data-track-index={trackIndex}
                    draggable={!!playlist?.isOwner}
                    onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", playlistItem.id);
                        e.dataTransfer.effectAllowed = "move";
                        handleDragStart(playlistItem.id);
                    }}
                    onDragOver={(e) => handleDragOver(e, playlistItem.id)}
                    onDragEnd={handleDragEnd}
                    onDrop={(e) => {
                        e.preventDefault();
                        handleDrop(playlistItem.id);
                    }}
                    onDoubleClick={() => handlePlayTrack(trackIndex)}
                    onTouchEnd={handleRowTouchEnd}
                    className={cn(
                        "grid grid-cols-[40px_1fr_auto]",
                        TRACK_GRID_MD,
                        "gap-4 px-4 py-2 rounded-lg hover:bg-white/[0.03] transition-all group cursor-pointer border border-transparent hover:border-white/5 touch-manipulation",
                        draggedItemId === playlistItem.id && "opacity-50",
                        dragOverItemId === playlistItem.id && "border-brand/40 bg-brand/5",
                        isCurrentlyPlaying && "bg-white/5 border-brand/30"
                    )}
                >
                    {/* Track Number / Play Button + Drag Handle */}
                    <div className="flex items-center justify-center gap-1">
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
                                    "text-xs group-hover:hidden",
                                    isCurrentlyPlaying
                                        ? "text-brand font-bold"
                                        : "text-[var(--text-muted)]"
                                )}
                            >
                                {isCurrentlyPlaying && isPlaying ? (
                                    <Music className="w-4 h-4 text-brand animate-pulse" />
                                ) : (
                                    trackIndex + 1
                                )}
                            </span>
                            <Play className="w-4 h-4 text-white hidden group-hover:block" />
                        </button>
                        {playlist?.isOwner && (
                            <button
                                draggable={false}
                                onDragStart={(e) => {
                                    e.stopPropagation();
                                    e.dataTransfer.setData("text/plain", playlistItem.id);
                                    e.dataTransfer.effectAllowed = "move";
                                    handleDragStart(playlistItem.id);
                                }}
                                onDragEnd={handleDragEnd}
                                aria-label="Drag to reorder"
                                className="w-6 h-6 flex items-center justify-center rounded opacity-0 group-hover:opacity-60 hover:opacity-100 transition-all cursor-grab active:cursor-grabbing text-[var(--text-muted)] hover:text-white"
                            >
                                <GripVertical className="w-4 h-4" />
                            </button>
                        )}
                    </div>

                    {/* Title + Artist */}
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="relative w-10 h-10 bg-[var(--bg-primary)] rounded-lg shrink-0 overflow-hidden border border-white/10">
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
                                    "text-sm font-bold truncate tracking-tight",
                                    isCurrentlyPlaying
                                        ? "text-brand"
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
                            <p className="text-xs tabular-nums text-[var(--text-muted)] truncate">
                                {playlistItem.track.album.artist.name}
                            </p>
                        </div>
                    </div>

                    {/* Album */}
                    <p className="hidden md:flex items-center text-xs tabular-nums text-[var(--text-muted)] truncate">
                        {playlistItem.track.album.title}
                    </p>

                    {/* Duration + Actions */}
                    <div className="flex items-center justify-end gap-2">
                        <button
                            className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-white/10 text-[var(--text-muted)] hover:text-white transition-all"
                            onClick={(e) => {
                                e.stopPropagation();
                                handleAddToQueue(playlistItem.track);
                            }}
                            title="Add to Queue"
                        >
                            <ListPlus className="w-4 h-4" />
                        </button>
                        <span className="text-xs tabular-nums text-[var(--text-muted)] w-12 text-right">
                            {formatTime(playlistItem.track.duration)}
                        </span>
                        {playlist?.isOwner && (
                            <>
                                <button
                                aria-label="Move track up"
                                className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-white/10 text-[var(--text-muted)] hover:text-white transition-all"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleMoveTrackUp(playlistItem.id);
                                }}
                                title="Move up"
                                >
                                    <ChevronUp className="w-4 h-4" />
                                </button>
                                <button
                                    aria-label="Move track down"
                                className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-white/10 text-[var(--text-muted)] hover:text-white transition-all"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleMoveTrackDown(playlistItem.id);
                                }}
                                title="Move down"
                                >
                                    <ChevronDown className="w-4 h-4" />
                                </button>
                                <button
                                    className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-white/10 text-[var(--text-muted)] hover:text-red-400 transition-all"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleRemoveTrack(playlistItem.track.id);
                                    }}
                                    title="Remove from Playlist"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </>
                        )}
                    </div>
                </div>
            );
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!playlist) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
                <p className="text-xs text-[var(--text-muted)]">Playlist not found</p>
            </div>
        );
    }

    // Get hero image from first cover
    const heroImage = coverUrls.length > 0 ? api.getCoverArtUrl(coverUrls[0] as string, 500) : null;

    return (
        <div className="min-h-screen bg-gradient-to-b from-[#0a0a0a] to-black section-stack">
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
                            className="flex items-center gap-2 text-xs tabular-nums text-[var(--text-muted)] hover:text-white transition-colors mb-6"
                        >
                            <ArrowLeft className="w-3.5 h-3.5" />
                            Playlists
                        </button>

                        {/* System status */}
                        <div className="flex items-center gap-2 mb-4">
                            <div className="w-1.5 h-1.5 bg-brand rounded-full" />
                            <span className="t-eyebrow">
                                {isShared ? "Public Playlist" : "Playlist"}
                            </span>
                        </div>

                        <div className="flex items-end gap-6">
                            {/* Cover Art Mosaic */}
                            <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[var(--bg-primary)] rounded-lg shrink-0 overflow-hidden relative border-2 border-white/10">
                                {coverUrls && coverUrls.length === 1 ? (
                                    <Image
                                        src={api.getCoverArtUrl(coverUrls[0], 400)}
                                        alt=""
                                        fill
                                        className="object-cover"
                                        sizes="192px"
                                        unoptimized
                                    />
                                ) : coverUrls && coverUrls.length > 1 ? (
                                    <div className="grid grid-cols-2 gap-0 w-full h-full">
                                        {coverUrls.slice(0, 4).map((url: string | undefined, index: number) => {
                                            if (!url) return null;
                                            const proxiedUrl = api.getCoverArtUrl(url, 200);
                                            return (
                                                <div key={index} className="relative bg-[var(--bg-primary)]">
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
                                    <input
                                        type="text"
                                        value={editName}
                                        onChange={(e) => setEditName(e.target.value)}
                                        onKeyDown={async (e) => {
                                            if (e.key === "Enter") {
                                                e.preventDefault();
                                                editSaveRef.current = true;
                                                const trimmed = editName.trim();
                                                if (trimmed && trimmed !== playlist.name) {
                                                    try {
                                                        await updatePlaylist({ playlistId, data: { name: trimmed } });
                                                        setIsEditingName(false);
                                                    } catch {
                                                        editSaveRef.current = false;
                                                        toast.error("Failed to rename playlist");
                                                    }
                                                } else {
                                                    setIsEditingName(false);
                                                }
                                            } else if (e.key === "Escape") {
                                                editSaveRef.current = true;
                                                setIsEditingName(false);
                                            }
                                        }}
                                        onBlur={async () => {
                                            if (editSaveRef.current) {
                                                editSaveRef.current = false;
                                                return;
                                            }
                                            const trimmed = editName.trim();
                                            if (trimmed && trimmed !== playlist.name) {
                                                try {
                                                    await updatePlaylist({ playlistId, data: { name: trimmed } });
                                                    setIsEditingName(false);
                                                } catch {
                                                    toast.error("Failed to rename playlist");
                                                }
                                            } else {
                                                setIsEditingName(false);
                                            }
                                        }}
                                        autoFocus
                                        className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight tracking-tight bg-transparent border-b border-white/30 outline-none w-full"
                                    />
                                ) : (
                                    <h1
                                        className={`text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2 tracking-tight ${playlist.isOwner ? "cursor-text hover:underline hover:decoration-white/20 decoration-2 underline-offset-4" : ""}`}
                                        onClick={() => {
                                            if (playlist.isOwner) {
                                                setEditName(playlist.name);
                                                setIsEditingName(true);
                                            }
                                        }}
                                    >
                                        {playlist.name}
                                    </h1>
                                )}

                                <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums text-[var(--text-secondary)]">
                                    {isShared && playlist.user?.username && (
                                        <>
                                            <span className="font-bold text-white normal-case tracking-tight text-sm">
                                                {playlist.user.username}
                                            </span>
                                            <span className="text-[var(--text-muted)]">|</span>
                                        </>
                                    )}
                                    <span>{playlist.items?.length || 0} songs</span>
                                    {totalDuration > 0 && (
                                        <>
                                            <span className="text-[var(--text-muted)]">|</span>
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
            <div className="relative px-4 md:px-8 py-4">
                <div className="max-w-[1800px] mx-auto flex items-center gap-4">
                    {/* Play Button */}
                    {playlist.items && playlist.items.length > 0 && (
                        <button
                            onClick={handlePlayPlaylist}
                            aria-label={isThisPlaylistPlaying && isPlaying ? "Pause" : "Play all"}
                            className="h-12 w-12 rounded-lg bg-brand hover:bg-[#f97316] hover:scale-105 flex items-center justify-center transition-all"
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
                            className="h-8 w-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-[var(--text-muted)] hover:text-white transition-all"
                            title="Shuffle play"
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>
                    )}

                    <div className="flex-1" />

                    {/* Share Button */}
                    {playlist.isOwner && (
                        <div className="relative" data-share-popover>
                            <button
                                onClick={handleShare}
                                disabled={shareLoading}
                                className={cn(
                                    "h-8 w-8 rounded-lg flex items-center justify-center transition-all",
                                    showSharePopover
                                        ? "text-brand"
                                        : "text-[var(--text-muted)] hover:text-white/60",
                                    shareLoading && "opacity-50 cursor-not-allowed"
                                )}
                                title="Share playlist"
                            >
                                {shareLoading ? (
                                    <Loader2 className="w-5 h-5 animate-spin" />
                                ) : (
                                    <Share2 className="w-5 h-5" />
                                )}
                            </button>

                            {/* Share Popover */}
                            {showSharePopover && shareUrl && (
                                <div className="absolute right-0 top-full mt-2 z-(--z-dropdown) w-80 bg-[var(--bg-hover)] border border-white/10 rounded-lg p-3">
                                    <div className="flex items-center gap-2 mb-2">
                                        <LinkIcon className="w-3.5 h-3.5 text-brand" />
                                        <span className="text-xs text-[var(--text-secondary)]">
                                            Share Link
                                        </span>
                                        <button
                                            onClick={() => setShowSharePopover(false)}
                                            className="ml-auto text-[var(--text-muted)] hover:text-white/60"
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="text"
                                            readOnly
                                            value={shareUrl}
                                            className="flex-1 bg-black/40 border border-white/10 rounded px-2.5 py-1.5 text-xs tabular-nums text-[var(--text-secondary)] outline-none select-all"
                                            onClick={(e) => (e.target as HTMLInputElement).select()}
                                        />
                                        <button
                                            onClick={handleCopyShareUrl}
                                            className="h-8 px-3 rounded bg-brand hover:bg-[#f97316] text-black text-xs font-semibold flex items-center gap-1.5 transition-colors flex-shrink-0"
                                        >
                                            {shareCopied ? (
                                                <Check className="w-3.5 h-3.5" />
                                            ) : (
                                                <Copy className="w-3.5 h-3.5" />
                                            )}
                                            {shareCopied ? "Copied" : "Copy"}
                                        </button>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            if (!shareToken) return;
                                            try {
                                                await api.revokeShareLink(shareToken);
                                                setShareUrl(null);
                                                setShareToken(null);
                                                setShowSharePopover(false);
                                                toast.success("Share link revoked");
                                            } catch {
                                                toast.error("Failed to revoke share link");
                                            }
                                        }}
                                        className="text-micro text-[var(--text-muted)] hover:text-red-400/70 transition-colors mt-1"
                                    >
                                        Revoke link
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Visibility Toggle */}
                    {playlist.isOwner && (
                        <button
                            onClick={handleTogglePublic}
                            disabled={isUpdatingPlaylist}
                            className={cn(
                                "h-8 w-8 rounded-lg flex items-center justify-center transition-all",
                                playlist.isPublic
                                    ? "text-brand"
                                    : "text-[var(--text-muted)] hover:text-white/60",
                                isUpdatingPlaylist && "opacity-50 cursor-not-allowed"
                            )}
                            title={playlist.isPublic ? "Make private" : "Make public"}
                        >
                            {playlist.isPublic ? (
                                <Globe className="w-5 h-5" />
                            ) : (
                                <Lock className="w-5 h-5" />
                            )}
                        </button>
                    )}

                    {/* Hide Button */}
                    <button
                        onClick={handleToggleHide}
                        disabled={isHiding}
                        className={cn(
                            "h-8 w-8 rounded-lg flex items-center justify-center transition-all",
                            playlist.isHidden
                                ? "text-brand hover:text-[#f97316]"
                                : "text-[var(--text-muted)] hover:text-white/60",
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
                            className="h-8 w-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-red-400 transition-all"
                            title="Delete Playlist"
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                    )}
                </div>
            </div>

            {/* Track Listing */}
            <div className="relative px-4 md:px-8 pb-32">
                <div className="max-w-[1800px] mx-auto">
                    {/* Pending tracks notice */}
                    {playlist.pendingCount > 0 && (
                        <div className="mb-4 px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <AlertCircle className="w-4 h-4 text-red-400" />
                                <span className="text-xs tabular-nums text-red-300">
                                    {playlist.pendingCount} track
                                    {playlist.pendingCount !== 1 ? "s" : ""} failed to
                                    download
                                </span>
                            </div>
                            <button
                                onClick={handleRetryAllPending}
                                disabled={retryingAll}
                                className="flex items-center gap-1.5 px-3 py-1 text-xs tabular-nums text-red-300 hover:text-red-200 hover:bg-red-500/20 rounded transition-colors disabled:opacity-50"
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
                                <span className="w-1 h-8 bg-gradient-to-b from-brand to-[#f97316] rounded-full shrink-0" />
                                <h2 className="text-2xl font-bold tracking-tight">Tracks</h2>
                                <span className="text-xs tabular-nums text-brand">
                                    {playlist.items?.length || 0}
                                </span>
                                <span className="flex-1 border-t border-white/10" />
                            </div>

                            {/* Table Header */}
                            {/* The number and the drag handle share a row's first cell,
                                so they share one heading. See TRACK_GRID. */}
                            <div className={cn("hidden md:grid", TRACK_GRID, "gap-4 px-4 py-2 text-xs text-[var(--text-muted)] border-b border-white/10 mb-2")}>
                                <span className="text-center">#</span>
                                <span>Title</span>
                                <span>Album</span>
                                <span className="text-right">Duration</span>
                            </div>

                            {/* Track Rows -- window-virtualized */}
                            <div
                                ref={listRef}
                                style={{
                                    height: virtualizer.getTotalSize(),
                                    position: "relative",
                                }}
                            >
                                {virtualizer.getVirtualItems().map((vi) => (
                                    <div
                                        key={vi.key}
                                        data-index={vi.index}
                                        ref={virtualizer.measureElement}
                                        style={{
                                            position: "absolute",
                                            top: 0,
                                            left: 0,
                                            width: "100%",
                                            transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
                                        }}
                                    >
                                        {renderRow(rows[vi.index], vi.index)}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div>
                            <div className="relative overflow-hidden rounded-lg border-2 border-white/10 bg-gradient-to-br from-[#0f0f0f] to-[#0a0a0a] p-12">
                                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-brand to-[#f97316]" />

                                <div className="flex items-center gap-3 mb-8 pb-4 border-b border-white/10">
                                    <div className="w-2 h-2 bg-brand" />
                                    <span className="text-xs text-[var(--text-secondary)]">
                                        Empty Playlist
                                    </span>
                                </div>

                                <div className="flex flex-col items-center text-center">
                                    <div className="w-16 h-16 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center mb-6">
                                        <ListMusic className="w-8 h-8 text-white/10" />
                                    </div>
                                    <h3 className="text-2xl font-bold tracking-tight text-white mb-2">
                                        No tracks yet
                                    </h3>
                                    <p className="text-xs text-[var(--text-muted)]">
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
