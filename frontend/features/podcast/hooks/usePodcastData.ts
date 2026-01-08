"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { usePodcastQuery } from "@/hooks/useQueries";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { Podcast, PodcastPreview, SimilarPodcast, Episode } from "../types";
import { subscribeQueryEvent } from "@/lib/query-events";

export function usePodcastData() {
  const params = useParams();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const podcastId = params.id as string;

  // Use React Query hook for podcast
  const { data: podcast, isLoading: isPodcastLoading, refetch } =
    usePodcastQuery(podcastId);

  // Listen for podcast-progress-updated event (fired when playback starts/updates or episode marked complete)
  useEffect(() => {
    const unsubscribe = subscribeQueryEvent("podcast-progress-updated", () => {
      refetch();
    });

    return unsubscribe;
  }, [refetch]);

  // State for preview mode, subscription, and similar podcasts
  const [previewData, setPreviewData] = useState<PodcastPreview | null>(null);
  const [previewLoadState, setPreviewLoadState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [similarPodcasts, setSimilarPodcasts] = useState<SimilarPodcast[]>([]);
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(
        `lidify_podcast_sort_order_${podcastId}`
      );
      return (saved as "newest" | "oldest") || "newest";
    }
    return "newest";
  });

  // Get raw cover URL
  const rawCoverUrl = podcast?.coverUrl || previewData?.coverUrl;
  const heroImage = rawCoverUrl ? api.getCoverArtUrl(rawCoverUrl, 1200) : null;

  // Load similar podcasts when podcast data is available
  useEffect(() => {
    if (podcast && isAuthenticated) {
      loadSimilarPodcasts();
    }
  }, [podcast?.id, isAuthenticated]);

  // Handle preview mode if podcast is not subscribed
  useEffect(() => {
    if (isPodcastLoading) return;

    // If query returned no data, try preview mode
    if (!podcast && isAuthenticated && previewLoadState === 'idle') {
      loadPreviewData();
    }
  }, [isPodcastLoading, podcast, isAuthenticated, podcastId, previewLoadState]);

  // Save sort order to localStorage when it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(
        `lidify_podcast_sort_order_${podcastId}`,
        sortOrder
      );
    }
  }, [sortOrder, podcastId]);

  async function loadSimilarPodcasts() {
    try {
      const similar = await api.getSimilarPodcasts(podcastId);
      setSimilarPodcasts(similar);
    } catch (error) {
      console.error("Failed to load similar podcasts:", error);
    }
  }

  async function loadPreviewData() {
    setPreviewLoadState('loading');
    try {
      const preview = await api.previewPodcast(podcastId);
      setPreviewData(preview);
      setPreviewLoadState('done');

      // If already subscribed, redirect
      if (preview.isSubscribed && preview.subscribedPodcastId) {
        router.replace(`/podcasts/${preview.subscribedPodcastId}`);
      }
    } catch (error) {
      console.error("Failed to load preview:", error);
      setPreviewLoadState('error');
    }
  }

  // Computed values
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

  // Sort episodes based on selected order
  const sortedEpisodes = podcast
    ? [...podcast.episodes].sort((a: Episode, b: Episode) => {
        const dateA = new Date(a.publishedAt).getTime();
        const dateB = new Date(b.publishedAt).getTime();
        return sortOrder === "newest" ? dateB - dateA : dateA - dateB;
      })
    : [];

  // Determine loading state:
  // - Loading if podcast query is loading
  // - Loading if podcast query done but no podcast and we haven't tried/finished preview yet
  const needsPreviewLoad = !podcast && previewLoadState === 'idle';
  const isLoadingPreview = previewLoadState === 'loading';
  const isLoading = isPodcastLoading || needsPreviewLoad || isLoadingPreview;

  return {
    podcastId,
    podcast: podcast as Podcast | undefined,
    previewData,
    displayData,
    isLoading,
    heroImage,
    similarPodcasts,
    sortOrder,
    setSortOrder,
    inProgressEpisodes,
    sortedEpisodes,
  };
}
