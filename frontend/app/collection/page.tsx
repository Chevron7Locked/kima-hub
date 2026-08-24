"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAudioControls } from "@/lib/audio-controls-context";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tab, DeleteDialogState } from "@/features/library/types";
import {
    useLibraryArtistsQuery,
    useLibraryAlbumsQuery,
    useLibraryTracksQuery,
    LibraryFilter,
    SortOption,
} from "@/hooks/useQueries";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useLibraryActions } from "@/features/library/hooks/useLibraryActions";
import { LibraryHeader } from "@/features/library/components/LibraryHeader";
import { LibraryTabs } from "@/features/library/components/LibraryTabs";
import { LibraryToolbar } from "@/features/library/components/LibraryToolbar";
import { ArtistsGrid } from "@/features/library/components/ArtistsGrid";
import { AlbumsGrid } from "@/features/library/components/AlbumsGrid";
import { TracksList } from "@/features/library/components/TracksList";
import { Pagination } from "@/components/ui/Pagination";

export default function LibraryPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { playTracks } = useAudioControls();

    // Get active tab from URL params, default to "artists"
    const validTabs: Tab[] = ["artists", "albums", "tracks"];
    const tabParam = searchParams.get("tab");
    const activeTab: Tab = validTabs.includes(tabParam as Tab) ? (tabParam as Tab) : "artists";

    // Read page from URL params
    const urlPage = parseInt(searchParams.get("page") || "1", 10);

    // Filter state (owned = your library, discovery = discovery weekly artists)
    const [filter, setFilter] = useState<LibraryFilter>("owned");

    // Sort and pagination state
    const [sortBy, setSortBy] = useState<SortOption>("name");
    const [itemsPerPage, setItemsPerPage] = useState<number>(40);
    const [currentPage, setCurrentPage] = useState(urlPage);

    // Track previous page to detect pagination changes
    const prevPageRef = useRef(currentPage);

    // Sync currentPage with URL changes (browser back/forward)
    useEffect(() => {
        setCurrentPage(urlPage);
    }, [urlPage]);

    const queryClient = useQueryClient();

    // Use React Query hooks for cached data fetching
    // Only fetch data for active tab to prevent unnecessary API calls
    const artistsQuery = useLibraryArtistsQuery({
        filter,
        sortBy,
        limit: itemsPerPage,
        page: currentPage,
        enabled: activeTab === "artists",
    });

    const albumsQuery = useLibraryAlbumsQuery({
        filter,
        sortBy,
        limit: itemsPerPage,
        page: currentPage,
        enabled: activeTab === "albums",
    });

    const tracksQuery = useLibraryTracksQuery({
        sortBy,
        limit: itemsPerPage,
        page: currentPage,
        enabled: activeTab === "tracks",
    });

    // Get data based on active tab.
    //
    // The server returns this list already ordered, by the article-stripped
    // `Artist.sortName` it also indexes and buckets on. There used to be a
    // client-side re-sort here with its own `^the\s+` stripper -- a fifth copy
    // of that rule, and the weakest: it knew one English article where the
    // server knows eleven across four languages, and it could only reorder the
    // page in hand, since the list is paginated server-side. Re-sorting a
    // correctly-ordered page by a worse rule can only make it wrong.
    const artists = useMemo(() => {
        if (activeTab !== "artists") {
            return [];
        }

        return artistsQuery.data?.artists ?? [];
    }, [activeTab, artistsQuery.data?.artists]);




    const albums = useMemo(
        () => (activeTab === "albums" ? (albumsQuery.data?.albums ?? []) : []),
        [activeTab, albumsQuery.data?.albums],
    );
    const tracks = useMemo(
        () => (activeTab === "tracks" ? (tracksQuery.data?.tracks ?? []) : []),
        [activeTab, tracksQuery.data?.tracks],
    );

    // Loading state based on active tab
    const isLoading =
        (activeTab === "artists" && artistsQuery.isLoading) ||
        (activeTab === "albums" && albumsQuery.isLoading) ||
        (activeTab === "tracks" && tracksQuery.isLoading);


    // Scroll to top when page changes (after data loads)
    useEffect(() => {
        if (prevPageRef.current !== currentPage) {
            prevPageRef.current = currentPage;
            // Scroll the main content container, not the window
            const mainContent = document.getElementById("main-content");
            if (mainContent) {
                mainContent.scrollTo({ top: 0, behavior: "instant" });
            }
        }
    }, [currentPage]);

    // Pagination from active query
    const pagination = useMemo(
        () => {
            // Get the total from the query data
            const total =
                activeTab === "artists" ? (artistsQuery.data?.total ?? 0)
                : activeTab === "albums" ? (albumsQuery.data?.total ?? 0)
                : (tracksQuery.data?.total ?? 0);

            return {
                total,
                offset: 0,
                limit: itemsPerPage,
                totalPages: Math.ceil(total / itemsPerPage),
                currentPage,
                itemsPerPage,
            };
        },
        [
            activeTab,
            artistsQuery.data,
            albumsQuery.data,
            tracksQuery.data,
            itemsPerPage,
            currentPage,
        ],
    );

    // Reload data function using React Query invalidation
    const reloadData = useCallback(async () => {
        if (activeTab === "artists") {
            await queryClient.invalidateQueries({
                queryKey: ["library", "artists"],
            });
        } else if (activeTab === "albums") {
            await queryClient.invalidateQueries({
                queryKey: ["library", "albums"],
            });
        } else {
            await queryClient.invalidateQueries({
                queryKey: ["library", "tracks"],
            });
        }
    }, [activeTab, queryClient]);

    const {
        playArtist,
        playAlbum,
        addTrackToQueue,
        addTrackToPlaylist,
        deleteArtist,
        deleteAlbum,
        deleteTrack,
    } = useLibraryActions();

    // Monotonic key that increments on tab/filter/sort change to remount grids
    // and replay staggered entrance animations.
    //
    // Declared above the effects that call setGridKey, not below them. Both
    // orders run correctly -- an effect body executes long after the whole
    // component function has, so the binding is initialised by then -- but
    // reading a `const` from a line above its declaration puts the reference in
    // the temporal dead zone as written, which the React Compiler flags and a
    // future refactor could turn into a real ReferenceError.
    const [gridKey, setGridKey] = useState(0);

    // Reset page and filter when tab changes
    useEffect(() => {
        setCurrentPage(1);
        // Reset filter to 'owned' when switching to tracks tab (which doesn't support filter)
        if (activeTab === "tracks") {
            setFilter("owned");
        }
        setGridKey((k) => k + 1);
    }, [activeTab]);

    useEffect(() => {
        setCurrentPage(1);
        setGridKey((k) => k + 1);
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
    const changeTab = useCallback(
        (tab: Tab) => {
            router.push(`/collection?tab=${tab}`, { scroll: false });
        },
        [router],
    );

    // Update page with URL state - scroll handled by useEffect on currentPage change
    const updatePage = useCallback(
        (page: number) => {
            const params = new URLSearchParams();
            params.set("tab", activeTab);
            params.set("page", String(page));
            router.push(`/collection?${params.toString()}`, { scroll: false });
        },
        [activeTab, router],
    );

    // Helper to convert library Track to audio context Track format
    const formatTracksForAudio = useCallback((libraryTracks: typeof tracks) => {
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
    }, []);

    // Wrapper for playTracks that converts track format
    const handlePlayTracks = useCallback(
        (libraryTracks: typeof tracks, startIndex?: number) => {
            const formattedTracks = formatTracksForAudio(libraryTracks);
            playTracks(formattedTracks, startIndex);
        },
        [formatTracksForAudio, playTracks],
    );

    // Shuffle entire library - uses server-side shuffle for large libraries
    const handleShuffleLibrary = useCallback(async () => {
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
    }, [formatTracksForAudio, playTracks]);

    // Handle delete confirmation
    const handleDelete = useCallback(async () => {
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
    }, [deleteConfirm, deleteArtist, deleteAlbum, deleteTrack, reloadData]);

    // Memoize delete handlers to prevent grid re-renders
    const handleDeleteArtist = useCallback((id: string, name: string) => {
        setDeleteConfirm({
            isOpen: true,
            type: "artist",
            id,
            title: name,
        });
    }, []);

    const handleDeleteAlbum = useCallback((id: string, title: string) => {
        setDeleteConfirm({
            isOpen: true,
            type: "album",
            id,
            title,
        });
    }, []);

    const handleDeleteTrack = useCallback((id: string, title: string) => {
        setDeleteConfirm({
            isOpen: true,
            type: "track",
            id,
            title,
        });
    }, []);

    return (
        <div className="min-h-screen relative bg-gradient-to-b from-[#0a0a0a] to-black">
            <LibraryHeader totalItems={totalItems} activeTab={activeTab} />

            <div className="relative px-4 md:px-8 pb-24 max-w-[1800px] mx-auto">
                <div className="mb-6 -mt-4">
                    <LibraryTabs
                        activeTab={activeTab}
                        onTabChange={changeTab}
                    />
                </div>

                {/* Toolbar */}
                <div className="mb-8">
                    <LibraryToolbar
                        activeTab={activeTab}
                        filter={filter}
                        sortBy={sortBy}
                        itemsPerPage={itemsPerPage}
                        onFilterChange={setFilter}
                        onSortChange={setSortBy}
                        onItemsPerPageChange={setItemsPerPage}
                        onShuffleLibrary={handleShuffleLibrary}
                    />
                </div>

                {activeTab === "artists" && (
                    <ArtistsGrid
                        key={gridKey}
                        artists={artists}
                        isLoading={isLoading}
                        onPlay={playArtist}
                        onDelete={handleDeleteArtist}
                        gridKey={gridKey}
                    />
                )}

                {activeTab === "albums" && (
                    <AlbumsGrid
                        key={gridKey}
                        albums={albums}
                        isLoading={isLoading}
                        onPlay={playAlbum}
                        onDelete={handleDeleteAlbum}
                        gridKey={gridKey}
                    />
                )}

                {activeTab === "tracks" && (
                    <TracksList
                        key={gridKey}
                        tracks={tracks}
                        isLoading={isLoading}
                        onPlay={handlePlayTracks}
                        onAddToQueue={addTrackToQueue}
                        onAddToPlaylist={addTrackToPlaylist}
                        onDelete={handleDeleteTrack}
                        gridKey={gridKey}
                    />
                )}

                <Pagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onPageChange={updatePage}
                    disabled={isLoading}
                    label={
                        activeTab === "artists" ? "Artists"
                        : activeTab === "albums" ? "Albums"
                        : "Tracks"
                    }
                />

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
                        deleteConfirm.type === "artist" ? "Artist"
                        : deleteConfirm.type === "album" ? "Album"
                        : "Track"
                    }?`}
                    message={
                        deleteConfirm.type === "track" ?
                            `Are you sure you want to delete "${deleteConfirm.title}"? This will permanently delete the file from your system.`
                        : deleteConfirm.type === "album" ?
                            `Are you sure you want to delete "${deleteConfirm.title}"? This will permanently delete all tracks and files from your system.`
                        :   `Are you sure you want to delete "${deleteConfirm.title}"? This will permanently delete all albums, tracks, and files from your system.`

                    }
                    confirmText="Delete"
                    cancelText="Cancel"
                    variant="danger"
                />
            </div>
        </div>
    );
}
