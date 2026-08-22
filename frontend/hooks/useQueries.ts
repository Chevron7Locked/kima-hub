/**
 * React Query Hooks for API Caching
 *
 * This file provides custom React Query hooks for the most frequently called APIs
 * in the music streaming app. These hooks implement smart caching strategies to:
 * - Reduce unnecessary API calls
 * - Improve perceived performance
 * - Provide automatic background refetching
 * - Handle loading and error states consistently
 *
 * Stale time configuration rationale:
 * - Artist data: 10 minutes (rarely changes)
 * - Album data: 10 minutes (rarely changes)
 * - Library/Home data: 2 minutes (may change as user adds music)
 * - Search results: 5 minutes (relatively static for same query)
 * - Playlists: 1 minute (user may be actively modifying)
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const queryKeys = {
    // Artist queries
    artist: (id: string) => ["artist", id] as const,

    // Album queries
    album: (id: string) => ["album", id] as const,
    albums: (filters?: Record<string, unknown>) => ["albums", filters] as const,

    // Library queries
    library: () => ["library"] as const,
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

    // Recommendations
    recommendations: (limit?: number) => ["recommendations", limit] as const,
    similarArtists: (seedArtistId: string, limit?: number) =>
        ["recommendations", "artists", seedArtistId, limit] as const,
    similarAlbums: (seedAlbumId: string, limit?: number) =>
        ["recommendations", "albums", seedAlbumId, limit] as const,

    // Search
    search: (query: string, type?: string, limit?: number) =>
        ["search", query, type, limit] as const,
    discoverSearch: (query: string, type?: string, limit?: number) =>
        ["search", "discover", query, type, limit] as const,
    discoverSimilar: (artist: string, mbid: string) =>
        ["search", "discover", "similar", artist, mbid] as const,

    // Playlists
    playlists: () => ["playlists"] as const,
    playlist: (id: string) => ["playlist", id] as const,

    // Mixes
    mixes: () => ["mixes"] as const,
    mix: (id: string) => ["mix", id] as const,

    // Popular artists
    popularArtists: (limit?: number) => ["popular-artists", limit] as const,

    // Audiobooks
    audiobooks: () => ["audiobooks"] as const,
    audiobook: (id: string) => ["audiobook", id] as const,

    // Podcasts
    podcasts: () => ["podcasts"] as const,
    podcast: (id: string) => ["podcast", id] as const,
    topPodcasts: (limit?: number, genreId?: number) =>
        ["podcasts", "top", limit, genreId] as const,

    // Browse (Deezer playlists/radios)
    browseAll: () => ["browse", "all"] as const,

    // Library radio data
    libraryGenres: () => ["library", "genres"] as const,
    libraryDecades: () => ["library", "decades"] as const,
};

/**
 * Hook to fetch artist data with automatic library/discovery fallback
 *
 * Tries library first, falls back to discovery if not found.
 * Cache time: 10 minutes (artist data rarely changes)
 *
 * @param id - Artist ID or MusicBrainz ID
 * @returns Query result with artist data
 *
 * @example
 * const { data: artist, isLoading, error } = useArtistQuery("artist-123");
 */
export function useArtistQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.artist(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Artist ID is required");

            // Try library first
            try {
                return await api.getArtist(id);
            } catch {
                // Fallback to discovery
                return await api.getArtistDiscovery(id);
            }
        },
        enabled: !!id,
        staleTime: 10 * 60 * 1000, // 10 minutes
        retry: 1,
    });
}

/**
 * Hook to fetch album data with automatic library/discovery fallback
 *
 * Cache time: 10 minutes (album data rarely changes)
 *
 * @param id - Album ID or Release Group MBID
 * @returns Query result with album data
 *
 * @example
 * const { data: album, isLoading, error } = useAlbumQuery("album-123");
 */
export function useAlbumQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.album(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Album ID is required");

            // Try library first
            try {
                return await api.getAlbum(id);
            } catch {
                // Fallback to discovery
                return await api.getAlbumDiscovery(id);
            }
        },
        enabled: !!id,
        staleTime: 10 * 60 * 1000, // 10 minutes
        retry: 1,
    });
}

/**
 * Hook to fetch albums list with optional filters
 *
 * @param params - Filter parameters (artistId, limit, offset)
 * @returns Query result with albums array
 *
 * @example
 * const { data } = useAlbumsQuery({ artistId: "123", limit: 20 });
 */
export function useAlbumsQuery(params?: {
    artistId?: string;
    limit?: number;
    offset?: number;
}) {
    return useQuery({
        queryKey: queryKeys.albums(params),
        queryFn: () => api.getAlbums(params),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

/**
 * Hook to fetch recently listened items (Continue Listening)
 *
 * Cache time: 2 minutes (may change frequently)
 *
 * @param limit - Number of items to fetch (default: 10)
 * @returns Query result with recently listened items
 *
 * @example
 * const { data } = useRecentlyListenedQuery(10);
 */
export function useRecentlyListenedQuery(limit: number = 10) {
    return useQuery({
        queryKey: queryKeys.recentlyListened(limit),
        queryFn: () => api.getRecentlyListened(limit),
        staleTime: 2 * 60 * 1000, // 2 minutes
    });
}

/**
 * Hook to fetch recently added artists
 *
 * Cache time: 2 minutes (may change as user adds music)
 *
 * @param limit - Number of items to fetch (default: 10)
 * @returns Query result with recently added artists
 *
 * @example
 * const { data } = useRecentlyAddedQuery(10);
 */
export function useRecentlyAddedQuery(limit: number = 10) {
    return useQuery({
        queryKey: queryKeys.recentlyAdded(limit),
        queryFn: () => api.getRecentlyAdded(limit),
        staleTime: 2 * 60 * 1000, // 2 minutes
    });
}

export type LibraryFilter = "owned" | "discovery" | "all";
export type SortOption = "name" | "name-desc" | "recent" | "tracks";

interface LibraryArtistsParams {
    filter?: LibraryFilter;
    sortBy?: SortOption;
    limit?: number;
    page?: number;
    enabled?: boolean;
}

interface LibraryAlbumsParams {
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

/**
 * Hook to fetch library artists with pagination and filtering
 *
 * Cache time: 2 minutes (may change as user adds music)
 */
export function useLibraryArtistsQuery({
    filter = "owned",
    sortBy = "name",
    limit = 40,
    page = 1,
    enabled = true,
}: LibraryArtistsParams = {}) {
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
        // Add structural sharing to prevent unnecessary re-renders
        structuralSharing: true,
        // Use placeholder data for better perceived performance
        placeholderData: (previousData) => previousData,
    });
}

/**
 * Hook to fetch library albums with pagination and filtering
 *
 * Cache time: 2 minutes (may change as user adds music)
 */
export function useLibraryAlbumsQuery({
    filter = "owned",
    sortBy = "name",
    limit = 40,
    page = 1,
    enabled = true,
}: LibraryAlbumsParams = {}) {
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
    });
}

/**
 * Hook to fetch library tracks with pagination
 *
 * Cache time: 2 minutes (may change as user adds music)
 */
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
    });
}

/**
 * Hook to fetch personalized recommendations
 *
 * Cache time: 5 minutes
 *
 * @param limit - Number of recommendations (default: 10)
 * @returns Query result with recommended artists
 *
 * @example
 * const { data } = useRecommendationsQuery(10);
 */
export function useRecommendationsQuery(limit: number = 10) {
    return useQuery({
        queryKey: queryKeys.recommendations(limit),
        queryFn: () => api.getRecommendationsForYou(limit),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

/**
 * Hook to fetch similar artists based on a seed artist
 *
 * @param seedArtistId - Artist ID to find similar artists for
 * @param limit - Number of recommendations (default: 20)
 * @returns Query result with similar artists
 *
 * @example
 * const { data } = useSimilarArtistsQuery("artist-123", 20);
 */
export function useSimilarArtistsQuery(
    seedArtistId: string | undefined,
    limit: number = 20,
) {
    return useQuery({
        queryKey: queryKeys.similarArtists(seedArtistId || "", limit),
        queryFn: async () => {
            if (!seedArtistId) throw new Error("Seed artist ID is required");
            return await api.getSimilarArtists(seedArtistId, limit);
        },
        enabled: !!seedArtistId,
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}

/**
 * Hook to fetch similar albums based on a seed album
 *
 * @param seedAlbumId - Album ID to find similar albums for
 * @param limit - Number of recommendations (default: 20)
 * @returns Query result with similar albums
 */
export function useSimilarAlbumsQuery(
    seedAlbumId: string | undefined,
    limit: number = 20,
) {
    return useQuery({
        queryKey: queryKeys.similarAlbums(seedAlbumId || "", limit),
        queryFn: async () => {
            if (!seedAlbumId) throw new Error("Seed album ID is required");
            return await api.getSimilarAlbums(seedAlbumId, limit);
        },
        enabled: !!seedAlbumId,
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}

/**
 * Hook to search library with debouncing
 *
 * Cache time: 5 minutes (search results are relatively static)
 *
 * @param query - Search query string
 * @param type - Type filter (all, artists, albums, tracks, audiobooks, podcasts)
 * @param limit - Number of results per type (default: 20)
 * @returns Query result with search results
 *
 * @example
 * const { data } = useSearchQuery("radiohead", "all", 20);
 */
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

/**
 * Hook to search discovery/Last.fm with debouncing
 *
 * @param query - Search query string
 * @param type - Type filter (music, podcasts, all)
 * @param limit - Number of results (default: 20)
 * @returns Query result with discovery search results
 *
 * @example
 * const { data } = useDiscoverSearchQuery("radiohead", "music", 20);
 */
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

/**
 * Hook to fetch musically similar artists for a given artist.
 * Fires only when artistName is non-empty (i.e. after discover results load).
 */
export function useDiscoverSimilarArtistsQuery(artistName: string, mbid: string = "") {
    return useQuery({
        queryKey: queryKeys.discoverSimilar(artistName, mbid),
        queryFn: ({ signal }) => api.discoverSimilarArtists(artistName, mbid, signal),
        enabled: artistName.length > 0,
        staleTime: 30 * 60 * 1000, // 30 minutes -- similar artists rarely change
    });
}

/**
 * Hook to fetch all playlists
 *
 * Cache time: 1 minute (playlists may be actively modified)
 *
 * @returns Query result with playlists array
 *
 * @example
 * const { data: playlists } = usePlaylistsQuery();
 */
export function usePlaylistsQuery() {
    return useQuery({
        queryKey: queryKeys.playlists(),
        queryFn: () => api.getPlaylists(),
        staleTime: 1 * 60 * 1000, // 1 minute
    });
}

/**
 * Hook to fetch a single playlist
 *
 * @param id - Playlist ID
 * @returns Query result with playlist data
 *
 * @example
 * const { data: playlist } = usePlaylistQuery("playlist-123");
 */
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

/**
 * Hook to fetch all mixes (Made For You)
 *
 * Cache time: 5 minutes
 *
 * @returns Query result with mixes array
 *
 * @example
 * const { data: mixes } = useMixesQuery();
 */
export function useMixesQuery() {
    return useQuery({
        queryKey: queryKeys.mixes(),
        queryFn: () => api.getMixes(),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

/**
 * Hook to fetch a single mix
 *
 * @param id - Mix ID
 * @returns Query result with mix data
 */
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

/**
 * Hook to fetch popular artists from Last.fm
 *
 * Cache time: 10 minutes (popular charts don't change frequently)
 *
 * @param limit - Number of artists to fetch (default: 20)
 * @returns Query result with popular artists
 *
 * @example
 * const { data } = usePopularArtistsQuery(20);
 */
export function usePopularArtistsQuery(limit: number = 20) {
    return useQuery({
        queryKey: queryKeys.popularArtists(limit),
        queryFn: () => api.getPopularArtists(limit),
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}

/**
 * Hook to fetch all audiobooks
 *
 * @returns Query result with audiobooks array
 */
export function useAudiobooksQuery() {
    return useQuery({
        queryKey: queryKeys.audiobooks(),
        queryFn: () => api.getAudiobooks(),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

/**
 * Hook to fetch a single audiobook
 *
 * @param id - Audiobook ID
 * @returns Query result with audiobook data
 */
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

/**
 * Hook to fetch all subscribed podcasts
 *
 * @returns Query result with podcasts array
 */
export function usePodcastsQuery() {
    return useQuery({
        queryKey: queryKeys.podcasts(),
        queryFn: () => api.getPodcasts(),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

/**
 * Hook to fetch a single podcast
 *
 * Returns null if podcast is not found (404), allowing the page to handle preview mode.
 *
 * @param id - Podcast ID
 * @returns Query result with podcast data
 */
export function usePodcastQuery(id: string | undefined) {
    // Numeric IDs are iTunes IDs, not database CUIDs - skip subscription lookup
    const isItunesId = !!id && /^\d+$/.test(id);
    return useQuery({
        queryKey: queryKeys.podcast(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Podcast ID is required");
            if (isItunesId) return null; // iTunes ID - go straight to preview mode

            try {
                return await api.getPodcast(id);
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
        enabled: !!id,
        staleTime: 5 * 60 * 1000, // 5 minutes
        retry: false, // Don't retry 404 errors
    });
}

/**
 * Hook to fetch top podcasts
 *
 * @param limit - Number of podcasts (default: 20)
 * @param genreId - Optional genre ID filter
 * @returns Query result with top podcasts
 */
export function useTopPodcastsQuery(limit: number = 20, genreId?: number) {
    return useQuery({
        queryKey: queryKeys.topPodcasts(limit, genreId),
        queryFn: () => api.getTopPodcasts(limit, genreId),
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}

/**
 * Hook to refresh mixes with cache invalidation
 *
 * @returns Mutation object with mutate function
 *
 * @example
 * const { mutate: refreshMixes, isPending } = useRefreshMixesMutation();
 * refreshMixes();
 */
export function useRefreshMixesMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => api.refreshMixes(),
        onSuccess: () => {
            // Invalidate mixes query to refetch
            queryClient.invalidateQueries({ queryKey: queryKeys.mixes() });
        },
    });
}

/**
 * Hook to add track to playlist with cache invalidation
 *
 * @returns Mutation object with mutate function
 *
 * @example
 * const { mutate: addToPlaylist } = useAddToPlaylistMutation();
 * addToPlaylist({ playlistId: "123", trackId: "456" });
 */
export function useAddToPlaylistMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        // Accepts a single trackId or many. Callers building a playlist from a
        // mix used to loop this hook once per track, which is one HTTP request
        // each; pass trackIds instead and it is one request.
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
        onSettled: (_, __, variables) => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlist(variables.playlistId),
            });
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
        },
    });
}

/**
 * Hook to create a new playlist with cache invalidation
 *
 * @returns Mutation object with mutate function
 *
 * @example
 * const { mutate: createPlaylist } = useCreatePlaylistMutation();
 * createPlaylist({ name: "My Playlist", isPublic: false });
 */
export function useCreatePlaylistMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            name,
            isPublic,
        }: {
            name: string;
            isPublic?: boolean;
        }) => api.createPlaylist(name, isPublic),
        onSuccess: () => {
            // Invalidate playlists list to show new playlist
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
        },
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
        onMutate: async (variables) => {
            await queryClient.cancelQueries({ queryKey: queryKeys.playlist(variables.playlistId) });
            const previous = queryClient.getQueryData(queryKeys.playlist(variables.playlistId));
            queryClient.setQueryData(queryKeys.playlist(variables.playlistId), (old: Record<string, unknown> | undefined) => {
                if (!old || !Array.isArray(old.items)) return old;
                return {
                    ...old,
                    items: (old.items as Array<{ track?: { id?: string } }>).filter(
                        (item) => item.track?.id !== variables.trackId
                    ),
                };
            });
            return { previous };
        },
        onError: (_err, variables, context) => {
            if (context?.previous) {
                queryClient.setQueryData(queryKeys.playlist(variables.playlistId), context.previous);
            }
        },
        onSettled: (_, __, variables) => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlist(variables.playlistId),
            });
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
        },
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
        onSuccess: (_, variables) => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlist(variables.playlistId),
            });
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
        },
    });
}

export function useDeletePlaylistMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (playlistId: string) => api.deletePlaylist(playlistId),
        onSuccess: () => {
            // Invalidate playlists list
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
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
        onMutate: async (variables) => {
            await queryClient.cancelQueries({ queryKey: queryKeys.playlist(variables.playlistId) });
            const previous = queryClient.getQueryData(queryKeys.playlist(variables.playlistId));
            queryClient.setQueryData(queryKeys.playlist(variables.playlistId), (old: Record<string, unknown> | undefined) => {
                if (!old || !Array.isArray(old.items)) return old;
                const items = old.items as Array<Record<string, unknown>>;
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
            });
            return { previous };
        },
        onError: (_err, variables, context) => {
            if (context?.previous) {
                queryClient.setQueryData(queryKeys.playlist(variables.playlistId), context.previous);
            }
        },
        onSettled: (_, __, variables) => {
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlist(variables.playlistId),
            });
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
        },
    });
}

interface PlaylistPreview {
    id: string;
    source: string;
    type: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}

interface Genre {
    id: number;
    name: string;
    picture?: string;
}

interface BrowseAllResponse {
    playlists: PlaylistPreview[];
    radios: PlaylistPreview[];
    genres: Genre[];
}

/**
 * Hook to fetch all browse content (playlists, radios, genres) from Deezer
 *
 * @returns Query result with all browse content
 */
export function useBrowseAllQuery() {
    return useQuery({
        queryKey: queryKeys.browseAll(),
        queryFn: async (): Promise<BrowseAllResponse> => {
            return api.get<BrowseAllResponse>("/browse/all");
        },
        staleTime: 10 * 60 * 1000, // 10 minutes - playlists don't change often
    });
}

/**
 * Hook to fetch library genre counts for radio stations
 */
export function useLibraryGenresQuery() {
    return useQuery({
        queryKey: queryKeys.libraryGenres(),
        queryFn: async () => {
            return api.get<{ genres: Array<{ genre: string; count: number }> }>("/library/genres");
        },
        staleTime: 10 * 60 * 1000,
    });
}

/**
 * Hook to fetch library decade counts for radio stations
 */
export function useLibraryDecadesQuery() {
    return useQuery({
        queryKey: queryKeys.libraryDecades(),
        queryFn: async () => {
            return api.get<{ decades: Array<{ decade: number; count: number }> }>("/library/decades");
        },
        staleTime: 10 * 60 * 1000,
    });
}
