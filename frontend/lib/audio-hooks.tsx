"use client";

import { useAudioState } from "./audio-state-context";
import { useAudioPlayback } from "./audio-playback-context";
import { useAudioControls } from "./audio-controls-context";

/**
 * Unified hook that combines all audio contexts.
 * Use this for backward compatibility with existing code.
 *
 * For optimal performance, prefer using the individual hooks:
 * - useAudioState() - for rarely changing data (currentTrack, queue, etc.)
 * - useAudioPlayback() - for frequently changing data (currentTime, isPlaying)
 * - useAudioControls() - for actions only (play, pause, next, etc.)
 */
export function useAudio() {
    const state = useAudioState();
    const playback = useAudioPlayback();
    const controls = useAudioControls();

    return {
        // State
        currentTrack: state.currentTrack,
        currentAudiobook: state.currentAudiobook,
        currentPodcast: state.currentPodcast,
        playbackType: state.playbackType,
        queue: state.queue,
        currentIndex: state.currentIndex,
        isShuffle: state.isShuffle,
        repeatMode: state.repeatMode,
        playerMode: state.playerMode,
        volume: state.volume,
        isMuted: state.isMuted,
        
        // Vibe mode state
        vibeMode: state.vibeMode,
        vibeSourceFeatures: state.vibeSourceFeatures,
        vibeQueueIds: state.vibeQueueIds,

        // Playback
        isPlaying: playback.isPlaying,
        currentTime: playback.currentTime,
        duration: playback.duration,
        isBuffering: playback.isBuffering,
        canSeek: playback.canSeek,
        downloadProgress: playback.downloadProgress,
        audioError: playback.audioError,
        playbackState: playback.playbackState,
        clearAudioError: playback.clearAudioError,

        // Controls
        playTrack: controls.playTrack,
        playTracks: controls.playTracks,
        playAudiobook: controls.playAudiobook,
        playPodcast: controls.playPodcast,
        pause: controls.pause,
        resume: controls.resume,
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
        setPlayerMode: controls.setPlayerMode,
        returnToPreviousMode: controls.returnToPreviousMode,
        setVolume: controls.setVolume,
        toggleMute: controls.toggleMute,
        
        // Vibe mode controls
        startVibeMode: controls.startVibeMode,
        stopVibeMode: controls.stopVibeMode,
    };
}
