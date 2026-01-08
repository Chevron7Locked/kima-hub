"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAudio } from "@/lib/audio-context";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tab, DeleteDialogState } from "@/features/library/types";
import {
    useLibraryData,
    LibraryFilter,
    SortOption,
} from "@/features/library/hooks/useLibraryData";
import { api } from "@/lib/api";
import { useLibraryActions } from "@/features/library/hooks/useLibraryActions";
import { LibraryHeader } from "@/features/library/components/LibraryHeader";
import { LibraryTabs } from "@/features/library/components/LibraryTabs";
import { ArtistsGrid } from "@/features/library/components/ArtistsGrid";
import { AlbumsGrid } from "@/features/library/components/AlbumsGrid";
import { TracksList } from "@/features/library/components/TracksList";
import { Shuffle, ListFilter } from "lucide-react";

export default function LibraryPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { currentTrack, playTracks } = useAudio();

    // Get active tab from URL params, default to "artists"
    const activeTab = (searchParams.get("tab") as Tab) || "artists";

    // Read page from URL params
    const urlPage = parseInt(searchParams.get("page") || "1", 10);

    // Filter state (owned = your library, discovery = discovery weekly artists)
    const [filter, setFilter] = useState<LibraryFilter>("owned");

    // Sort and pagination state
    const [sortBy, setSortBy] = useState<SortOption>("name");
    const [itemsPerPage, setItemsPerPage] = useState<number>(40);
    const [currentPage, setCurrentPage] = useState(urlPage);
    const [showFilters, setShowFilters] = useState(false);

    // Sync currentPage with URL changes (browser back/forward)
    useEffect(() => {
        setCurrentPage(urlPage);
    }, [urlPage]);

    // Use custom hooks with server-side pagination
    const { artists, albums, tracks, isLoading, reloadData, pagination } =
        useLibraryData({
            activeTab,
            filter,
            sortBy,
            itemsPerPage,
            currentPage,
        });
    const {
        playArtist,
        playAlbum,
        addTrackToQueue,
        addTrackToPlaylist,
        deleteArtist,
        deleteAlbum,
        deleteTrack,
    } = useLibraryActions();

    // Reset page and filter when tab changes
    useEffect(() => {
        setCurrentPage(1);
        // Reset filter to 'owned' when switching to tracks tab (which doesn't support filter)
        if (activeTab === "tracks") {
            setFilter("owned");
        }
    }, [activeTab]);

    // Reset page when filter or sort changes
    useEffect(() => {
        setCurrentPage(1);
    }, [filter, sortBy, itemsPerPage]);

    // Get total items and pages from pagination
    const totalItems = pagination.total;
    const totalPages = pagination.totalPages;

    // Delete confirmation dialog state
    const [deleteConfirm, setDeleteConfirm] = useState<DeleteDialogState>({
        isOpen: false,
        type: "track",
        id: "",
        title: "",
    });

    // Change tab function
    const changeTab = (tab: Tab) => {
        router.push(`/library?tab=${tab}`, { scroll: false });
    };

    // Update page with URL state and scroll to top
    const updatePage = (page: number) => {
        const params = new URLSearchParams();
        params.set("tab", activeTab);
        params.set("page", String(page));
        router.push(`/library?${params.toString()}`, { scroll: false });
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    // Helper to convert library Track to audio context Track format
    const formatTracksForAudio = (libraryTracks: typeof tracks) => {
        return libraryTracks.map((track) => ({
            id: track.id,
            title: track.title,
            duration: track.duration,
            artist: {
                id: track.album?.artist?.id,
                name: track.album?.artist?.name || "Unknown Artist",
            },
            album: {
                id: track.album?.id,
                title: track.album?.title || "Unknown Album",
                coverArt: track.album?.coverArt,
            },
        }));
    };

    // Wrapper for playTracks that converts track format
    const handlePlayTracks = (
        libraryTracks: typeof tracks,
        startIndex?: number
    ) => {
        const formattedTracks = formatTracksForAudio(libraryTracks);
        playTracks(formattedTracks, startIndex);
    };

    // Shuffle entire library - uses server-side shuffle for large libraries
    const handleShuffleLibrary = async () => {
        try {
            // Use server-side shuffle endpoint for better performance with large libraries
            const { tracks: shuffledTracks } = await api.getShuffledTracks(500);

            if (shuffledTracks.length === 0) {
                return;
            }

            const formattedTracks = formatTracksForAudio(shuffledTracks);
            playTracks(formattedTracks, 0);
        } catch (error) {
            console.error("Failed to shuffle library:", error);
        }
    };

    // Handle delete confirmation
    const handleDelete = async () => {
        try {
            switch (deleteConfirm.type) {
                case "artist":
                    await deleteArtist(deleteConfirm.id);
                    break;
                case "album":
                    await deleteAlbum(deleteConfirm.id);
                    break;
                case "track":
                    await deleteTrack(deleteConfirm.id);
                    break;
            }

            // Reload data and close dialog - the item disappearing is feedback enough
            await reloadData();
            setDeleteConfirm({
                isOpen: false,
                type: "track",
                id: "",
                title: "",
            });
        } catch (error) {
            console.error(`Failed to delete ${deleteConfirm.type}:`, error);
            // Keep dialog open on error so user can retry
        }
    };

    return (
        <div className="min-h-screen relative">
            <LibraryHeader />

            <div className="relative px-4 md:px-8 pb-24">
                {/* Tabs and Controls Row */}
                <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
                    <LibraryTabs
                        activeTab={activeTab}
                        onTabChange={changeTab}
                    />

                    <div className="flex items-center gap-2">
                        {/* Shuffle Button */}
                        <button
                            onClick={handleShuffleLibrary}
                            className="flex items-center justify-center w-8 h-8 rounded-full bg-[#ecb200] hover:bg-[#d4a000] text-black transition-all hover:scale-105"
                            title="Shuffle Library"
                        >
                            <Shuffle className="w-4 h-4" />
                        </button>

                        {/* Filter Toggle */}
                        <button
                            onClick={() => setShowFilters(!showFilters)}
                            className={`flex items-center justify-center w-8 h-8 rounded-full transition-all ${
                                showFilters
                                    ? "bg-white/20 text-white"
                                    : "bg-white/5 text-gray-400 hover:text-white hover:bg-white/10"
                            }`}
                            title="Show Filters"
                        >
                            <ListFilter className="w-4 h-4" />
                        </button>

                        {/* Item Count */}
                        <span className="text-sm text-gray-400 ml-2">
                            {totalItems.toLocaleString()}{" "}
                            {activeTab === "artists"
                                ? "artists"
                                : activeTab === "albums"
                                ? "albums"
                                : "songs"}
                        </span>
                    </div>
                </div>

                {/* Expandable Filters Row */}
                {showFilters && (
                    <div className="flex flex-wrap items-center gap-2 mb-6 pb-4 border-b border-white/5">
                        {/* Filter Toggle (Owned / Discovery / All) - Only show for artists and albums */}
                        {(activeTab === "artists" ||
                            activeTab === "albums") && (
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => setFilter("owned")}
                                    className={`px-3 py-1.5 text-xs font-medium rounded-full transition-all ${
                                        filter === "owned"
                                            ? "bg-[#ecb200] text-black"
                                            : "bg-white/5 text-gray-400 hover:text-white hover:bg-white/10"
                                    }`}
                                >
                                    Owned
                                </button>
                                <button
                                    onClick={() => setFilter("discovery")}
                                    className={`px-3 py-1.5 text-xs font-medium rounded-full transition-all ${
                                        filter === "discovery"
                                            ? "bg-purple-500 text-white"
                                            : "bg-white/5 text-gray-400 hover:text-white hover:bg-white/10"
                                    }`}
                                >
                                    Discovery
                                </button>
                                <button
                                    onClick={() => setFilter("all")}
                                    className={`px-3 py-1.5 text-xs font-medium rounded-full transition-all ${
                                        filter === "all"
                                            ? "bg-white/20 text-white"
                                            : "bg-white/5 text-gray-400 hover:text-white hover:bg-white/10"
                                    }`}
                                >
                                    All
                                </button>
                            </div>
                        )}

                        {/* Sort Dropdown */}
                        <select
                            value={sortBy}
                            onChange={(e) =>
                                setSortBy(e.target.value as SortOption)
                            }
                            className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-full text-white text-xs focus:outline-none focus:border-white/20 [&>option]:bg-[#1a1a1a] [&>option]:text-white"
                        >
                            <option value="name">Name (A-Z)</option>
                            <option value="name-desc">Name (Z-A)</option>
                            {activeTab === "albums" && (
                                <option value="recent">Year (Newest)</option>
                            )}
                            {activeTab === "artists" && (
                                <option value="tracks">Most Tracks</option>
                            )}
                        </select>

                        {/* Items per page */}
                        <select
                            value={itemsPerPage}
                            onChange={(e) =>
                                setItemsPerPage(Number(e.target.value))
                            }
                            className="px-3 py-1.5 bg-white/5 border border-white/10 rounded-full text-white text-xs focus:outline-none focus:border-white/20 [&>option]:bg-[#1a1a1a] [&>option]:text-white"
                        >
                            <option value={24}>24 per page</option>
                            <option value={40}>40 per page</option>
                            <option value={80}>80 per page</option>
                            <option value={200}>200 per page</option>
                        </select>
                    </div>
                )}

                {activeTab === "artists" && (
                    <ArtistsGrid
                        artists={artists}
                        isLoading={isLoading}
                        onPlay={playArtist}
                        onDelete={(id, name) =>
                            setDeleteConfirm({
                                isOpen: true,
                                type: "artist",
                                id,
                                title: name,
                            })
                        }
                    />
                )}

                {activeTab === "albums" && (
                    <AlbumsGrid
                        albums={albums}
                        isLoading={isLoading}
                        onPlay={playAlbum}
                        onDelete={(id, title) =>
                            setDeleteConfirm({
                                isOpen: true,
                                type: "album",
                                id,
                                title,
                            })
                        }
                    />
                )}

                {activeTab === "tracks" && (
                    <TracksList
                        tracks={tracks}
                        isLoading={isLoading}
                        currentTrackId={currentTrack?.id}
                        onPlay={handlePlayTracks}
                        onAddToQueue={addTrackToQueue}
                        onAddToPlaylist={addTrackToPlaylist}
                        onDelete={(id: string, title: string) =>
                            setDeleteConfirm({
                                isOpen: true,
                                type: "track",
                                id,
                                title,
                            })
                        }
                    />
                )}

                {/* Pagination */}
                {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 mt-8 pt-4 border-t border-white/5">
                        <button
                            onClick={() => updatePage(1)}
                            disabled={currentPage === 1 || isLoading}
                            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            First
                        </button>
                        <button
                            onClick={() =>
                                updatePage(Math.max(1, currentPage - 1))
                            }
                            disabled={currentPage === 1 || isLoading}
                            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Prev
                        </button>
                        <span className="px-4 py-1.5 text-xs text-white">
                            {currentPage} / {totalPages}
                        </span>
                        <button
                            onClick={() =>
                                updatePage(
                                    Math.min(totalPages, currentPage + 1)
                                )
                            }
                            disabled={currentPage === totalPages || isLoading}
                            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Next
                        </button>
                        <button
                            onClick={() => updatePage(totalPages)}
                            disabled={currentPage === totalPages || isLoading}
                            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Last
                        </button>
                    </div>
                )}

                <ConfirmDialog
                    isOpen={deleteConfirm.isOpen}
                    onClose={() =>
                        setDeleteConfirm({
                            isOpen: false,
                            type: "track",
                            id: "",
                            title: "",
                        })
                    }
                    onConfirm={handleDelete}
                    title={`Delete ${
                        deleteConfirm.type === "artist"
                            ? "Artist"
                            : deleteConfirm.type === "album"
                            ? "Album"
                            : "Track"
                    }?`}
                    message={
                        deleteConfirm.type === "track"
                            ? `Are you sure you want to delete "${deleteConfirm.title}"? This will permanently delete the file from your system.`
                            : deleteConfirm.type === "album"
                            ? `Are you sure you want to delete "${deleteConfirm.title}"? This will permanently delete all tracks and files from your system.`
                            : `Are you sure you want to delete "${deleteConfirm.title}"? This will permanently delete all albums, tracks, and files from your system.`
                    }
                    confirmText="Delete"
                    cancelText="Cancel"
                    variant="danger"
                />
            </div>
        </div>
    );
}
