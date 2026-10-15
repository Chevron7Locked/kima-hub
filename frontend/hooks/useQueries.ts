/**
 * TanStack Query hooks for the most-used endpoints. Stale times follow how
 * often the data changes: artists/albums 10m, search/mixes 5m, library and
 * home 2m, playlists 1m.
 */

import { useMemo } from "react";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { PlaylistPreview } from "@/features/home/types";

export const queryKeys = {
    artist: (id: string) => ["artist", id] as const,

    album: (id: string) => ["album", id] as const,
    libraryArtists: (params: {
        filter?: string;
        sortBy?: string;
        limit?: number;
        offset?: number;
    }) => ["library", "artists", params] as const,
    libraryAlbums: (params: {
        filter?: string;
        sortBy?: string;
        limit?: number;
        offset?: number;
    }) => ["library", "albums", params] as const,
    libraryTracks: (params: {
        sortBy?: string;
        limit?: number;
        offset?: number;
    }) => ["library", "tracks", params] as const,
    recentlyListened: (limit?: number) =>
        ["library", "recently-listened", limit] as const,
    recentlyAdded: (limit?: number) =>
        ["library", "recently-added", limit] as const,

    recommendations: (limit?: number) => ["recommendations", limit] as const,
    search: (query: string, type?: string, limit?: number) =>
        ["search", query, type, limit] as const,
    discoverSearch: (query: string, type?: string, limit?: number) =>
        ["search", "discover", query, type, limit] as const,
    discoverSimilar: (artist: string, mbid: string) =>
        ["search", "discover", "similar", artist, mbid] as const,

    playlists: () => ["playlists"] as const,
    playlist: (id: string) => ["playlist", id] as const,

    mixes: () => ["mixes"] as const,
    mix: (id: string) => ["mix", id] as const,

    popularArtists: (limit?: number) => ["popular-artists", limit] as const,

    audiobooks: () => ["audiobooks"] as const,
    audiobook: (id: string) => ["audiobook", id] as const,

    podcasts: () => ["podcasts"] as const,
    podcast: (id: string) => ["podcast", id] as const,
    podcastEpisodes: (id: string, order: string) => ["podcast", id, order] as const,
    podcastsListening: () => ["podcasts", "listening"] as const,
    podcastsForYou: () => ["podcasts", "for-you"] as const,
    podcastCategories: () => ["podcasts", "categories"] as const,
    podcastChart: (category: number | null, limit: number) => ["podcasts", "chart", category ?? "all", limit] as const,
    podcastChartPages: (category: number | null) => ["podcasts", "chart", category ?? "all", "paged"] as const,

    // Browse (Deezer playlists)
    browseAll: () => ["browse", "all"] as const,

    // Library radio data
    libraryGenres: () => ["library", "genres"] as const,
    libraryDecades: () => ["library", "decades"] as const,
};

export function useRecentlyListenedQuery(limit: number = 10) {
    return useQuery({
        queryKey: queryKeys.recentlyListened(limit),
        queryFn: () => api.getRecentlyListened(limit),
        staleTime: 2 * 60 * 1000, // 2 minutes
    });
}

export function useRecentlyAddedQuery(limit: number = 10) {
    return useQuery({
        queryKey: queryKeys.recentlyAdded(limit),
        queryFn: () => api.getRecentlyAdded(limit),
        staleTime: 2 * 60 * 1000, // 2 minutes
    });
}

export type LibraryFilter = "owned" | "discovery" | "all";
export type SortOption = "name" | "name-desc" | "recent" | "tracks";

interface LibraryPageParams {
    filter?: LibraryFilter;
    sortBy?: SortOption;
    limit?: number;
    page?: number;
    enabled?: boolean;
}

interface LibraryTracksParams {
    sortBy?: SortOption;
    limit?: number;
    page?: number;
    enabled?: boolean;
}

export function useLibraryArtistsQuery({
    filter = "owned",
    sortBy = "name",
    limit = 40,
    page = 1,
    enabled = true,
}: LibraryPageParams = {}) {
    const offset = (page - 1) * limit;
    return useQuery({
        queryKey: queryKeys.libraryArtists({ filter, sortBy, limit, offset }),
        queryFn: () => api.getArtists({ limit, offset, filter, sortBy }),
        select: (response) => ({
            artists: response.artists,
            total: response.total,
            offset: response.offset,
            limit: response.limit,
        }),
        staleTime: 2 * 60 * 1000,
        enabled,
        structuralSharing: true,
        placeholderData: (previousData) => previousData,
    });
}

export function useLibraryAlbumsQuery({
    filter = "owned",
    sortBy = "name",
    limit = 40,
    page = 1,
    enabled = true,
}: LibraryPageParams = {}) {
    const offset = (page - 1) * limit;
    return useQuery({
        queryKey: queryKeys.libraryAlbums({ filter, sortBy, limit, offset }),
        queryFn: () => api.getAlbums({ limit, offset, filter, sortBy }),
        select: (response) => ({
            albums: response.albums,
            total: response.total,
            offset: response.offset,
            limit: response.limit,
        }),
        staleTime: 2 * 60 * 1000,
        enabled,
        // Use placeholder data for better perceived performance (keeps pagination buttons enabled during fetches)
        placeholderData: (previousData) => previousData,
    });
}

export function useLibraryTracksQuery({
    sortBy = "name",
    limit = 40,
    page = 1,
    enabled = true,
}: LibraryTracksParams = {}) {
    const offset = (page - 1) * limit;
    return useQuery({
        queryKey: queryKeys.libraryTracks({ sortBy, limit, offset }),
        queryFn: () => api.getTracks({ limit, offset, sortBy }),
        select: (response) => ({
            tracks: response.tracks,
            total: response.total,
            offset: response.offset,
            limit: response.limit,
        }),
        staleTime: 2 * 60 * 1000,
        enabled,
        // Use placeholder data for better perceived performance (keeps pagination buttons enabled during fetches)
        placeholderData: (previousData) => previousData,
    });
}

export function useRecommendationsQuery(limit: number = 10) {
    return useQuery({
        queryKey: queryKeys.recommendations(limit),
        queryFn: () => api.getRecommendationsForYou(limit),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

export function useSearchQuery(
    query: string,
    type:
        | "all"
        | "artists"
        | "albums"
        | "tracks"
        | "audiobooks"
        | "podcasts"
        | "episodes" = "all",
    limit: number = 20,
) {
    return useQuery({
        queryKey: queryKeys.search(query, type, limit),
        queryFn: ({ signal }) => api.search(query, type, limit, signal),
        enabled: query.length >= 2, // Only search if query is at least 2 characters
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

export function useDiscoverSearchQuery(
    query: string,
    type: "music" | "podcasts" | "all" = "music",
    limit: number = 20,
) {
    return useQuery({
        queryKey: queryKeys.discoverSearch(query, type, limit),
        queryFn: ({ signal }) => api.discoverSearch(query, type, limit, signal),
        enabled: query.length >= 2,
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

export function useDiscoverSimilarArtistsQuery(artistName: string, mbid: string = "") {
    return useQuery({
        queryKey: queryKeys.discoverSimilar(artistName, mbid),
        queryFn: ({ signal }) => api.discoverSimilarArtists(artistName, mbid, signal),
        enabled: artistName.length > 0,
        staleTime: 30 * 60 * 1000, // 30 minutes -- similar artists rarely change
    });
}

export function usePlaylistsQuery() {
    return useQuery({
        queryKey: queryKeys.playlists(),
        queryFn: () => api.getPlaylists(),
        staleTime: 1 * 60 * 1000, // 1 minute
    });
}

export function usePlaylistQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.playlist(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Playlist ID is required");
            return await api.getPlaylist(id);
        },
        enabled: !!id,
        staleTime: 1 * 60 * 1000, // 1 minute
    });
}

export function useMixesQuery() {
    return useQuery({
        queryKey: queryKeys.mixes(),
        queryFn: () => api.getMixes(),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

export function useMixQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.mix(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Mix ID is required");
            return await api.getMix(id);
        },
        enabled: !!id,
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

export function usePopularArtistsQuery(limit: number = 20) {
    return useQuery({
        queryKey: queryKeys.popularArtists(limit),
        queryFn: () => api.getPopularArtists(limit),
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}

export function useAudiobooksQuery() {
    return useQuery({
        queryKey: queryKeys.audiobooks(),
        queryFn: () => api.getAudiobooks(),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

export function useAudiobookQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.audiobook(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Audiobook ID is required");
            return await api.getAudiobook(id);
        },
        enabled: !!id,
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

export function usePodcastsQuery() {
    return useQuery({
        queryKey: queryKeys.podcasts(),
        queryFn: () => api.getPodcasts(),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

// The most episodes the server returns in one page.
const EPISODE_PAGE = 200;

/**
 * Resolves to null when the podcast is not subscribed (404), so the page can show
 * a preview. Episodes arrive a page at a time; `data.episodes` holds every page
 * loaded so far and `loadMore` fetches the next.
 */
export function usePodcastQuery(
    id: string | undefined,
    order: "newest" | "oldest" = "newest"
) {
    // Numeric IDs are iTunes IDs, not database CUIDs - skip subscription lookup
    const isItunesId = !!id && /^\d+$/.test(id);
    const query = useInfiniteQuery({
        // The order is part of the key: "oldest" must fetch a different page,
        // not just re-sort the newest one.
        queryKey: queryKeys.podcastEpisodes(id || "", order),
        queryFn: async ({ pageParam }) => {
            if (!id) throw new Error("Podcast ID is required");
            if (isItunesId) return null; // iTunes ID - go straight to preview mode

            try {
                return await api.getPodcast(id, { order, limit: EPISODE_PAGE, offset: pageParam });
            } catch (error) {
                // If podcast not found (404), return null to allow preview mode
                const err = error as { status?: number; message?: string };
                if (
                    err.status === 404 ||
                    err.message?.includes("not found") ||
                    err.message?.includes("not subscribed")
                ) {
                    return null;
                }
                // For other errors, throw to trigger error state
                throw error;
            }
        },
        initialPageParam: 0,
        getNextPageParam: (last, pages) => {
            const loaded = pages.reduce((n, page) => n + (page?.episodes.length ?? 0), 0);
            return last && loaded < (last.episodeTotal ?? 0) ? loaded : undefined;
        },
        enabled: !!id,
        staleTime: 5 * 60 * 1000, // 5 minutes
        retry: false, // Don't retry 404 errors
        // The other order of the same podcast keeps its page on screen meanwhile;
        // another podcast does not show this one's.
        placeholderData: (previousData, previousQuery) =>
            previousQuery?.queryKey[1] === id ? previousData : undefined,
    });

    // One object per set of pages, so effects keyed on it run when episodes
    // change, not on every render. An episode published between two page
    // reads would appear on both; it is kept once.
    const data = useMemo(() => {
        const first = query.data?.pages[0];
        if (!first) return first;
        const seen = new Set<string>();
        const episodes = query.data!.pages
            .flatMap((page) => page?.episodes ?? [])
            .filter((episode: { id: string }) => !seen.has(episode.id) && !!seen.add(episode.id));
        return { ...first, episodes };
    }, [query.data]);
    return {
        data,
        isLoading: query.isLoading,
        isPlaceholderData: query.isPlaceholderData,
        refetch: query.refetch,
        hasMore: query.hasNextPage,
        loadMore: query.fetchNextPage,
        loadingMore: query.isFetchingNextPage,
    };
}

/**
 * What any signed-in user may know about the server: its public address, and whether they may start downloads.
 * Until the server answers, downloads read as not allowed: the acquire routes are operator-only by default.
 */
export function usePublicConfig() {
    const { data } = useQuery({
        queryKey: ["system", "public-config"],
        queryFn: () => api.getPublicConfig(),
        staleTime: 5 * 60 * 1000,
    });
    return { publicUrl: data?.publicUrl ?? "", canAcquire: data?.canAcquire === true, loaded: data !== undefined };
}

/** Apple's chart for a category, or the overall chart for null. */
export function usePodcastChartQuery(category: number | null, limit: number, enabled = true) {
    return useQuery({
        queryKey: queryKeys.podcastChart(category, limit),
        queryFn: () => api.getPodcastChart(category, limit),
        enabled,
        staleTime: 60 * 60 * 1000,
    });
}

/** Apple's podcast categories, as the server names them. */
export function usePodcastCategoriesQuery(enabled = true) {
    return useQuery({
        queryKey: queryKeys.podcastCategories(),
        queryFn: () => api.getPodcastCategories(),
        enabled,
        staleTime: 60 * 60 * 1000,
    });
}

export function useRefreshMixesMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => api.refreshMixes(),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.mixes() });
        },
    });
}

type PlaylistCache = Record<string, unknown> | undefined;

function invalidatePlaylist(queryClient: QueryClient, playlistId: string) {
    queryClient.invalidateQueries({ queryKey: queryKeys.playlist(playlistId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
}

async function applyOptimisticPlaylistEdit(
    queryClient: QueryClient,
    playlistId: string,
    edit: (old: PlaylistCache) => PlaylistCache,
) {
    await queryClient.cancelQueries({ queryKey: queryKeys.playlist(playlistId) });
    const previous = queryClient.getQueryData(queryKeys.playlist(playlistId));
    queryClient.setQueryData(queryKeys.playlist(playlistId), edit);
    return { previous };
}

function rollbackPlaylistEdit(queryClient: QueryClient, playlistId: string, context: { previous: unknown } | undefined) {
    if (context?.previous) {
        queryClient.setQueryData(queryKeys.playlist(playlistId), context.previous);
    }
}

export function useAddToPlaylistMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        // Accepts a single trackId or many; pass trackIds to add a whole mix in
        // one request.
        mutationFn: ({
            playlistId,
            trackId,
            trackIds,
        }: {
            playlistId: string;
            trackId?: string;
            trackIds?: string[];
        }) =>
            trackIds?.length
                ? api.addTracksToPlaylist(playlistId, trackIds)
                : api.addTrackToPlaylist(playlistId, trackId!),
        onSettled: (_, __, variables) => invalidatePlaylist(queryClient, variables.playlistId),
    });
}

export function useRemoveFromPlaylistMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            playlistId,
            trackId,
        }: {
            playlistId: string;
            trackId: string;
        }) => api.removeTrackFromPlaylist(playlistId, trackId),
        onMutate: (variables) =>
            applyOptimisticPlaylistEdit(queryClient, variables.playlistId, (old) => {
                if (!old || !Array.isArray(old.items)) return old;
                return {
                    ...old,
                    items: (old.items as Array<{ track?: { id?: string } }>).filter(
                        (item) => item.track?.id !== variables.trackId
                    ),
                };
            }),
        onError: (_err, variables, context) => rollbackPlaylistEdit(queryClient, variables.playlistId, context),
        onSettled: (_, __, variables) => invalidatePlaylist(queryClient, variables.playlistId),
    });
}

export function useUpdatePlaylistMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            playlistId,
            data,
        }: {
            playlistId: string;
            data: { name?: string; isPublic?: boolean };
        }) => api.updatePlaylist(playlistId, data),
        onSuccess: (_, variables) => invalidatePlaylist(queryClient, variables.playlistId),
    });
}

export function useSetPlaylistReverseMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            playlistId,
            reverseOrder,
        }: {
            playlistId: string;
            reverseOrder: boolean;
        }) => api.updatePlaylistOrder(playlistId, reverseOrder),
        onMutate: ({ playlistId, reverseOrder }) =>
            applyOptimisticPlaylistEdit(queryClient, playlistId, (old) => {
                if (!old || !Array.isArray(old.items)) return old;
                return {
                    ...old,
                    reverseOrder,
                    items: [...(old.items as unknown[])].reverse(),
                    ...(Array.isArray(old.mergedItems) && {
                        mergedItems: [...(old.mergedItems as unknown[])].reverse(),
                    }),
                };
            }),
        onError: (_err, variables, context) => rollbackPlaylistEdit(queryClient, variables.playlistId, context),
        onSettled: (_, __, variables) => invalidatePlaylist(queryClient, variables.playlistId),
    });
}

export function useDeletePlaylistMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (playlistId: string) => api.deletePlaylist(playlistId),
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
        },
    });
}

/**
 * A playlist after moving `itemId` to just after `afterItemId` (the top for null), as the server will store it.
 * The ids are in stored order; a reversed playlist's cached items are in display order, so the move is made on the
 * stored order and the list shown reversed again. A copy: the cached list is also `previous`, restored on failure.
 */
export function movePlaylistItem<T extends PlaylistCache>(old: T, itemId: string, afterItemId: string | null): T {
    if (!old || !Array.isArray(old.items)) return old;
    const reversed = Boolean((old as { reverseOrder?: boolean }).reverseOrder);
    const items = [...(old.items as Array<Record<string, unknown>>)];
    if (reversed) items.reverse();
    const idx = items.findIndex((item) => item.id === itemId);
    if (idx === -1) return old;
    const [moved] = items.splice(idx, 1);
    if (afterItemId) {
        const afterIdx = items.findIndex((item) => item.id === afterItemId);
        items.splice(afterIdx !== -1 ? afterIdx + 1 : idx, 0, moved);
    } else {
        items.unshift(moved);
    }
    if (reversed) items.reverse();
    return { ...old, items };
}

export function useMoveTrackInPlaylistMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            playlistId,
            itemId,
            afterItemId,
        }: {
            playlistId: string;
            itemId: string;
            afterItemId: string | null;
        }) => api.moveTrackInPlaylist(playlistId, itemId, afterItemId),
        onMutate: (variables) =>
            applyOptimisticPlaylistEdit(queryClient, variables.playlistId, (old) =>
                movePlaylistItem(old, variables.itemId, variables.afterItemId),
            ),
        onError: (_err, variables, context) => rollbackPlaylistEdit(queryClient, variables.playlistId, context),
        onSettled: (_, __, variables) => invalidatePlaylist(queryClient, variables.playlistId),
    });
}

interface Genre {
    id: number;
    name: string;
    picture?: string;
}

interface BrowseAllResponse {
    playlists: PlaylistPreview[];
    genres: Genre[];
}

export function useBrowseAllQuery() {
    return useQuery({
        queryKey: queryKeys.browseAll(),
        queryFn: async (): Promise<BrowseAllResponse> => {
            return api.get<BrowseAllResponse>("/browse/all");
        },
        staleTime: 10 * 60 * 1000, // 10 minutes - playlists don't change often
    });
}

export function useLibraryGenresQuery() {
    return useQuery({
        queryKey: queryKeys.libraryGenres(),
        queryFn: async () => {
            return api.get<{ genres: Array<{ genre: string; count: number }> }>("/library/genres");
        },
        staleTime: 10 * 60 * 1000,
    });
}

export function useLibraryDecadesQuery() {
    return useQuery({
        queryKey: queryKeys.libraryDecades(),
        queryFn: async () => {
            return api.get<{ decades: Array<{ decade: number; count: number }> }>("/library/decades");
        },
        staleTime: 10 * 60 * 1000,
    });
}
