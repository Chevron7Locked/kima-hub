// frontend/components/player/AudioElement.tsx
"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api } from "@/lib/api";
import { audioEngine } from "@/lib/audio-engine";
import { audioSeekEmitter } from "@/lib/audio-seek-emitter";
import { dispatchQueryEvent } from "@/lib/query-events";
import {
    useEffect,
    useLayoutEffect,
    useRef,
    memo,
    useCallback,
} from "react";

function getNextTrackInfo(
    queue: { id: string; filePath?: string }[],
    currentIndex: number,
    isShuffle: boolean,
    shuffleIndices: number[],
    repeatMode: "off" | "one" | "all"
): { id: string; filePath?: string } | null {
    if (queue.length === 0) return null;

    let nextIndex: number;
    if (isShuffle) {
        const currentShufflePos = shuffleIndices.indexOf(currentIndex);
        if (currentShufflePos < shuffleIndices.length - 1) {
            nextIndex = shuffleIndices[currentShufflePos + 1];
        } else if (repeatMode === "all") {
            nextIndex = shuffleIndices[0];
        } else {
            return null;
        }
    } else {
        if (currentIndex < queue.length - 1) {
            nextIndex = currentIndex + 1;
        } else if (repeatMode === "all") {
            nextIndex = 0;
        } else {
            return null;
        }
    }

    return queue[nextIndex] || null;
}

/**
 * AudioElement - Unified audio playback using native HTML5 Audio
 *
 * Handles: web playback, progress saving for audiobooks/podcasts
 * Browser media controls are handled separately by useMediaSession hook
 */
export const AudioElement = memo(function AudioElement() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        volume,
        isMuted,
        repeatMode,
        setCurrentAudiobook,
        setCurrentTrack,
        setCurrentPodcast,
        setPlaybackType,
        queue,
        currentIndex,
        isShuffle,
        shuffleIndices,
    } = useAudioState();

    const {
        isPlaying,
        setCurrentTimeFromEngine,
        setDuration,
        setIsPlaying,
        setIsBuffering,
        setAudioError,
    } = useAudioPlayback();

    const { pause, next, nextPodcastEpisode } = useAudioControls();

    // Refs for tracking state across effects
    const lastTrackIdRef = useRef<string | null>(null);
    const lastPlayingStateRef = useRef<boolean>(isPlaying);
    const progressSaveIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const lastProgressSaveRef = useRef<number>(0);
    const preloadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastPreloadedTrackIdRef = useRef<string | null>(null);
    const pendingStartTimeRef = useRef<number>(0);

    // Refs for stable event handler access (avoids re-subscribing engine events)
    const playbackTypeRef = useRef(playbackType);
    const currentTrackRef = useRef(currentTrack);
    const currentAudiobookRef = useRef(currentAudiobook);
    const currentPodcastRef = useRef(currentPodcast);
    const repeatModeRef = useRef(repeatMode);
    const nextRef = useRef(next);
    const nextPodcastEpisodeRef = useRef(nextPodcastEpisode);
    const pauseRef = useRef(pause);
    const queueRef = useRef(queue);
    const setCurrentTrackRef = useRef(setCurrentTrack);
    const setCurrentAudiobookRef = useRef(setCurrentAudiobook);
    const setCurrentPodcastRef = useRef(setCurrentPodcast);
    const setPlaybackTypeRef = useRef(setPlaybackType);

    useLayoutEffect(() => {
        playbackTypeRef.current = playbackType;
        currentTrackRef.current = currentTrack;
        currentAudiobookRef.current = currentAudiobook;
        currentPodcastRef.current = currentPodcast;
        repeatModeRef.current = repeatMode;
        nextRef.current = next;
        nextPodcastEpisodeRef.current = nextPodcastEpisode;
        pauseRef.current = pause;
        queueRef.current = queue;
        setCurrentTrackRef.current = setCurrentTrack;
        setCurrentAudiobookRef.current = setCurrentAudiobook;
        setCurrentPodcastRef.current = setCurrentPodcast;
        setPlaybackTypeRef.current = setPlaybackType;
    });

    // Keep isPlaying ref in sync
    useLayoutEffect(() => {
        lastPlayingStateRef.current = isPlaying;
    }, [isPlaying]);

    // --- Save progress callbacks ---

    const saveAudiobookProgress = useCallback(
        async (isFinished: boolean = false) => {
            if (!currentAudiobook) return;

            const currentTime = audioEngine.getCurrentTime();
            const duration = audioEngine.getDuration() || currentAudiobook.duration;

            if (currentTime === lastProgressSaveRef.current && !isFinished) return;
            lastProgressSaveRef.current = currentTime;

            try {
                await api.updateAudiobookProgress(
                    currentAudiobook.id,
                    isFinished ? duration : currentTime,
                    duration,
                    isFinished
                );
                setCurrentAudiobook((prev) => {
                    if (!prev || prev.id !== currentAudiobook.id) return prev;
                    const dur = prev.duration || 0;
                    const pos = isFinished ? dur : currentTime;
                    return {
                        ...prev,
                        progress: {
                            currentTime: pos,
                            progress: dur > 0 ? (pos / dur) * 100 : 0,
                            isFinished,
                            lastPlayedAt: new Date(),
                        },
                    };
                });
                dispatchQueryEvent("audiobook-progress-updated");
            } catch (err) {
                console.error("[AudioElement] Failed to save audiobook progress:", err);
            }
        },
        [currentAudiobook, setCurrentAudiobook]
    );

    const savePodcastProgress = useCallback(
        async (isFinished: boolean = false) => {
            if (!currentPodcast) return;

            const currentTime = audioEngine.getCurrentTime();
            const duration = audioEngine.getDuration() || currentPodcast.duration;
            if (currentTime <= 0 && !isFinished) return;

            try {
                const [podcastId, episodeId] = currentPodcast.id.split(":");
                await api.updatePodcastProgress(
                    podcastId,
                    episodeId,
                    isFinished ? duration : currentTime,
                    duration,
                    isFinished
                );
                dispatchQueryEvent("podcast-progress-updated");
            } catch (err) {
                console.error("[AudioElement] Failed to save podcast progress:", err);
            }
        },
        [currentPodcast]
    );

    // Keep save callbacks in refs for stable engine event handlers
    const saveAudiobookProgressRef = useRef(saveAudiobookProgress);
    const savePodcastProgressRef = useRef(savePodcastProgress);
    useLayoutEffect(() => {
        saveAudiobookProgressRef.current = saveAudiobookProgress;
        savePodcastProgressRef.current = savePodcastProgress;
    }, [saveAudiobookProgress, savePodcastProgress]);

    // --- Initialize engine ---

    useEffect(() => {
        audioEngine.initializeFromStorage();
    }, []);

    // Reset duration when nothing is playing
    useEffect(() => {
        if (!currentTrack && !currentAudiobook && !currentPodcast) {
            setDuration(0);
        }
    }, [currentTrack, currentAudiobook, currentPodcast, setDuration]);

    // --- Subscribe to engine events (registered once) ---

    useEffect(() => {
        const handleTimeUpdate = (data: unknown) => {
            const { time } = data as { time: number };
            setCurrentTimeFromEngine(time);
        };

        const handleCanPlay = (data: unknown) => {
            const { duration: dur } = data as { duration: number };
            const fallback =
                currentTrackRef.current?.duration ||
                currentAudiobookRef.current?.duration ||
                currentPodcastRef.current?.duration || 0;
            setDuration(dur || fallback);
            setIsBuffering(false);
            setAudioError(null);

            // Seek to saved position for audiobooks/podcasts
            if (pendingStartTimeRef.current > 0) {
                audioEngine.seek(pendingStartTimeRef.current);
                pendingStartTimeRef.current = 0;
            }
        };

        const handleWaiting = () => {
            setIsBuffering(true);
        };

        const handlePlaying = () => {
            setIsBuffering(false);
        };

        const handleEnded = () => {
            // Save final progress for audiobooks/podcasts
            if (playbackTypeRef.current === "audiobook") {
                saveAudiobookProgressRef.current(true);
            } else if (playbackTypeRef.current === "podcast") {
                savePodcastProgressRef.current(true);
            }

            // Handle what comes next
            if (playbackTypeRef.current === "podcast") {
                nextPodcastEpisodeRef.current();
            } else if (playbackTypeRef.current === "audiobook") {
                pauseRef.current();
            } else if (playbackTypeRef.current === "track") {
                if (repeatModeRef.current === "one") {
                    audioEngine.seek(0);
                    audioEngine.play();
                } else {
                    nextRef.current();
                }
            } else {
                pauseRef.current();
            }
        };

        const handleError = (data: unknown) => {
            const { error } = data as { error: string; code?: number };
            console.error("[AudioElement] Playback error:", error);

            setIsPlaying(false);
            setIsBuffering(false);
            setAudioError(typeof error === "string" ? error : "Audio playback error");

            // For tracks: skip to next if queue has more, otherwise clear
            if (playbackTypeRef.current === "track") {
                if (queueRef.current.length > 1) {
                    lastTrackIdRef.current = null;
                    nextRef.current();
                } else {
                    lastTrackIdRef.current = null;
                    setCurrentTrackRef.current(null);
                    setPlaybackTypeRef.current(null);
                }
            } else if (playbackTypeRef.current === "audiobook") {
                setCurrentAudiobookRef.current(null);
                setPlaybackTypeRef.current(null);
            } else if (playbackTypeRef.current === "podcast") {
                setCurrentPodcastRef.current(null);
                setPlaybackTypeRef.current(null);
            }
        };

        const handlePause = () => {
            // Only sync pause state for unexpected pauses (not user-initiated).
            // If the user paused, the isPlaying effect already set the state.
            // This catches: browser throttling, audio focus loss, etc.
            if (lastPlayingStateRef.current && !audioEngine.isPlaying()) {
                setIsPlaying(false);
            }
        };

        audioEngine.on("timeupdate", handleTimeUpdate);
        audioEngine.on("canplay", handleCanPlay);
        audioEngine.on("waiting", handleWaiting);
        audioEngine.on("play", handlePlaying);
        audioEngine.on("ended", handleEnded);
        audioEngine.on("error", handleError);
        audioEngine.on("pause", handlePause);

        return () => {
            audioEngine.off("timeupdate", handleTimeUpdate);
            audioEngine.off("canplay", handleCanPlay);
            audioEngine.off("waiting", handleWaiting);
            audioEngine.off("play", handlePlaying);
            audioEngine.off("ended", handleEnded);
            audioEngine.off("error", handleError);
            audioEngine.off("pause", handlePause);
        };
    }, [setCurrentTimeFromEngine, setDuration, setIsPlaying, setIsBuffering, setAudioError]);

    // --- Load audio when track changes ---

    useEffect(() => {
        const currentMediaId =
            currentTrack?.id || currentAudiobook?.id || currentPodcast?.id || null;

        if (!currentMediaId) {
            audioEngine.cleanup();
            lastTrackIdRef.current = null;
            return;
        }

        // Same track - no reload needed
        if (currentMediaId === lastTrackIdRef.current) return;
        lastTrackIdRef.current = currentMediaId;

        let streamUrl: string | null = null;
        let startTime = 0;

        if (playbackType === "track" && currentTrack) {
            streamUrl = api.getStreamUrl(currentTrack.id);
        } else if (playbackType === "audiobook" && currentAudiobook) {
            streamUrl = api.getAudiobookStreamUrl(currentAudiobook.id);
            startTime = currentAudiobook.progress?.currentTime || 0;
        } else if (playbackType === "podcast" && currentPodcast) {
            const [podcastId, episodeId] = currentPodcast.id.split(":");
            streamUrl = api.getPodcastEpisodeStreamUrl(podcastId, episodeId);
            startTime = currentPodcast.progress?.currentTime || 0;
        }

        if (!streamUrl) return;

        // Determine autoplay: play if user was playing or if isPlaying was set (e.g., by next())
        const shouldAutoPlay = lastPlayingStateRef.current;

        // Set fallback duration from metadata while loading
        const fallbackDuration =
            currentTrack?.duration || currentAudiobook?.duration || currentPodcast?.duration || 0;
        setDuration(fallbackDuration);

        if (shouldAutoPlay) {
            setIsBuffering(true);
        }

        // Store start time for the canplay handler to pick up
        pendingStartTimeRef.current = startTime;

        // Load the audio - setting src stops any current playback (single stream guaranteed)
        audioEngine.load(streamUrl, shouldAutoPlay);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isPlaying intentionally excluded to prevent reload on play/pause
    }, [currentTrack, currentAudiobook, currentPodcast, playbackType, setDuration, setIsBuffering]);

    // --- Sync play/pause from UI to engine ---

    useEffect(() => {
        if (isPlaying) {
            if (!audioEngine.hasAudio() && !audioEngine.getState().currentSrc) {
                // No audio loaded - force reload by resetting track ref
                lastTrackIdRef.current = null;
                // The track change effect will pick it up on next render
                return;
            }
            audioEngine.play().catch(() => {
                // play() failed (autoplay blocked, no audio loaded, etc.)
                setIsPlaying(false);
            });
        } else {
            audioEngine.pause();
        }
    }, [isPlaying, setIsPlaying]);

    // --- Volume/mute sync ---

    useEffect(() => { audioEngine.setVolume(volume); }, [volume]);
    useEffect(() => { audioEngine.setMuted(isMuted); }, [isMuted]);

    // --- Seeking via emitter ---

    useEffect(() => {
        const handleSeek = (time: number) => {
            audioEngine.seek(time);
        };
        return audioSeekEmitter.subscribe(handleSeek);
    }, []);

    // --- Preload next track for gapless playback (music only) ---

    useEffect(() => {
        if (playbackType !== "track" || !currentTrack || !isPlaying) return;

        if (preloadTimeoutRef.current) {
            clearTimeout(preloadTimeoutRef.current);
            preloadTimeoutRef.current = null;
        }

        const nextTrack = getNextTrackInfo(queue, currentIndex, isShuffle, shuffleIndices, repeatMode);

        if (!nextTrack || nextTrack.id === lastPreloadedTrackIdRef.current) return;

        // Preload after 2s of stable playback to avoid preloading during rapid skipping
        preloadTimeoutRef.current = setTimeout(() => {
            const streamUrl = api.getStreamUrl(nextTrack.id);
            audioEngine.preload(streamUrl);
            lastPreloadedTrackIdRef.current = nextTrack.id;
        }, 2000);

        return () => {
            if (preloadTimeoutRef.current) {
                clearTimeout(preloadTimeoutRef.current);
                preloadTimeoutRef.current = null;
            }
        };
    }, [playbackType, currentTrack, isPlaying, queue, currentIndex, isShuffle, shuffleIndices, repeatMode]);

    // --- Periodic progress saving for audiobooks/podcasts ---

    useEffect(() => {
        if (playbackType !== "audiobook" && playbackType !== "podcast") {
            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
                progressSaveIntervalRef.current = null;
            }
            return;
        }

        // Save on pause
        if (!isPlaying) {
            if (playbackType === "audiobook") {
                saveAudiobookProgressRef.current();
            } else if (playbackType === "podcast") {
                savePodcastProgressRef.current();
            }
        }

        // Save periodically while playing
        if (isPlaying) {
            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
            }
            progressSaveIntervalRef.current = setInterval(() => {
                if (playbackTypeRef.current === "audiobook") {
                    saveAudiobookProgressRef.current();
                } else if (playbackTypeRef.current === "podcast") {
                    savePodcastProgressRef.current();
                }
            }, 30000);
        }

        return () => {
            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
                progressSaveIntervalRef.current = null;
            }
        };
    }, [playbackType, isPlaying]);

    // --- Cleanup on unmount ---

    useEffect(() => {
        return () => {
            // Save final progress
            if (playbackTypeRef.current === "audiobook") {
                saveAudiobookProgressRef.current();
            } else if (playbackTypeRef.current === "podcast") {
                savePodcastProgressRef.current();
            }

            audioEngine.cleanup();
            lastTrackIdRef.current = null;

            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
            }
            if (preloadTimeoutRef.current) {
                clearTimeout(preloadTimeoutRef.current);
            }
        };
    }, []);

    return null;
});
