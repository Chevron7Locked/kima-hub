"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { usePlaybackProgress } from "@/hooks/usePlaybackProgress";

/**
 * Gathers the four playback context reads for full-surface players. The sources
 * stay split so a currentTime tick re-renders only progress readers.
 */
export function usePlayerControls() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        volume,
        isMuted,
        isShuffle,
        repeatMode,
        activeOperation,
        queue,
        currentIndex,
    } = useAudioState();

    const { isPlaying, isBuffering, audioError } = useAudioPlayback();

    const { duration, displayTime, progress } = usePlaybackProgress();

    const {
        pause,
        resumeWithGesture,
        next,
        previous,
        openOverlay,
        closeOverlay,
        seek,
        skipForward,
        skipBackward,
        setVolume,
        toggleMute,
        toggleShuffle,
        toggleRepeat,
    } = useAudioControls();

    return {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        volume,
        isMuted,
        isShuffle,
        repeatMode,
        activeOperation,
        queue,
        currentIndex,
        isPlaying,
        isBuffering,
        audioError,
        duration,
        displayTime,
        progress,
        pause,
        resumeWithGesture,
        next,
        previous,
        openOverlay,
        closeOverlay,
        seek,
        skipForward,
        skipBackward,
        setVolume,
        toggleMute,
        toggleShuffle,
        toggleRepeat,
    };
}
