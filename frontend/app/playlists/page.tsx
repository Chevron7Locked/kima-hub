"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { usePlaylistsQuery } from "@/hooks/useQueries";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { useAuth } from "@/lib/auth-context";
import { useAudioControls } from "@/lib/audio-context";
import { Play, Music, Eye, EyeOff, ListMusic } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";

interface PlaylistItem {
    id: string;
    track: {
        album?: {
            coverArt?: string;
        };
    };
}

interface Playlist {
    id: string;
    name: string;
    trackCount?: number;
    items?: PlaylistItem[];
    isOwner?: boolean;
    isHidden?: boolean;
    user?: {
        username: string;
    };
}

function PlaylistMosaic({
    items,
    size = 4,
    greyed = false,
}: {
    items?: PlaylistItem[];
    size?: number;
    greyed?: boolean;
}) {
    const coverUrls = useMemo(() => {
        if (!items || items.length === 0) return [];

        const tracksWithCovers = items.filter(
            (item) => item.track?.album?.coverArt
        );
        if (tracksWithCovers.length === 0) return [];

        // Count tracks per cover art, sort by frequency (most tracks first)
        const coverCounts = new Map<string, number>();
        for (const item of tracksWithCovers) {
            const cover = item.track.album!.coverArt!;
            coverCounts.set(cover, (coverCounts.get(cover) || 0) + 1);
        }
        const uniqueCovers = Array.from(coverCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([cover]) => cover);

        const urls = uniqueCovers.map((cover) => api.getCoverArtUrl(cover, 200));

        if (urls.length >= size) return urls.slice(0, size);
        if (urls.length <= 1) return urls;

        // Fill all 4 slots, duplicate the most-represented album at its diagonal
        // Grid: [0][1] / [2][3] — adjacent pairs: 0-1, 0-2, 1-3, 2-3
        if (urls.length === 2) return [urls[0], urls[1], urls[1], urls[0]];
        // 3 unique: urls[0] has the most tracks, place duplicate at diagonal
        return [urls[0], urls[1], urls[2], urls[0]];
    }, [items, size]);

    if (coverUrls.length === 0) {
        return (
            <div
                className={cn(
                    "w-full h-full flex items-center justify-center bg-[#0a0a0a]",
                    greyed && "opacity-50"
                )}
            >
                <Music className="w-10 h-10 text-white/10" />
            </div>
        );
    }

    if (coverUrls.length === 1) {
        return (
            <Image
                src={coverUrls[0]}
                alt=""
                fill
                className={cn("object-cover", greyed && "opacity-50 grayscale")}
                sizes="200px"
                unoptimized
            />
        );
    }

    return (
        <div
            className={cn(
                "grid grid-cols-2 w-full h-full",
                greyed && "opacity-50 grayscale"
            )}
        >
            {coverUrls.slice(0, 4).map((url, index) => (
                <div key={index} className="relative">
                    <Image
                        src={url}
                        alt=""
                        fill
                        className="object-cover"
                        sizes="100px"
                        unoptimized
                    />
                </div>
            ))}
        </div>
    );
}

function PlaylistCard({
    playlist,
    index,
    onPlay,
    onToggleHide,
    isHiddenView = false,
}: {
    playlist: Playlist;
    index: number;
    onPlay: (playlistId: string) => void;
    onToggleHide: (playlistId: string, hide: boolean) => void;
    isHiddenView?: boolean;
}) {
    const isShared = playlist.isOwner === false;
    const [isHiding, setIsHiding] = useState(false);

    const handleToggleHide = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsHiding(true);
        try {
            await onToggleHide(playlist.id, !playlist.isHidden);
        } finally {
            setIsHiding(false);
        }
    };

    return (
        <Link href={`/playlist/${playlist.id}`}>
            <div
                className={cn(
                    "group cursor-pointer p-3 rounded-lg transition-all border border-transparent hover:bg-white/[0.03] hover:border-white/5",
                    isHiddenView && "opacity-60 hover:opacity-100"
                )}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                {/* Cover Image */}
                <div className="relative aspect-square mb-3 rounded-lg overflow-hidden bg-[#0a0a0a] border border-white/10 shadow-lg">
                    <PlaylistMosaic
                        items={playlist.items}
                        greyed={isHiddenView}
                    />

                    {/* Hide/Unhide button */}
                    {isShared && (
                        <button
                            onClick={handleToggleHide}
                            disabled={isHiding}
                            className={cn(
                                "absolute top-2 right-2 w-7 h-7 rounded-lg flex items-center justify-center",
                                "bg-black/60 transition-all duration-200",
                                "opacity-0 group-hover:opacity-100",
                                playlist.isHidden
                                    ? "text-green-400"
                                    : "text-white/40",
                                isHiding && "opacity-50 cursor-not-allowed"
                            )}
                            title={
                                playlist.isHidden
                                    ? "Show playlist"
                                    : "Hide playlist"
                            }
                        >
                            {playlist.isHidden ? (
                                <Eye className="w-3.5 h-3.5" />
                            ) : (
                                <EyeOff className="w-3.5 h-3.5" />
                            )}
                        </button>
                    )}

                    {/* Play button overlay */}
                    <button
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onPlay(playlist.id);
                        }}
                        className={cn(
                            "absolute bottom-2 right-2 w-10 h-10 rounded-lg flex items-center justify-center",
                            "bg-[#fca208] shadow-lg shadow-[#fca208]/20 transition-all duration-200",
                            "hover:bg-[#f97316] hover:scale-105",
                            "opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0"
                        )}
                        title="Play playlist"
                    >
                        <Play className="w-4 h-4 fill-current ml-0.5 text-black" />
                    </button>

                    {/* Bottom accent line */}
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-[#fca208] to-[#f97316] transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150 origin-left" />
                </div>

                {/* Title and info */}
                <h3
                    className={cn(
                        "text-sm font-black truncate tracking-tight",
                        isHiddenView ? "text-white/40" : "text-white"
                    )}
                >
                    {playlist.name}
                </h3>
                <p className="text-[10px] font-mono text-white/30 mt-0.5 truncate uppercase tracking-wider">
                    {isShared && playlist.user?.username ? (
                        <span>
                            {playlist.user.username} | {" "}
                        </span>
                    ) : null}
                    {playlist.trackCount || 0}{" "}
                    {playlist.trackCount === 1 ? "song" : "songs"}
                </p>
            </div>
        </Link>
    );
}

export default function PlaylistsPage() {
    useRouter();
    useAuth();
    const { playTracks } = useAudioControls();
    const queryClient = useQueryClient();
    const [showHiddenTab, setShowHiddenTab] = useState(false);

    const { data: playlists = [], isLoading } = usePlaylistsQuery();

    const { visiblePlaylists, hiddenPlaylists } = useMemo(() => {
        const visible: Playlist[] = [];
        const hidden: Playlist[] = [];

        playlists.forEach((p: Playlist) => {
            if (p.isHidden) {
                hidden.push(p);
            } else {
                visible.push(p);
            }
        });

        return { visiblePlaylists: visible, hiddenPlaylists: hidden };
    }, [playlists]);

    useEffect(() => {
        const handlePlaylistEvent = () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
        };

        window.addEventListener("playlist-created", handlePlaylistEvent);
        window.addEventListener("playlist-updated", handlePlaylistEvent);
        window.addEventListener("playlist-deleted", handlePlaylistEvent);

        return () => {
            window.removeEventListener("playlist-created", handlePlaylistEvent);
            window.removeEventListener("playlist-updated", handlePlaylistEvent);
            window.removeEventListener("playlist-deleted", handlePlaylistEvent);
        };
    }, [queryClient]);

    const handlePlayPlaylist = async (playlistId: string) => {
        try {
            const playlist = await api.getPlaylist(playlistId);
            if (playlist?.items && playlist.items.length > 0) {
                const tracks = playlist.items.map((item: { track: { id: string; title: string; duration: number; album?: { id?: string; title?: string; coverArt?: string; artist?: { id?: string; name?: string } } } }) => ({
                    id: item.track.id,
                    title: item.track.title,
                    artist: {
                        name: item.track.album?.artist?.name || "Unknown",
                        id: item.track.album?.artist?.id,
                    },
                    album: {
                        title: item.track.album?.title || "Unknown",
                        coverArt: item.track.album?.coverArt,
                        id: item.track.album?.id,
                    },
                    duration: item.track.duration,
                }));
                playTracks(tracks, 0);
            }
        } catch (error) {
            console.error("Failed to play playlist:", error);
        }
    };

    const handleToggleHide = async (playlistId: string, hide: boolean) => {
        try {
            if (hide) {
                await api.hidePlaylist(playlistId);
            } else {
                await api.unhidePlaylist(playlistId);
            }
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
        } catch (error) {
            console.error("Failed to toggle playlist visibility:", error);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    const displayedPlaylists = showHiddenTab
        ? hiddenPlaylists
        : visiblePlaylists;

    return (
        <div className="min-h-screen bg-gradient-to-b from-[#0a0a0a] to-black">
            {/* Editorial Header */}
            <div className="relative px-4 md:px-8 pt-8 pb-6">
                <div className="max-w-[1800px] mx-auto">
                    {/* System status */}
                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-1.5 h-1.5 bg-[#fca208] rounded-full" />
                        <span className="text-xs font-mono text-white/50 uppercase tracking-wider">
                            Your Library
                        </span>
                    </div>

                    <div className="flex items-end justify-between gap-4">
                        <div>
                            <h1 className="text-5xl md:text-6xl lg:text-7xl font-black tracking-tighter text-white leading-none">
                                PLAY<br />
                                <span className="text-[#fca208]">LISTS</span>
                            </h1>
                            <div className="flex items-center gap-3 mt-3 text-xs font-mono text-white/40 uppercase tracking-wider">
                                <span className="font-black text-white text-sm normal-case tracking-tight">
                                    {visiblePlaylists.length} {visiblePlaylists.length === 1 ? "playlist" : "playlists"}
                                </span>
                                {hiddenPlaylists.length > 0 && (
                                    <>
                                        <span className="text-white/20">|</span>
                                        <span>{hiddenPlaylists.length} hidden</span>
                                    </>
                                )}
                            </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                            <Link
                                href="/browse/playlists"
                                className="px-4 py-2 rounded-lg text-xs font-black bg-[#fca208] text-black hover:bg-[#f97316] transition-colors uppercase tracking-wider"
                            >
                                Browse
                            </Link>

                            {hiddenPlaylists.length > 0 && (
                                <button
                                    onClick={() => setShowHiddenTab(!showHiddenTab)}
                                    className={cn(
                                        "px-4 py-2 rounded-lg text-xs font-mono transition-all uppercase tracking-wider",
                                        showHiddenTab
                                            ? "bg-white/10 text-white border border-white/20"
                                            : "bg-white/5 border border-white/10 text-white/40 hover:text-white/70 hover:border-white/20"
                                    )}
                                >
                                    {showHiddenTab
                                        ? "Show All"
                                        : `Hidden (${hiddenPlaylists.length})`}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className="relative px-4 md:px-8 pb-24">
                <div className="max-w-[1800px] mx-auto">
                    {/* Hidden playlists notice */}
                    {showHiddenTab && (
                        <div className="mb-6 px-4 py-3 bg-white/5 rounded-lg border border-white/10">
                            <p className="text-xs font-mono text-white/40 uppercase tracking-wider">
                                Hidden playlists won&apos;t appear in your library. Hover
                                and click the eye icon to restore.
                            </p>
                        </div>
                    )}

                    {displayedPlaylists.length > 0 ? (
                        <div>
                            {/* Section header */}
                            <div className="flex items-center gap-3 mb-6">
                                <span className="w-1 h-8 bg-gradient-to-b from-[#fca208] to-[#f97316] rounded-full shrink-0" />
                                <h2 className="text-2xl font-black tracking-tighter uppercase">
                                    {showHiddenTab ? "Hidden" : "All Playlists"}
                                </h2>
                                <span className="text-xs font-mono text-[#fca208]">
                                    {displayedPlaylists.length}
                                </span>
                                <span className="flex-1 border-t border-white/10" />
                            </div>

                            <div
                                data-tv-section="playlists"
                                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-2"
                            >
                                {displayedPlaylists.map(
                                    (playlist: Playlist, index: number) => (
                                        <PlaylistCard
                                            key={playlist.id}
                                            playlist={playlist}
                                            index={index}
                                            onPlay={handlePlayPlaylist}
                                            onToggleHide={handleToggleHide}
                                            isHiddenView={showHiddenTab}
                                        />
                                    )
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
                                        {showHiddenTab ? "No Hidden Playlists" : "Getting Started"}
                                    </span>
                                </div>

                                <div className="flex flex-col items-center text-center">
                                    <div className="w-16 h-16 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center mb-6">
                                        <ListMusic className="w-8 h-8 text-white/10" />
                                    </div>
                                    <h2 className="text-2xl font-black tracking-tighter text-white mb-2 uppercase">
                                        {showHiddenTab
                                            ? "No hidden playlists"
                                            : "No playlists yet"}
                                    </h2>
                                    <p className="text-xs font-mono text-white/30 max-w-sm uppercase tracking-wider leading-relaxed">
                                        {showHiddenTab
                                            ? "You haven't hidden any playlists"
                                            : "Create your first playlist by adding songs from albums or artists"}
                                    </p>
                                    {!showHiddenTab && (
                                        <Link
                                            href="/browse/playlists"
                                            className="mt-8 px-6 py-3 rounded-lg text-xs font-black bg-[#fca208] text-black hover:bg-[#f97316] transition-colors uppercase tracking-wider"
                                        >
                                            Browse Playlists
                                        </Link>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
