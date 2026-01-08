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

  // Listen for audiobook-progress-updated event (fired when playback starts/updates)
  useEffect(() => {
    const unsubscribe = subscribeQueryEvent("audiobook-progress-updated", () => {
      refetch();
    });

    return unsubscribe;
  }, [refetch]);

  // Calculate hero image for color extraction
  const heroImage = audiobook?.coverUrl
    ? api.getCoverArtUrl(audiobook.coverUrl, 1200)
    : null;

  // Extract metadata from audioFiles
  const getMetadata = () => {
    if (!audiobook) return null;

    if (!audiobook.audioFiles?.[0]?.metaTags) {
      return {
        narrator: audiobook.narrator || null,
        genre: null,
        publishedYear: null,
        description: audiobook.description || null,
      };
    }

    const metaTags = audiobook.audioFiles[0].metaTags;

    // Extract narrator from description or tagComment
    let narrator = audiobook.narrator;
    if (!narrator || narrator.trim() === "") {
      const desc = audiobook.description || metaTags.tagComment || "";
      const narratorMatch = desc.match(/(?:Read by|Narrated by):\s*(.+)/i);
      if (narratorMatch) {
        narrator = narratorMatch[1].trim();
      }
    }

    return {
      narrator: narrator || null,
      genre: metaTags.tagGenre || null,
      publishedYear: metaTags.tagDate || null,
      description: audiobook.description || metaTags.tagComment || null,
    };
  };

  return {
    audiobookId,
    audiobook,
    isLoading,
    refetch,
    heroImage,
    metadata: getMetadata(),
  };
}
