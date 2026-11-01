"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
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
import { notify } from "@/lib/notify";
import { useLibraryActions } from "@/features/library/hooks/useLibraryActions";
import { useAuth } from "@/lib/auth-context";
import { CollectionMasthead } from "@/features/library/components/CollectionMasthead";
import { useLibraryVibe } from "@/features/library/useLibraryVibe";
import { useShelfSummary } from "@/features/library/useShelfSummary";
import { LibraryTabs } from "@/features/library/components/LibraryTabs";
import { LibraryToolbar } from "@/features/library/components/LibraryToolbar";
import { LibraryGrid, albumCard, artistCard } from "@/features/library/components/LibraryGrid";
import { TracksList } from "@/features/library/components/TracksList";
import { DEFAULT_REFINE, PER_PAGE_OPTIONS, sortOptionsFor } from "@/features/library/components/RefinePanel";
import { Pagination } from "@/components/ui/Pagination";
import { latchTotal, parsePageParam } from "@/lib/pagination";
import { scrollMainToTop } from "@/lib/scroll";
import { stillRequested, viewToChange } from "@/lib/requested-views";

const FILTERS: LibraryFilter[] = ["owned", "discovery", "all"];

interface LibraryView {
    filter: LibraryFilter;
    sortBy: SortOption;
    itemsPerPage: number;
}
const DEFAULT_VIEW: LibraryView = DEFAULT_REFINE;

const sameView = (a: LibraryView, b: LibraryView) =>
    a.filter === b.filter && a.sortBy === b.sortBy && a.itemsPerPage === b.itemsPerPage;

/** The address carries tab, page, filter, sort and page size, so refresh and Back keep them; defaults are left out. */
function libraryUrl(tab: Tab, page: number, view: LibraryView): string {
    const params = new URLSearchParams();
    params.set("tab", tab);
    if (page > 1) params.set("page", String(page));
    if (view.filter !== DEFAULT_VIEW.filter) params.set("filter", view.filter);
    if (view.sortBy !== DEFAULT_VIEW.sortBy) params.set("sort", view.sortBy);
    if (view.itemsPerPage !== DEFAULT_VIEW.itemsPerPage) params.set("per", String(view.itemsPerPage));
    return `/collection?${params.toString()}`;
}

/** The address's value when it is one of the choices, else the default. */
function oneOf<T extends string | number>(raw: string | null, choices: readonly T[], fallback: T): T {
    return choices.find((choice) => String(choice) === raw) ?? fallback;
}

export default function LibraryPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { playTracks } = useAudioControls();

    // The masthead's mood band and heard line; both cache independently of the
    // tab pages and keep their last copy on failure.
    const vibe = useLibraryVibe();
    const shelf = useShelfSummary();

    const validTabs: Tab[] = ["artists", "albums", "tracks"];
    const tabParam = searchParams.get("tab");
    const activeTab: Tab = validTabs.includes(tabParam as Tab) ? (tabParam as Tab) : "artists";

    // Page lives in the URL and nowhere else. Reading it through
    // parsePageParam means a garbage ?page= never reaches the API, and the
    // pager math never sees NaN.
    const currentPage = parsePageParam(searchParams.get("page"));

    // Filter (owned = your library, discovery = discovery weekly artists), sort
    // and page size live in the URL too; the tracks tab shows owned tracks only.
    const filter: LibraryFilter =
        activeTab === "tracks" ? "owned" : oneOf(searchParams.get("filter"), FILTERS, DEFAULT_VIEW.filter);
    const sortBy = oneOf(
        searchParams.get("sort"),
        sortOptionsFor(activeTab).map((opt) => opt.value),
        DEFAULT_VIEW.sortBy,
    );
    const itemsPerPage = oneOf(searchParams.get("per"), PER_PAGE_OPTIONS, DEFAULT_VIEW.itemsPerPage);

    const shownPageRef = useRef(currentPage);

    // Last total seen per tab. A query that fails on its first load has no
    // data; the latch keeps the pager standing on the last real count instead
    // of recomputing the list down to zero pages.
    const [latchedTotals, setLatchedTotals] = useState<Partial<Record<Tab, number>>>({});

    const queryClient = useQueryClient();
    const { user } = useAuth();
    // Deleting library content is an admin action on the backend; the UI must
    // not offer it to anyone else.
    const isAdmin = user?.role === "admin";

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

    // The server returns this list already ordered by the article-stripped
    // `Artist.sortName`, across all pages. Do not re-sort here.
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
    const artistCards = useMemo(() => artists.map(artistCard), [artists]);
    const albumCards = useMemo(() => albums.map(albumCard), [albums]);

    const isLoading =
        (activeTab === "artists" && artistsQuery.isLoading) ||
        (activeTab === "albums" && albumsQuery.isLoading) ||
        (activeTab === "tracks" && tracksQuery.isLoading);

    // `fresh` is undefined while the query has no data (loading, or a failed
    // first load). The latch keeps the last real total, and totalPages is
    // floored at 1 so the pager never disappears.
    const fresh =
        activeTab === "artists" ? artistsQuery.data?.total
        : activeTab === "albums" ? albumsQuery.data?.total
        : tracksQuery.data?.total;
    const total = latchTotal(latchedTotals[activeTab] ?? 0, fresh);
    if (total !== (latchedTotals[activeTab] ?? 0)) {
        setLatchedTotals((prev) => ({ ...prev, [activeTab]: total }));
    }

    const activeQuery =
        activeTab === "artists" ? artistsQuery
        : activeTab === "albums" ? albumsQuery
        : tracksQuery;

    // The previous page stays on screen until the next one arrives, so the
    // jump to the top waits for the swap; scrolling on the click shows the
    // old page's top for the length of the request.
    const pageDataReady =
        activeQuery.data !== undefined && !activeQuery.isPlaceholderData;
    useLayoutEffect(() => {
        if (!pageDataReady || shownPageRef.current === currentPage) return;
        shownPageRef.current = currentPage;
        scrollMainToTop();
    }, [pageDataReady, currentPage]);

    const totalPages = Math.max(1, Math.ceil(total / itemsPerPage));

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
    } = useLibraryActions();

    // Increments on tab/filter/sort change to remount grids and replay the
    // entrance animation. Declared above the effects that set it.
    const [gridKey, setGridKey] = useState(0);

    // A tab switch pushes a page-less URL, so the page resets on its own; the
    // grid remounts to replay its entrance.
    const [shownTab, setShownTab] = useState(activeTab);
    if (shownTab !== activeTab) {
        setShownTab(activeTab);
        setGridKey((k) => k + 1);
    }

    // Changing filter/sort/page-size starts again at page 1 and remounts the
    // grid. Done in the handlers, so the URL changes only on user action.
    // Quick changes in a row build on each other, not on the last render (lib/requested-views.ts).
    const requested = useRef<LibraryView[]>([]);
    const rendered = useRef<LibraryView>({ filter, sortBy, itemsPerPage });
    useLayoutEffect(() => {
        const view = { filter, sortBy, itemsPerPage };
        rendered.current = view;
        requested.current = stillRequested(requested.current, view, sameView);
    }, [filter, sortBy, itemsPerPage]);
    useLayoutEffect(() => {
        requested.current = [];
    }, [activeTab]);
    const changeView = useCallback(
        (next: Partial<LibraryView>) => {
            const view = { ...viewToChange(requested.current, rendered.current), ...next };
            requested.current = [...requested.current, view];
            setGridKey((k) => k + 1);
            router.replace(libraryUrl(activeTab, 1, view), { scroll: false });
        },
        [activeTab, router],
    );
    const changeFilter = useCallback((next: LibraryFilter) => changeView({ filter: next }), [changeView]);
    const changeSort = useCallback((next: SortOption) => changeView({ sortBy: next }), [changeView]);
    const changeItemsPerPage = useCallback((next: number) => changeView({ itemsPerPage: next }), [changeView]);
    const resetView = useCallback(() => changeView(DEFAULT_VIEW), [changeView]);

    // A ?page= past the end is moved back to the last real page once a response
    // lands. The URL stays the single source of truth, so one empty frame shows.
    const outOfRange =
        !isLoading &&
        !activeQuery.isError &&
        activeQuery.data !== undefined &&
        currentPage > totalPages;
    useEffect(() => {
        if (outOfRange) {
            router.replace(libraryUrl(activeTab, totalPages, { filter, sortBy, itemsPerPage }), { scroll: false });
        }
    }, [outOfRange, activeTab, totalPages, filter, sortBy, itemsPerPage, router]);

    const [deleting, setDeleting] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState<DeleteDialogState>({
        isOpen: false,
        type: "track",
        id: "",
        title: "",
    });

    const changeTab = useCallback(
        (tab: Tab) => {
            // The tracks tab shows owned tracks only and starts the filter over;
            // a sort the next tab does not offer starts over too.
            const nextFilter = tab === "tracks" ? DEFAULT_VIEW.filter : filter;
            const nextSort = sortOptionsFor(tab).some((opt) => opt.value === sortBy) ? sortBy : DEFAULT_VIEW.sortBy;
            router.push(libraryUrl(tab, 1, { filter: nextFilter, sortBy: nextSort, itemsPerPage }), { scroll: false });
        },
        [filter, sortBy, itemsPerPage, router],
    );

    // Update page with URL state — the URL is the page's only storage.
    const updatePage = useCallback(
        (page: number) => {
            router.push(libraryUrl(activeTab, page, { filter, sortBy, itemsPerPage }), { scroll: false });
        },
        [activeTab, filter, sortBy, itemsPerPage, router],
    );

    // Helper to convert library Track to audio context Track format
    const formatTracksForAudio = useCallback((libraryTracks: typeof tracks) => {
        return libraryTracks.map((track) => ({
            id: track.id,
            title: track.title,
            displayTitle: track.displayTitle,
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

    const handlePlayTracks = useCallback(
        (libraryTracks: typeof tracks, startIndex?: number) => {
            const formattedTracks = formatTracksForAudio(libraryTracks);
            playTracks(formattedTracks, startIndex);
        },
        [formatTracksForAudio, playTracks],
    );

    // The server shuffles, so a large library is not fetched whole to shuffle here.
    const handleShuffleLibrary = useCallback(async () => {
        try {
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

    const closeDelete = useCallback(
        () => setDeleteConfirm({ isOpen: false, type: "track", id: "", title: "" }),
        [],
    );

    const handleDelete = useCallback(async () => {
        setDeleting(true);
        try {
            await api.deleteTrack(deleteConfirm.id);
        } catch (error) {
            console.error("Failed to delete track:", error);
            notify.error(`Could not delete track "${deleteConfirm.title}"`, {
                message: error instanceof Error ? error.message : undefined,
            });
            // The dialog stays open so it can be retried.
            setDeleting(false);
            return;
        }
        // The track disappearing is feedback enough; the dialog closes even if the refresh fails.
        try {
            await reloadData();
        } catch (error) {
            console.error("Failed to refresh after deleting a track:", error);
        } finally {
            setDeleting(false);
            closeDelete();
        }
    }, [deleteConfirm, reloadData, closeDelete]);

    const handleDeleteTrack = useCallback((id: string, title: string) => {
        setDeleteConfirm({
            isOpen: true,
            type: "track",
            id,
            title,
        });
    }, []);

    return (
        <div className="min-h-screen">
            <CollectionMasthead
                title="Collection"
                heardLine={shelf.heard}
                fallbackLine={`${total.toLocaleString()} ${activeTab === "artists" ? "artists" : activeTab === "albums" ? "albums" : "tracks"}`}
                shares={vibe.shares}
            />

            <div className="relative page-shell pb-24">
                {/* Tabs and refine controls share one line; on a TV each keeps a row of its own for the remote. */}
                <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 pb-4 border-b border-white/5">
                    <LibraryTabs
                        activeTab={activeTab}
                        onTabChange={changeTab}
                    />
                    <LibraryToolbar
                        activeTab={activeTab}
                        filter={filter}
                        sortBy={sortBy}
                        itemsPerPage={itemsPerPage}
                        onFilterChange={changeFilter}
                        onSortChange={changeSort}
                        onItemsPerPageChange={changeItemsPerPage}
                        onReset={resetView}
                        onShuffleLibrary={handleShuffleLibrary}
                    />
                </div>

                {/* The cards' titles are h3s; this names the list they sit in for screen readers. */}
                <h2 className="sr-only">{activeTab}</h2>

                <div
                    aria-busy={activeQuery.isPlaceholderData}
                    className={`transition-opacity duration-150 ${activeQuery.isPlaceholderData ? "opacity-50" : ""}`}
                >
                    {activeTab === "artists" && (
                        <LibraryGrid
                            key={gridKey}
                            kind="artist"
                            cards={artistCards}
                            isLoading={isLoading}
                            onPlay={playArtist}
                            moodByKey={vibe.artistMood}
                        />
                    )}

                    {activeTab === "albums" && (
                        <LibraryGrid
                            key={gridKey}
                            kind="album"
                            cards={albumCards}
                            isLoading={isLoading}
                            onPlay={playAlbum}
                            moodByKey={vibe.albumMood}
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
                            onDelete={isAdmin ? handleDeleteTrack : undefined}
                        />
                    )}
                </div>

                {activeQuery.isError && !isLoading && (
                    <div
                        role="status"
                        className="flex items-center justify-between gap-4 rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3 mb-6 -mt-6"
                    >
                        <p className="text-sm text-[var(--text-secondary)]">
                            Couldn&apos;t load this page.
                        </p>
                        <button
                            type="button"
                            onClick={() => void activeQuery.refetch()}
                            disabled={activeQuery.isFetching}
                            className="text-sm font-medium text-white underline underline-offset-4 hover:text-[var(--text-secondary)] disabled:opacity-50 whitespace-nowrap"
                        >
                            {activeQuery.isFetching ? "Retrying…" : "Retry"}
                        </button>
                    </div>
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
                    onClose={closeDelete}
                    onConfirm={() => void handleDelete()}
                    closeOnConfirm={false}
                    busy={deleting}
                    title="Delete Track?"
                    message={`Are you sure you want to delete "${deleteConfirm.title}"? This will permanently delete the file from your system.`}
                    confirmText="Delete"
                    cancelText="Cancel"
                    variant="danger"
                />
            </div>
        </div>
    );
}
