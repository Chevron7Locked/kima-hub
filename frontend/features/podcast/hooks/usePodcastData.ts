"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { queryKeys, usePodcastQuery } from "@/hooks/useQueries";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import type { Podcast, PodcastPreview, DiscoveryPodcast, Episode } from "../types";
import { subscribeQueryEvent } from "@/lib/query-events";

export function usePodcastData() {
  const params = useParams();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const podcastId = params.id as string;

  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(
        `kima_podcast_sort_order_${podcastId}`
      );
      return (saved as "newest" | "oldest") || "newest";
    }
    return "newest";
  });

  const {
    data: podcast,
    isLoading: isPodcastLoading,
    isPlaceholderData: episodesUpdating,
    refetch,
    hasMore,
    loadMore,
    loadingMore,
  } = usePodcastQuery(podcastId, sortOrder);

  // Playback saves progress every 15 s: the saved episode is updated in place
  // on every loaded page, with no request. A change that names no episode
  // reads the podcast again.
  const queryClient = useQueryClient();
  useEffect(() => {
    const unsubscribe = subscribeQueryEvent("podcast-progress-updated", (event) => {
      const { podcastId: savedFor, episodeId, progress } = event.detail as {
        podcastId?: string;
        episodeId?: string;
        progress?: Episode["progress"];
      };
      if (!episodeId || !progress) {
        refetch({ cancelRefetch: false });
        return;
      }
      if (savedFor !== podcastId) return;
      // Only the order on screen: patching the other would mark it fresh and
      // drop a refetch it still owes.
      queryClient.setQueryData<InfiniteData<Podcast | null>>(queryKeys.podcastEpisodes(podcastId, sortOrder), (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) =>
            page && { ...page, episodes: page.episodes.map((ep) => (ep.id === episodeId ? { ...ep, progress } : ep)) },
          ),
        },
      );
    });

    return unsubscribe;
  }, [refetch, queryClient, podcastId, sortOrder]);

  // A show not followed yet is read as a preview; similar shows load for both.
  const [previewData, setPreviewData] = useState<PodcastPreview | null>(null);
  const [previewLoadState, setPreviewLoadState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [similarPodcasts, setSimilarPodcasts] = useState<DiscoveryPodcast[]>([]);

  // Reset preview/error state when navigating between podcasts so a previous
  // page's error UI does not sticky-state into the next podcast's view.
  const [prevPodcastId, setPrevPodcastId] = useState(podcastId);
  if (prevPodcastId !== podcastId) {
    setPrevPodcastId(podcastId);
    setPreviewLoadState('idle');
    setPreviewError(null);
    setPreviewData(null);
    setSimilarPodcasts([]);
  }

  const rawCoverUrl = podcast?.coverUrl || previewData?.coverUrl;
  const heroImage = rawCoverUrl ? api.getCoverArtUrl(rawCoverUrl, 1200) : null;
  // Separate URL with token for color extraction (CORS access for canvas)
  const colorExtractionImage = rawCoverUrl ? api.getCoverArtUrl(rawCoverUrl, 300, true) : null;

  // A show's neighbours come from its categories' charts, worked out by the server for a followed show and a
  // previewed one alike.
  const previewItunesId = previewData?.itunesId ?? null;
  useEffect(() => {
    if (!isAuthenticated || (!podcast?.id && !previewItunesId)) return;

    let cancelled = false;

    async function loadSimilarPodcasts() {
      try {
        const similar = podcast?.id
          ? await api.getSimilarPodcasts(podcastId)
          : await api.getPreviewSimilarPodcasts(previewItunesId!);
        if (!cancelled) setSimilarPodcasts(similar);
      } catch (error) {
        if (!cancelled) console.error("Failed to load similar podcasts:", error);
      }
    }

    loadSimilarPodcasts();
    return () => { cancelled = true; };
  }, [podcast?.id, isAuthenticated, podcastId, previewItunesId]);
  const similarTitle = "more like this";

  // An unsubscribed podcast is shown from its directory preview instead.
  useEffect(() => {
    if (isPodcastLoading || podcast || !isAuthenticated) return;

    let cancelled = false;

    async function loadPreviewData() {
      setPreviewLoadState('loading');
      try {
        const preview = await api.previewPodcast(podcastId);
        if (cancelled) return;
        setPreviewData(preview);
        setPreviewLoadState('done');

        if (preview.isSubscribed && preview.subscribedPodcastId) {
          router.replace(`/podcasts/${preview.subscribedPodcastId}`);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to load preview:", err);
          setPreviewLoadState('error');
          setPreviewError(err instanceof Error ? err.message : "Could not load podcast");
        }
      }
    }

    loadPreviewData();
    return () => { cancelled = true; };
  }, [isPodcastLoading, podcast, isAuthenticated, podcastId, router]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(
        `kima_podcast_sort_order_${podcastId}`,
        sortOrder
      );
    }
  }, [sortOrder, podcastId]);

  const displayData = podcast || (previewData ? {
    title: previewData.title,
    author: previewData.author,
    description: previewData.description,
    coverUrl: previewData.coverUrl,
    genres: previewData.genres,
    episodes: [],
  } : null);

  const inProgressEpisodes = podcast
    ? podcast.episodes.filter(
        (ep: Episode) =>
          ep.progress &&
          !ep.progress.isFinished &&
          ep.progress.currentTime > 0
      )
    : [];

  // The server pages from the end that was asked for; render in the order it arrived.
  const sortedEpisodes = podcast ? [...podcast.episodes] : [];

  const needsPreviewLoad = !podcast && previewLoadState === 'idle';
  const isLoadingPreview = previewLoadState === 'loading';
  const isLoading = isPodcastLoading || needsPreviewLoad || isLoadingPreview;

  return {
    podcastId,
    podcast: podcast as Podcast | undefined,
    previewData,
    previewLoadState,
    previewError,
    displayData,
    isLoading,
    heroImage,
    colorExtractionImage,
    similarPodcasts,
    similarTitle,
    sortOrder,
    setSortOrder,
    inProgressEpisodes,
    sortedEpisodes,
    episodesUpdating,
    hasMore,
    loadMore,
    loadingMore,
  };
}
