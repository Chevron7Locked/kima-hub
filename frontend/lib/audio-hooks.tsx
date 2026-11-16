"use client";

import {
    useActiveOperation,
    useCurrentMedia,
    useOverlayOpen,
    usePlayMode,
    useVolumeState,
} from "./audio-state-context";
import { useAudioPlayback } from "./audio-playback-context";
import { useAudioControls } from "./audio-controls-context";

/**
 * The audio state in one hook, minus the queue: a queue edit must not re-render the readers of this. Prefer the
 * slice hooks (useCurrentMedia, useVolumeState, ...), useAudioPlayback or useAudioControls where only one is needed:
 * playback re-renders often. The queue is read through useQueueState.
 */
export function useAudio() {
    const media = useCurrentMedia();
    const mode = usePlayMode();
    const volume = useVolumeState();
    const overlayOpen = useOverlayOpen();
    const activeOperation = useActiveOperation();
    const playback = useAudioPlayback();
    const controls = useAudioControls();

    return {
        // State
        currentTrack: media.currentTrack,
        currentAudiobook: media.currentAudiobook,
        currentPodcast: media.currentPodcast,
        playbackType: media.playbackType,
        isShuffle: mode.isShuffle,
        repeatMode: mode.repeatMode,
        overlayOpen,
        volume: volume.volume,
        isMuted: volume.isMuted,

        // Vibe operation state
        activeOperation,

        // Playback
        isPlaying: playback.isPlaying,
        currentTime: playback.currentTime,
        duration: playback.duration,
        isBuffering: playback.isBuffering,
        audioError: playback.audioError,

        // Controls
        playTrack: controls.playTrack,
        playTracks: controls.playTracks,
        playStation: controls.playStation,
        playAudiobook: controls.playAudiobook,
        playPodcast: controls.playPodcast,
        pause: controls.pause,
        resumeWithGesture: controls.resumeWithGesture,
        next: controls.next,
        previous: controls.previous,
        addToQueue: controls.addToQueue,
        removeFromQueue: controls.removeFromQueue,
        clearQueue: controls.clearQueue,
        setUpcoming: controls.setUpcoming,
        toggleShuffle: controls.toggleShuffle,
        toggleRepeat: controls.toggleRepeat,
        updateCurrentTime: controls.updateCurrentTime,
        seek: controls.seek,
        skipForward: controls.skipForward,
        skipBackward: controls.skipBackward,
        openOverlay: controls.openOverlay,
        closeOverlay: controls.closeOverlay,
        setVolume: controls.setVolume,
        toggleMute: controls.toggleMute,

        // Vibe mode controls
        startVibeMode: controls.startVibeMode,
        stopVibeMode: controls.stopVibeMode,
    };
}
