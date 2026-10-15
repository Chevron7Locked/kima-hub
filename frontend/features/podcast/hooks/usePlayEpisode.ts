"use client";

import { useCallback } from "react";
import { useAudio } from "@/lib/audio-hooks";
import type { ListeningRow } from "../types";

/** The player's id for an episode: show and episode together. */
const keyOf = (row: ListeningRow) => `${row.podcast.id}:${row.episode.id}`;

/** Play, pause or resume an episode from a list that spans shows (continue listening, new episodes). */
export function usePlayEpisode() {
    const { playPodcast, currentPodcast, isPlaying, pause, resumeWithGesture } = useAudio();

    const toggle = useCallback(
        (row: ListeningRow) => {
            const id = keyOf(row);
            if (currentPodcast?.id === id) {
                if (isPlaying) pause();
                else resumeWithGesture();
                return;
            }
            playPodcast({
                id,
                title: row.episode.title,
                podcastTitle: row.podcast.title,
                coverUrl: row.episode.coverUrl || row.podcast.coverUrl || "",
                duration: row.episode.duration,
                progress: row.episode.progress ?? null,
            });
        },
        [currentPodcast?.id, isPlaying, pause, resumeWithGesture, playPodcast],
    );

    const isPlayingRow = useCallback(
        (row: ListeningRow) => isPlaying && currentPodcast?.id === keyOf(row),
        [isPlaying, currentPodcast?.id],
    );

    return { toggle, isPlayingRow };
}
