"use client";

import { useAudioState } from "./audio-state-context";
import { useAudioPlayback } from "./audio-playback-context";
import { useAudioControls } from "./audio-controls-context";

/**
 * All three audio contexts in one hook. Prefer useAudioState, useAudioPlayback
 * or useAudioControls where only one is needed: playback re-renders often.
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
        
        // Vibe operation state
        activeOperation: state.activeOperation,

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
        resume: controls.resume,
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
        setPlayerMode: controls.setPlayerMode,
        returnToPreviousMode: controls.returnToPreviousMode,
        setVolume: controls.setVolume,
        toggleMute: controls.toggleMute,
        
        // Vibe mode controls
        startVibeMode: controls.startVibeMode,
        stopVibeMode: controls.stopVibeMode,
    };
}
