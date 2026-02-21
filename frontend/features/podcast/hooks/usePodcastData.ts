"use client";

import { useState, useEffect } from "react";
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
        `kima_podcast_sort_order_${podcastId}`
      );
      return (saved as "newest" | "oldest") || "newest";
    }
    return "newest";
  });

  // Get raw cover URL
  const rawCoverUrl = podcast?.coverUrl || previewData?.coverUrl;
  const heroImage = rawCoverUrl ? api.getCoverArtUrl(rawCoverUrl, 1200) : null;
  // Separate URL with token for color extraction (CORS access for canvas)
  const colorExtractionImage = rawCoverUrl ? api.getCoverArtUrl(rawCoverUrl, 300, true) : null;

  // Load similar podcasts when podcast data is available
  useEffect(() => {
    if (!podcast || !isAuthenticated) return;

    let cancelled = false;

    async function loadSimilarPodcasts() {
      try {
        const similar = await api.getSimilarPodcasts(podcastId);
        if (!cancelled) setSimilarPodcasts(similar);
      } catch (error) {
        if (!cancelled) console.error("Failed to load similar podcasts:", error);
      }
    }

    loadSimilarPodcasts();
    return () => { cancelled = true; };
  }, [podcast, isAuthenticated, podcastId]);

  // Handle preview mode if podcast is not subscribed
  useEffect(() => {
    if (isPodcastLoading) return;
    if (podcast || !isAuthenticated || previewLoadState !== 'idle') return;

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
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load preview:", error);
          setPreviewLoadState('error');
        }
      }
    }

    loadPreviewData();
    return () => { cancelled = true; };
  }, [isPodcastLoading, podcast, isAuthenticated, podcastId, router]);

  // Save sort order to localStorage when it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem(
        `kima_podcast_sort_order_${podcastId}`,
        sortOrder
      );
    }
  }, [sortOrder, podcastId]);

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
    colorExtractionImage,
    similarPodcasts,
    sortOrder,
    setSortOrder,
    inProgressEpisodes,
    sortedEpisodes,
  };
}
