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
    topPodcasts: (limit?: number, genreId?: number) =>
        ["podcasts", "top", limit, genreId] as const,

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
        | "podcasts" = "all",
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
        queryKey: [...queryKeys.podcast(id || ""), order],
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

export function useTopPodcastsQuery(limit: number = 20, genreId?: number) {
    return useQuery({
        queryKey: queryKeys.topPodcasts(limit, genreId),
        queryFn: () => api.getTopPodcasts(limit, genreId),
        staleTime: 10 * 60 * 1000, // 10 minutes
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

// Custom playlist cover image (issue #151)
export function useUploadPlaylistCoverMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            playlistId,
            file,
        }: {
            playlistId: string;
            file: File;
        }) => api.uploadPlaylistCover(playlistId, file),
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
            invalidatePlaylist(queryClient, variables.playlistId);
        },
    });
}

export function useRemovePlaylistCoverMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (playlistId: string) => api.removePlaylistCover(playlistId),
        onSuccess: (_, playlistId) => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
            invalidatePlaylist(queryClient, playlistId);
        },
    });
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
            applyOptimisticPlaylistEdit(queryClient, variables.playlistId, (old) => {
                if (!old || !Array.isArray(old.items)) return old;
                // A copy: the cached list is also `previous`, restored if the move fails.
                const items = [...(old.items as Array<Record<string, unknown>>)];
                const idx = items.findIndex((item) => item.id === variables.itemId);
                if (idx === -1) return old;
                const [moved] = items.splice(idx, 1);
                if (variables.afterItemId) {
                    const afterIdx = items.findIndex((item) => item.id === variables.afterItemId);
                    if (afterIdx !== -1) {
                        items.splice(afterIdx + 1, 0, moved);
                    } else {
                        items.splice(idx, 0, moved);
                    }
                } else {
                    items.unshift(moved);
                }
                return { ...old, items };
            }),
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
