"use client";

import { useCallback } from "react";
import { useAudio } from "@/lib/audio-context";
import type { ListeningRow } from "../types";
import { episodeForPlayer } from "@/lib/podcast-episode";

type EpisodeToPlay = Parameters<ReturnType<typeof useAudio>["playPodcast"]>[0];

/**
 * Pause or resume the episode the player has loaded, or start another. The player's id for an episode is the show's
 * and the episode's together.
 */
export function useEpisodeToggle() {
    const { playPodcast, currentPodcast, isPlaying, pause, resumeWithGesture } = useAudio();
    return useCallback(
        (episode: EpisodeToPlay) => {
            if (currentPodcast?.id === episode.id) {
                if (isPlaying) pause();
                else resumeWithGesture();
                return;
            }
            playPodcast(episode);
        },
        [currentPodcast?.id, isPlaying, pause, resumeWithGesture, playPodcast],
    );
}

const keyOf = (row: ListeningRow) => `${row.podcast.id}:${row.episode.id}`;

/** Play, pause or resume an episode from a list that spans shows (continue listening, new episodes). */
export function usePlayEpisode() {
    const { currentPodcast, isPlaying } = useAudio();
    const toggleEpisode = useEpisodeToggle();

    const toggle = useCallback(
        (row: ListeningRow) =>
            toggleEpisode(
                episodeForPlayer(row.podcast.id, row.podcast, row.episode, row.episode.coverUrl || row.podcast.coverUrl)
            ),
        [toggleEpisode],
    );

    const isPlayingRow = useCallback(
        (row: ListeningRow) => isPlaying && currentPodcast?.id === keyOf(row),
        [isPlaying, currentPodcast?.id],
    );

    return { toggle, isPlayingRow };
}
