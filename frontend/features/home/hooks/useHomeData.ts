/** Loads every Home section and refreshes the mixes. Each section reports its own loading state. */

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
} from "@/hooks/useQueries";

export interface HomeSectionLoading {
    recentlyListened: boolean;
    recentlyAdded: boolean;
    recommended: boolean;
    mixes: boolean;
    popularArtists: boolean;
    popularPodcasts: boolean;
    recentAudiobooks: boolean;
}

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

    // Loading states: each Home section is waiting on its own request, never on the others.
    sectionLoading: HomeSectionLoading;
    isRefreshingMixes: boolean;
    isBrowseLoading: boolean;

    // Actions
    handleRefreshMixes: () => Promise<void>;
}

/** Every Home section: continue listening, recently added, recommended, mixes, popular, podcasts, audiobooks. */
export function useHomeData(): UseHomeDataReturn {
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

    const handleRefreshMixes = async () => {
        try {
            await refreshMixes();
        } catch {
            notify.error("Failed to refresh mixes");
        }
    };

    // Artists, podcasts and audiobooks, in the order they were last played.
    const items = recentlyListenedData?.items || [];

    const sectionLoading: HomeSectionLoading = {
        recentlyListened: isLoadingListened,
        recentlyAdded: isLoadingAdded,
        recommended: isLoadingRecommended,
        mixes: isLoadingMixes,
        popularArtists: isLoadingPopular,
        popularPodcasts: isLoadingPodcasts,
        recentAudiobooks: isLoadingAudiobooks,
    };

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
        sectionLoading,
        isRefreshingMixes,
        isBrowseLoading,
        handleRefreshMixes,
    };
}
