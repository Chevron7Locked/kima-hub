"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useAudio } from "@/lib/audio-context";
import { useAudioState } from "@/lib/audio-state-context";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { Podcast, Episode, PodcastPreview } from "../types";
import { queryKeys, refreshFollowedShows } from "@/hooks/useQueries";
import { dispatchQueryEvent } from "@/lib/query-events";
import { useEpisodeToggle } from "./usePlayEpisode";

export function usePodcastActions(podcastId: string, sortedEpisodes?: Episode[]) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const { playPodcast, currentPodcast, isPlaying, pause } = useAudio();
    const toggleEpisode = useEpisodeToggle();
    const { setPodcastEpisodeQueue } = useAudioState();

    const [isSubscribing, setIsSubscribing] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const handleSubscribe = useCallback(
        async (previewData: PodcastPreview | null) => {
            if (!previewData?.feedUrl) return;

            setIsSubscribing(true);
            try {
                const response = await api.subscribePodcast(
                    previewData.feedUrl,
                    previewData.itunesId
                );

                if (response.success && response.podcast?.id) {
                    refreshFollowedShows(queryClient);
                    router.push(`/podcasts/${response.podcast.id}`);
                }
            } catch (error: unknown) {
                notify.error("Couldn't subscribe to this podcast", { message: error instanceof Error ? error.message : undefined });
            } finally {
                setIsSubscribing(false);
            }
        },
        [router, queryClient]
    );

    const handleRemovePodcast = useCallback(async () => {
        try {
            await api.removePodcast(podcastId);
            refreshFollowedShows(queryClient);
            router.push("/podcasts");
        } catch (error) {
            notify.error("Couldn't remove this podcast", { message: error instanceof Error ? error.message : undefined });
        }
    }, [podcastId, router, queryClient]);

    // The queue is saved in the browser: 200 episodes around the one played, from the list it was picked from.
    const queueAround = useCallback(
        (episode: Episode, around: Episode[] | undefined) => {
            if (!around || around.length === 0) return;
            const at = Math.max(0, around.findIndex((e) => e.id === episode.id));
            const start = Math.max(0, Math.min(at - 100, around.length - 200));
            setPodcastEpisodeQueue(around.slice(start, start + 200));
        },
        [setPodcastEpisodeQueue]
    );
    const toPlay = useCallback(
        (episode: Episode, podcast: Podcast) => ({
            id: `${podcastId}:${episode.id}`,
            title: episode.title,
            podcastTitle: podcast.title,
            coverUrl: podcast.coverUrl,
            duration: episode.duration,
            progress: episode.progress || null,
        }),
        [podcastId]
    );

    const handlePlayEpisode = useCallback(
        (episode: Episode, podcast: Podcast, around: Episode[] | undefined = sortedEpisodes) => {
            queueAround(episode, around);
            playPodcast(toPlay(episode, podcast));
        },
        [queueAround, toPlay, playPodcast, sortedEpisodes]
    );

    const handlePlayPauseEpisode = useCallback(
        (episode: Episode, podcast: Podcast) =>
            toggleEpisode(toPlay(episode, podcast), () => queueAround(episode, sortedEpisodes)),
        [toggleEpisode, toPlay, queueAround, sortedEpisodes]
    );

    const isEpisodePlaying = useCallback(
        (episodeId: string) => {
            return currentPodcast?.id === `${podcastId}:${episodeId}`;
        },
        [podcastId, currentPodcast]
    );

    const handleMarkEpisodeComplete = useCallback(
        async (episodeId: string, duration: number) => {
            try {
                await api.updatePodcastEpisodeProgress(
                    podcastId,
                    episodeId,
                    duration,
                    duration,
                    true
                );

                // A fresh read after the write, so the episode shows as played.
                queryClient.invalidateQueries({ queryKey: queryKeys.podcast(podcastId) });

                dispatchQueryEvent("podcast-progress-updated");
            } catch (error) {
                notify.error("Couldn't mark the episode as played", { message: error instanceof Error ? error.message : undefined });
            }
        },
        [podcastId, queryClient]
    );

    const handleRefresh = useCallback(async () => {
        setIsRefreshing(true);
        try {
            const result = await api.refreshPodcast(podcastId);
            queryClient.invalidateQueries({ queryKey: queryKeys.podcast(podcastId) });
            return result;
        } catch (error) {
            notify.error("Couldn't refresh this podcast", { message: error instanceof Error ? error.message : undefined });
        } finally {
            setIsRefreshing(false);
        }
    }, [podcastId, queryClient]);

    return {
        isSubscribing,
        isRefreshing,
        showDeleteConfirm,
        setShowDeleteConfirm,
        handleSubscribe,
        handleRemovePodcast,
        handleRefresh,
        handlePlayEpisode,
        handlePlayPauseEpisode,
        handleMarkEpisodeComplete,
        isEpisodePlaying,
        isPlaying,
        pause,
    };
}

