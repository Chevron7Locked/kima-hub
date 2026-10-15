/** Loads every Home section and refreshes the mixes. */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { notify } from "@/lib/notify";
import type {
    Artist,
    ListenedItem,
    Audiobook,
    Mix,
    PopularArtist,
    PlaylistPreview,
} from "../types";
import type { DiscoveryPodcast } from "@/features/podcast/types";
import {
    useRecentlyListenedQuery,
    useRecentlyAddedQuery,
    useRecommendationsQuery,
    useMixesQuery,
    usePopularArtistsQuery,
    usePodcastChartQuery,
    useAudiobooksQuery,
    useRefreshMixesMutation,
    useBrowseAllQuery,
    queryKeys,
} from "@/hooks/useQueries";

export interface UseHomeDataReturn {
    // Data sections
    recentlyListened: ListenedItem[];
    recentlyAdded: Artist[];
    recommended: Artist[];
    mixes: Mix[];
    popularArtists: PopularArtist[];
    popularPodcasts: DiscoveryPodcast[];
    recentAudiobooks: Audiobook[];
    featuredPlaylists: PlaylistPreview[];

    // Loading states
    isLoading: boolean;
    isRefreshingMixes: boolean;
    isBrowseLoading: boolean;

    // Actions
    handleRefreshMixes: () => Promise<void>;
}

/** Every Home section: continue listening, recently added, recommended, mixes, popular, podcasts, audiobooks. */
export function useHomeData(): UseHomeDataReturn {
    const { isAuthenticated } = useAuth();
    const queryClient = useQueryClient();

    // Listen for mixes-updated event (fired when user saves mood preferences)
    // Use refetchQueries instead of invalidateQueries to force immediate UI update
    useEffect(() => {
        const handleMixesUpdated = () => {
            // refetchQueries forces immediate refetch, unlike invalidateQueries which only marks stale
            queryClient.refetchQueries({ queryKey: queryKeys.mixes() });
        };

        window.addEventListener("mixes-updated", handleMixesUpdated);
        return () =>
            window.removeEventListener("mixes-updated", handleMixesUpdated);
    }, [queryClient]);

    // React Query hooks - these automatically handle caching, refetching, and loading states
    const { data: recentlyListenedData, isLoading: isLoadingListened } =
        useRecentlyListenedQuery(10);
    const { data: recentlyAddedData, isLoading: isLoadingAdded } =
        useRecentlyAddedQuery(10);
    const { data: recommendedData, isLoading: isLoadingRecommended } =
        useRecommendationsQuery(10);
    const { data: mixesData, isLoading: isLoadingMixes } = useMixesQuery();
    const { data: popularData, isLoading: isLoadingPopular } =
        usePopularArtistsQuery(20);
    const { data: podcastsData, isLoading: isLoadingPodcasts } =
        usePodcastChartQuery(null, 10);
    const { data: audiobooksData, isLoading: isLoadingAudiobooks } =
        useAudiobooksQuery();
    const { data: browseData, isLoading: isBrowseLoading } =
        useBrowseAllQuery();

    const { mutateAsync: refreshMixes, isPending: isRefreshingMixes } =
        useRefreshMixesMutation();

    /**
     * Refresh mixes and update cache
     */
    const handleRefreshMixes = async () => {
        try {
            await refreshMixes();
        } catch (error) {
            console.error("Failed to refresh mixes:", error);
            notify.error("Failed to refresh mixes");
        }
    };

    // Process recently listened data - can contain artists, podcasts, or audiobooks
    const items = recentlyListenedData?.items || [];

    // Calculate overall loading state - true if any query is loading
    const isLoading =
        !isAuthenticated ||
        isLoadingListened ||
        isLoadingAdded ||
        isLoadingRecommended ||
        isLoadingMixes ||
        isLoadingPopular ||
        isLoadingPodcasts ||
        isLoadingAudiobooks;

    return {
        recentlyListened: items,
        recentlyAdded: recentlyAddedData?.artists || [],
        recommended: recommendedData?.artists || [],
        mixes: Array.isArray(mixesData) ? mixesData : [],
        popularArtists: popularData?.artists || [],
        popularPodcasts: Array.isArray(podcastsData)
            ? podcastsData.slice(0, 10)
            : [],
        recentAudiobooks: Array.isArray(audiobooksData)
            ? audiobooksData.slice(0, 10)
            : [],
        featuredPlaylists: browseData?.playlists || [],
        isLoading,
        isRefreshingMixes,
        isBrowseLoading,
        handleRefreshMixes,
    };
}
