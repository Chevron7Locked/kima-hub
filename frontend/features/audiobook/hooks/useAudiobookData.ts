"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useAudiobookQuery } from "@/hooks/useQueries";
import { api } from "@/lib/api";
import { subscribeQueryEvent } from "@/lib/query-events";

export function useAudiobookData() {
  const params = useParams();
  const audiobookId = params.id as string;

  const { data: audiobook, isLoading, refetch } = useAudiobookQuery(audiobookId);

  useEffect(() => {
    const unsubscribe = subscribeQueryEvent("audiobook-progress-updated", () => {
      refetch();
    });

    return unsubscribe;
  }, [refetch]);

  const heroImage = audiobook?.coverUrl
    ? api.getCoverArtUrl(audiobook.coverUrl, 1200)
    : null;
  const colorExtractionImage = audiobook?.coverUrl
    ? api.getCoverArtUrl(audiobook.coverUrl, 300, true)
    : null;

  const getMetadata = () => {
    if (!audiobook) return null;

    return {
      narrator: audiobook.narrator || null,
      genre: audiobook.genres?.[0] || null,
      publishedYear: audiobook.publishedYear ?? null,
      description: audiobook.description || null,
    };
  };

  return {
    audiobookId,
    audiobook,
    isLoading,
    refetch,
    heroImage,
    colorExtractionImage,
    metadata: getMetadata(),
  };
}
