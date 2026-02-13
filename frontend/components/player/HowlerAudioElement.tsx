"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api } from "@/lib/api";
import { howlerEngine } from "@/lib/howler-engine";
import { audioSeekEmitter } from "@/lib/audio-seek-emitter";
import { dispatchQueryEvent } from "@/lib/query-events";
import {
    playbackStateMachine,
    HeartbeatMonitor,
    getAudioFormat,
} from "@/lib/audio";
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

function podcastDebugEnabled(): boolean {
    try {
        return (
            typeof window !== "undefined" &&
            window.localStorage?.getItem("lidifyPodcastDebug") === "1"
        );
    } catch {
        return false;
    }
}

function podcastDebugLog(message: string, data?: Record<string, unknown>) {
    if (!podcastDebugEnabled()) return;
    console.log(`[PodcastDebug] ${message}`, data || {});
}

/**
 * HowlerAudioElement - Unified audio playback using Howler.js
 *
 * Handles: web playback, progress saving for audiobooks/podcasts
 * Browser media controls are handled separately by useMediaSession hook
 */
export const HowlerAudioElement = memo(function HowlerAudioElement() {
    // State context
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

    // Playback context
    const {
        isPlaying,
        setCurrentTimeFromEngine,
        setDuration,
        setIsPlaying,
        isBuffering,
        setIsBuffering,
        setTargetSeekPosition,
        canSeek,
        setCanSeek,
        setDownloadProgress,
    } = useAudioPlayback();

    // Controls context
    const { pause, next, nextPodcastEpisode } = useAudioControls();

    // Refs
    const lastTrackIdRef = useRef<string | null>(null);
    const lastPlayingStateRef = useRef<boolean>(isPlaying);
    const progressSaveIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const lastProgressSaveRef = useRef<number>(0);
    const isUserInitiatedRef = useRef<boolean>(false);
    const isLoadingRef = useRef<boolean>(false);
    const loadIdRef = useRef<number>(0);
    const cachePollingRef = useRef<NodeJS.Timeout | null>(null);
    const seekCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const cacheStatusPollingRef = useRef<NodeJS.Timeout | null>(null);
    const seekReloadListenerRef = useRef<(() => void) | null>(null);
    const seekReloadInProgressRef = useRef<boolean>(false);
    // Track when a seek operation is in progress to prevent load effect from interfering
    const isSeekingRef = useRef<boolean>(false);
    // Track load listeners for cleanup to prevent memory leaks
    const loadListenerRef = useRef<(() => void) | null>(null);
    const loadErrorListenerRef = useRef<(() => void) | null>(null);
    const cachePollingLoadListenerRef = useRef<(() => void) | null>(null);
    // Counter to track seek operations and abort stale ones
    const seekOperationIdRef = useRef<number>(0);
    // Debounce timer for rapid podcast seeks
    const seekDebounceRef = useRef<NodeJS.Timeout | null>(null);
    const pendingSeekTimeRef = useRef<number | null>(null);
    // Track seek-related timeouts for cleanup
    const seekVerifyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const seekCompleteTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    // Loading timeout -- prevents stuck LOADING state if Howler never fires load/loaderror
    const loadingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    // Preload management
    const preloadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastPreloadedTrackIdRef = useRef<string | null>(null);

    // Heartbeat monitor for detecting stalled playback
    const heartbeatRef = useRef<HeartbeatMonitor | null>(null);

    // Initialize heartbeat monitor
    useEffect(() => {
        heartbeatRef.current = new HeartbeatMonitor({
            onStall: () => {
                // Playback stalled - time not moving but Howler says playing
                console.warn("[HowlerAudioElement] Heartbeat detected stall");
                const transitioned = playbackStateMachine.transition("BUFFERING");
                if (transitioned) {
                    setIsBuffering(true);
                    heartbeatRef.current?.startBufferTimeout();
                }
            },
            onUnexpectedStop: () => {
                // Howler stopped without us knowing
                console.warn("[HowlerAudioElement] Heartbeat detected unexpected stop");
                if (playbackStateMachine.isPlaying) {
                    // Sync React state to actual state
                    setIsPlaying(false);
                    playbackStateMachine.forceTransition("READY");
                }
            },
            onBufferTimeout: () => {
                // Been buffering too long - likely connection lost
                console.error("[HowlerAudioElement] Buffer timeout - connection may be lost");
                playbackStateMachine.transition("ERROR", {
                    error: "Connection lost - audio stream timed out",
                    errorCode: 408,
                });
                setIsPlaying(false);
                setIsBuffering(false);
            },
            onRecovery: () => {
                // Recovered from stall
                console.log("[HowlerAudioElement] Recovered from stall");
                if (playbackStateMachine.isBuffering) {
                    playbackStateMachine.transition("PLAYING");
                    setIsBuffering(false);
                }
            },
            getCurrentTime: () => howlerEngine.getCurrentTime(),
            isActuallyPlaying: () => howlerEngine.isPlaying(),
        });

        return () => {
            heartbeatRef.current?.destroy();
            heartbeatRef.current = null;
        };
    }, [setIsBuffering, setIsPlaying]);

    // Start/stop heartbeat based on playback state
    useEffect(() => {
        if (isPlaying && !isBuffering) {
            heartbeatRef.current?.start();
        } else {
            heartbeatRef.current?.stop();
        }
    }, [isPlaying, isBuffering]);

    // Initialize Howler engine from saved preferences on mount
    useEffect(() => {
        howlerEngine.initializeFromStorage();
    }, []);

    // Reset duration when nothing is playing
    useEffect(() => {
        if (!currentTrack && !currentAudiobook && !currentPodcast) {
            setDuration(0);
        }
    }, [currentTrack, currentAudiobook, currentPodcast, setDuration]);

    // Save audiobook progress
    const saveAudiobookProgress = useCallback(
        async (isFinished: boolean = false) => {
            if (!currentAudiobook) return;

            const currentTime = howlerEngine.getCurrentTime();
            const duration =
                howlerEngine.getDuration() || currentAudiobook.duration;

            if (currentTime === lastProgressSaveRef.current && !isFinished)
                return;
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
                console.error(
                    "[HowlerAudioElement] Failed to save audiobook progress:",
                    err
                );
            }
        },
        [currentAudiobook, setCurrentAudiobook]
    );

    // Save podcast progress
    const savePodcastProgress = useCallback(
        async (isFinished: boolean = false) => {
            if (!currentPodcast) return;

            if (isBuffering && !isFinished) return;

            const currentTime = howlerEngine.getCurrentTime();
            const duration =
                howlerEngine.getDuration() || currentPodcast.duration;

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
                console.error(
                    "[HowlerAudioElement] Failed to save podcast progress:",
                    err
                );
            }
        },
        [currentPodcast, isBuffering]
    );

    // Refs for unmount progress save (kept in sync via useLayoutEffect)
    const saveAudiobookProgressRef = useRef(saveAudiobookProgress);
    const savePodcastProgressRef = useRef(savePodcastProgress);
    const playbackTypeRef = useRef(playbackType);

    useLayoutEffect(() => {
        saveAudiobookProgressRef.current = saveAudiobookProgress;
        savePodcastProgressRef.current = savePodcastProgress;
        playbackTypeRef.current = playbackType;
    }, [saveAudiobookProgress, savePodcastProgress, playbackType]);

    // Subscribe to Howler events
    useEffect(() => {
        const handleTimeUpdate = (data: { time: number }) => {
            // Use setCurrentTimeFromEngine to respect seek lock
            // This prevents stale timeupdate events from overwriting optimistic seek updates
            setCurrentTimeFromEngine(data.time);

            // Notify heartbeat of progress to detect stalls
            heartbeatRef.current?.notifyProgress(data.time);
        };

        const handleLoad = (data: { duration: number }) => {
            const fallbackDuration =
                currentTrack?.duration ||
                currentAudiobook?.duration ||
                currentPodcast?.duration ||
                0;
            setDuration(data.duration || fallbackDuration);

            // Transition state machine - load complete
            if (playbackStateMachine.getState() === "LOADING") {
                playbackStateMachine.transition("READY");
            }
        };

        const handleEnd = () => {
            // Save final progress for audiobooks/podcasts
            if (playbackType === "audiobook" && currentAudiobook) {
                saveAudiobookProgress(true);
            } else if (playbackType === "podcast" && currentPodcast) {
                savePodcastProgress(true);
            }

            // Handle track advancement based on playback type
            if (playbackType === "podcast") {
                nextPodcastEpisode(); // Auto-advance to next episode
            } else if (playbackType === "audiobook") {
                pause();
            } else if (playbackType === "track") {
                if (repeatMode === "one") {
                    howlerEngine.seek(0);
                    howlerEngine.play();
                } else {
                    next();
                }
            } else {
                pause();
            }
        };

        const handleError = (data: { error: unknown }) => {
            console.error("[HowlerAudioElement] Playback error:", data.error);

            // Transition state machine to ERROR
            const errorMessage = data.error instanceof Error
                ? data.error.message
                : String(data.error);
            playbackStateMachine.forceTransition("ERROR", { error: errorMessage });

            setIsPlaying(false);
            setIsBuffering(false);
            isUserInitiatedRef.current = false;
            heartbeatRef.current?.stop();

            if (playbackType === "track") {
                if (queue.length > 1) {
                    lastTrackIdRef.current = null;
                    isLoadingRef.current = false;
                    next();
                } else {
                    lastTrackIdRef.current = null;
                    isLoadingRef.current = false;
                    setCurrentTrack(null);
                    setPlaybackType(null);
                }
            } else if (playbackType === "audiobook") {
                setCurrentAudiobook(null);
                setPlaybackType(null);
            } else if (playbackType === "podcast") {
                setCurrentPodcast(null);
                setPlaybackType(null);
            }
        };

        const handlePlay = () => {
            // Transition state machine to PLAYING
            playbackStateMachine.transition("PLAYING");

            if (!isUserInitiatedRef.current) {
                setIsPlaying(true);
            }
            isUserInitiatedRef.current = false;
        };

        const handlePause = () => {
            if (isLoadingRef.current) return;
            if (seekReloadInProgressRef.current) return;

            // Transition state machine to READY (paused)
            if (playbackStateMachine.isPlaying) {
                playbackStateMachine.transition("READY");
            }

            if (!isUserInitiatedRef.current) {
                setIsPlaying(false);
            }
            isUserInitiatedRef.current = false;
        };

        howlerEngine.on("timeupdate", handleTimeUpdate);
        howlerEngine.on("load", handleLoad);
        howlerEngine.on("end", handleEnd);
        howlerEngine.on("loaderror", handleError);
        howlerEngine.on("playerror", handleError);
        howlerEngine.on("play", handlePlay);
        howlerEngine.on("pause", handlePause);

        return () => {
            howlerEngine.off("timeupdate", handleTimeUpdate);
            howlerEngine.off("load", handleLoad);
            howlerEngine.off("end", handleEnd);
            howlerEngine.off("loaderror", handleError);
            howlerEngine.off("playerror", handleError);
            howlerEngine.off("play", handlePlay);
            howlerEngine.off("pause", handlePause);
        };
    }, [playbackType, currentTrack, currentAudiobook, currentPodcast, repeatMode, next, nextPodcastEpisode, pause, setCurrentTimeFromEngine, setDuration, setIsPlaying, setIsBuffering, queue, setCurrentTrack, setCurrentAudiobook, setCurrentPodcast, setPlaybackType, saveAudiobookProgress, savePodcastProgress]);

    // Load and play audio when track changes
    useEffect(() => {
        const currentMediaId =
            currentTrack?.id ||
            currentAudiobook?.id ||
            currentPodcast?.id ||
            null;

        if (!currentMediaId) {
            howlerEngine.stop();
            lastTrackIdRef.current = null;
            isLoadingRef.current = false;
            playbackStateMachine.forceTransition("IDLE");
            heartbeatRef.current?.stop();
            return;
        }

        if (currentMediaId === lastTrackIdRef.current) {
            // Skip if a seek operation is in progress - the seek handler will manage playback
            if (isSeekingRef.current) {
                return;
            }

            const shouldPlay = lastPlayingStateRef.current || isPlaying;
            const isCurrentlyPlaying = howlerEngine.isPlaying();

            if (shouldPlay && !isCurrentlyPlaying) {
                howlerEngine.seek(0);
                howlerEngine.play();
            }
            return;
        }

        if (isLoadingRef.current) {
            // A load is already in progress but a new track was requested.
            // Abort the current load -- the new track takes priority.
            // The engine's load() handles cleanup internally via cleanup(true).
            if (loadListenerRef.current) {
                howlerEngine.off("load", loadListenerRef.current);
                loadListenerRef.current = null;
            }
            if (loadErrorListenerRef.current) {
                howlerEngine.off("loaderror", loadErrorListenerRef.current);
                loadErrorListenerRef.current = null;
            }
            // Clear loading timeout from previous load
            if (loadingTimeoutRef.current) {
                clearTimeout(loadingTimeoutRef.current);
                loadingTimeoutRef.current = null;
            }
        }

        isLoadingRef.current = true;
        lastTrackIdRef.current = currentMediaId;
        loadIdRef.current += 1;
        const thisLoadId = loadIdRef.current;

        // Transition state machine to LOADING
        playbackStateMachine.forceTransition("LOADING");

        // Set loading timeout -- if audio never loads/errors, recover after 30s
        if (loadingTimeoutRef.current) {
            clearTimeout(loadingTimeoutRef.current);
        }
        loadingTimeoutRef.current = setTimeout(() => {
            loadingTimeoutRef.current = null;
            if (playbackStateMachine.isLoading) {
                console.error("[HowlerAudioElement] Load timeout -- recovering from stuck LOADING state");
                playbackStateMachine.forceTransition("ERROR", {
                    error: "Audio failed to load -- request timed out",
                    errorCode: 408,
                });
                setIsPlaying(false);
                setIsBuffering(false);
                isLoadingRef.current = false;
            }
        }, 30000);

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
            podcastDebugLog("load podcast", {
                currentPodcastId: currentPodcast.id,
                podcastId,
                episodeId,
                title: currentPodcast.title,
                podcastTitle: currentPodcast.podcastTitle,
                startTime,
                loadId: thisLoadId,
            });
        }

        if (streamUrl) {
            const wasHowlerPlayingBeforeLoad = howlerEngine.isPlaying();

            const fallbackDuration =
                currentTrack?.duration ||
                currentAudiobook?.duration ||
                currentPodcast?.duration ||
                0;
            setDuration(fallbackDuration);

            const format = getAudioFormat(currentTrack?.filePath);

            howlerEngine.load(streamUrl, false, format);
            if (playbackType === "podcast" && currentPodcast) {
                podcastDebugLog("howlerEngine.load()", {
                    url: streamUrl,
                    format,
                    loadId: thisLoadId,
                });
            }

            // Clean up any previous load listeners before adding new ones
            if (loadListenerRef.current) {
                howlerEngine.off("load", loadListenerRef.current);
                loadListenerRef.current = null;
            }
            if (loadErrorListenerRef.current) {
                howlerEngine.off("loaderror", loadErrorListenerRef.current);
                loadErrorListenerRef.current = null;
            }

            const handleLoaded = () => {
                if (loadIdRef.current !== thisLoadId) return;

                // Clear loading timeout
                if (loadingTimeoutRef.current) {
                    clearTimeout(loadingTimeoutRef.current);
                    loadingTimeoutRef.current = null;
                }

                isLoadingRef.current = false;

                if (startTime > 0) {
                    howlerEngine.seek(startTime);
                }
                if (playbackType === "podcast" && currentPodcast) {
                    podcastDebugLog("loaded", {
                        loadId: thisLoadId,
                        durationHowler: howlerEngine.getDuration(),
                        howlerTime: howlerEngine.getCurrentTime(),
                        actualTime: howlerEngine.getActualCurrentTime(),
                        startTime,
                        canSeek,
                    });
                }

                const shouldAutoPlay =
                    lastPlayingStateRef.current || wasHowlerPlayingBeforeLoad;

                if (shouldAutoPlay) {
                    howlerEngine.play();
                    if (!lastPlayingStateRef.current) {
                        setIsPlaying(true);
                    }
                }

                // Clean up both listeners
                howlerEngine.off("load", handleLoaded);
                howlerEngine.off("loaderror", handleLoadError);
                loadListenerRef.current = null;
                loadErrorListenerRef.current = null;
            };

            const handleLoadError = () => {
                // Clear loading timeout
                if (loadingTimeoutRef.current) {
                    clearTimeout(loadingTimeoutRef.current);
                    loadingTimeoutRef.current = null;
                }

                isLoadingRef.current = false;

                // Ensure state machine leaves LOADING even if the generic
                // handleError doesn't fire (e.g., during effect re-render)
                if (playbackStateMachine.getState() === "LOADING") {
                    playbackStateMachine.forceTransition("ERROR", {
                        error: "Audio failed to load",
                    });
                }

                howlerEngine.off("load", handleLoaded);
                howlerEngine.off("loaderror", handleLoadError);
                loadListenerRef.current = null;
                loadErrorListenerRef.current = null;
            };

            // Store refs for cleanup on unmount
            loadListenerRef.current = handleLoaded;
            loadErrorListenerRef.current = handleLoadError;

            howlerEngine.on("load", handleLoaded);
            howlerEngine.on("loaderror", handleLoadError);
        } else {
            isLoadingRef.current = false;
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- canSeek/isPlaying/setIsPlaying intentionally excluded: adding them would re-trigger audio loading on play/pause or seek state changes, breaking playback
    }, [currentTrack, currentAudiobook, currentPodcast, playbackType, setDuration]);

    // Preload next track for gapless playback (music only)
    useEffect(() => {
        // Only preload for music tracks, not podcasts/audiobooks
        if (playbackType !== "track" || !currentTrack || !isPlaying) {
            return;
        }

        // Clear any pending preload timeout
        if (preloadTimeoutRef.current) {
            clearTimeout(preloadTimeoutRef.current);
            preloadTimeoutRef.current = null;
        }

        const nextTrack = getNextTrackInfo(
            queue,
            currentIndex,
            isShuffle,
            shuffleIndices,
            repeatMode
        );

        // Don't preload if no next track or already preloaded this one
        if (!nextTrack || nextTrack.id === lastPreloadedTrackIdRef.current) {
            return;
        }

        // Preload after 2 seconds of playback to avoid preloading during rapid skipping
        preloadTimeoutRef.current = setTimeout(() => {
            const streamUrl = api.getStreamUrl(nextTrack.id);

            const format = getAudioFormat(nextTrack.filePath);

            howlerEngine.preload(streamUrl, format);
            lastPreloadedTrackIdRef.current = nextTrack.id;
        }, 2000);

        return () => {
            if (preloadTimeoutRef.current) {
                clearTimeout(preloadTimeoutRef.current);
                preloadTimeoutRef.current = null;
            }
        };
    }, [playbackType, currentTrack, isPlaying, queue, currentIndex, isShuffle, shuffleIndices, repeatMode]);

    // Check podcast cache status and control canSeek
    useEffect(() => {
        if (playbackType !== "podcast") {
            setCanSeek(true);
            setDownloadProgress(null);
            if (cacheStatusPollingRef.current) {
                clearInterval(cacheStatusPollingRef.current);
                cacheStatusPollingRef.current = null;
            }
            return;
        }

        if (!currentPodcast) {
            setCanSeek(true);
            return;
        }

        const [podcastId, episodeId] = currentPodcast.id.split(":");

        const checkCacheStatus = async () => {
            try {
                const status = await api.getPodcastEpisodeCacheStatus(
                    podcastId,
                    episodeId
                );

                if (status.cached) {
                    setCanSeek(true);
                    setDownloadProgress(null);
                    if (cacheStatusPollingRef.current) {
                        clearInterval(cacheStatusPollingRef.current);
                        cacheStatusPollingRef.current = null;
                    }
                } else {
                    setCanSeek(false);
                    setDownloadProgress(
                        status.downloadProgress ??
                            (status.downloading ? 0 : null)
                    );
                }

                return status.cached;
            } catch (err) {
                console.error(
                    "[HowlerAudioElement] Failed to check cache status:",
                    err
                );
                setCanSeek(true);
                return true;
            }
        };

        checkCacheStatus();

        cacheStatusPollingRef.current = setInterval(async () => {
            const isCached = await checkCacheStatus();
            if (isCached && cacheStatusPollingRef.current) {
                clearInterval(cacheStatusPollingRef.current);
                cacheStatusPollingRef.current = null;
            }
        }, 5000);

        return () => {
            if (cacheStatusPollingRef.current) {
                clearInterval(cacheStatusPollingRef.current);
                cacheStatusPollingRef.current = null;
            }
        };
    }, [currentPodcast, playbackType, setCanSeek, setDownloadProgress]);

    // Keep lastPlayingStateRef always in sync
    useLayoutEffect(() => {
        lastPlayingStateRef.current = isPlaying;
    }, [isPlaying]);

    // Handle play/pause changes from UI
    // Skip if a track change is in progress -- the track-change effect handles playback.
    // This prevents doubled audio when next() sets both currentTrack and isPlaying simultaneously.
    useEffect(() => {
        if (isLoadingRef.current) return;

        isUserInitiatedRef.current = true;

        if (isPlaying) {
            howlerEngine.play();
        } else {
            howlerEngine.pause();
        }
    }, [isPlaying]);

    // Handle volume changes
    useEffect(() => {
        howlerEngine.setVolume(volume);
    }, [volume]);

    // Handle mute changes
    useEffect(() => {
        howlerEngine.setMuted(isMuted);
    }, [isMuted]);

    // Handle seeking via event emitter
    useEffect(() => {
        // Store previous time to detect large skips vs fine scrubbing
        let previousTime = howlerEngine.getCurrentTime();

        const handleSeek = async (time: number) => {
            // Clear previous seek timeouts to prevent stale callbacks
            if (seekVerifyTimeoutRef.current) {
                clearTimeout(seekVerifyTimeoutRef.current);
                seekVerifyTimeoutRef.current = null;
            }
            if (seekCompleteTimeoutRef.current) {
                clearTimeout(seekCompleteTimeoutRef.current);
                seekCompleteTimeoutRef.current = null;
            }

            // Increment seek operation ID to track this specific seek
            seekOperationIdRef.current += 1;
            const thisSeekId = seekOperationIdRef.current;

            const wasPlayingAtSeekStart = howlerEngine.isPlaying();

            // Detect if this is a large skip (like 30s buttons) vs fine scrubbing
            const timeDelta = Math.abs(time - previousTime);
            const isLargeSkip = timeDelta >= 10; // 10+ seconds = large skip (30s, 15s buttons)
            previousTime = time;

            // DON'T set currentTime here for podcasts - the seek() in audio-controls-context
            // already did it optimistically. Setting it again causes a race condition.
            // We only update it after the seek actually completes.

            if (playbackType === "podcast" && currentPodcast) {
                // Cancel any previous seek-related operations
                if (seekCheckTimeoutRef.current) {
                    clearTimeout(seekCheckTimeoutRef.current);
                    seekCheckTimeoutRef.current = null;
                }

                // Cancel any pending cache polling from previous seek
                if (cachePollingRef.current) {
                    clearInterval(cachePollingRef.current);
                    cachePollingRef.current = null;
                }

                // Cancel previous reload listener
                if (seekReloadListenerRef.current) {
                    howlerEngine.off("load", seekReloadListenerRef.current);
                    seekReloadListenerRef.current = null;
                }

                // Cancel previous cache polling load listener
                if (cachePollingLoadListenerRef.current) {
                    howlerEngine.off(
                        "load",
                        cachePollingLoadListenerRef.current
                    );
                    cachePollingLoadListenerRef.current = null;
                }

                // Cancel any pending debounced seek
                if (seekDebounceRef.current) {
                    clearTimeout(seekDebounceRef.current);
                    seekDebounceRef.current = null;
                }

                // Store the pending seek time - debounce will use the latest value
                pendingSeekTimeRef.current = time;

                const [podcastId, episodeId] = currentPodcast.id.split(":");

                // Execute the seek logic - immediately for large skips, debounced for fine scrubbing
                const executeSeek = async () => {
                    const seekTime = pendingSeekTimeRef.current ?? time;
                    pendingSeekTimeRef.current = null;

                    // Check if this seek is still current
                    if (seekOperationIdRef.current !== thisSeekId) {
                        return;
                    }

                    try {
                        const status = await api.getPodcastEpisodeCacheStatus(
                            podcastId,
                            episodeId
                        );

                        // Check if this seek operation is still current
                        if (seekOperationIdRef.current !== thisSeekId) {
                            podcastDebugLog("seek: aborted (stale operation)", {
                                thisSeekId,
                                currentId: seekOperationIdRef.current,
                            });
                            return;
                        }

                        if (status.cached) {
                            // For cached podcasts, try direct seek first (faster than reload)
                            podcastDebugLog(
                                "seek: cached=true, trying direct seek first",
                                {
                                    time: seekTime,
                                    podcastId,
                                    episodeId,
                                }
                            );

                            // Direct seek - howlerEngine now handles seek locking internally
                            howlerEngine.seek(seekTime);

                            // Verify seek succeeded after a short delay
                            seekVerifyTimeoutRef.current = setTimeout(() => {
                                if (seekOperationIdRef.current !== thisSeekId) {
                                    return;
                                }

                                const actualPos =
                                    howlerEngine.getActualCurrentTime();
                                const seekSucceeded =
                                    Math.abs(actualPos - seekTime) < 5; // Within 5 seconds

                                podcastDebugLog("seek: direct seek result", {
                                    seekTime,
                                    actualPos,
                                    seekSucceeded,
                                });

                                if (!seekSucceeded) {
                                    // Direct seek failed, fall back to reload pattern
                                    podcastDebugLog(
                                        "seek: direct seek failed, falling back to reload"
                                    );
                                    seekReloadInProgressRef.current = true;

                                    howlerEngine.reload();

                                    const onLoad = () => {
                                        howlerEngine.off("load", onLoad);
                                        seekReloadListenerRef.current = null;
                                        seekReloadInProgressRef.current = false;

                                        if (
                                            seekOperationIdRef.current !==
                                            thisSeekId
                                        ) {
                                            return;
                                        }

                                        howlerEngine.seek(seekTime);

                                        if (wasPlayingAtSeekStart && lastPlayingStateRef.current) {
                                            howlerEngine.play();
                                            setIsPlaying(true);
                                        }
                                    };

                                    seekReloadListenerRef.current = onLoad;
                                    howlerEngine.on("load", onLoad);
                                } else {
                                    // Seek succeeded - resume playback if needed (but not if user paused during seek)
                                    if (
                                        wasPlayingAtSeekStart &&
                                        lastPlayingStateRef.current &&
                                        !howlerEngine.isPlaying()
                                    ) {
                                        howlerEngine.play();
                                    }
                                }
                            }, 150);

                            return;
                        }
                    } catch (e) {
                        console.warn(
                            "[HowlerAudioElement] Could not check cache status:",
                            e
                        );
                    }

                    // Check if still current after async operation
                    if (seekOperationIdRef.current !== thisSeekId) {
                        return;
                    }

                    // Not cached - try direct seek
                    howlerEngine.seek(seekTime);

                    // For non-cached streams, we rely on the browser's ability to seek via Range requests.
                    // If that fails, we shouldn't stop playback. We'll just let it try to buffer.
                    // We only check for success to log debug info, but we won't force a pause/poll loop
                    // which caused playback to stop completely in some cases.

                    seekCheckTimeoutRef.current = setTimeout(() => {
                        // Check if this seek is still current
                        if (seekOperationIdRef.current !== thisSeekId) {
                            return;
                        }

                        try {
                            const actualPos =
                                howlerEngine.getActualCurrentTime();
                            // Improved check: if we are more than 5 seconds away from target
                            const seekFailed =
                                Math.abs(actualPos - seekTime) > 5;

                            podcastDebugLog("seek check (streaming)", {
                                time: seekTime,
                                actualPos,
                                seekFailed,
                                podcastId,
                                episodeId,
                            });

                            // If seek failed during streaming, we don't pause.
                            // We assume the browser is buffering or the stream doesn't support seeking.
                            // Pausing here would break playback if the seek just takes a while.
                        } catch (e) {
                            console.error(
                                "[HowlerAudioElement] Seek check error:",
                                e
                            );
                        }
                    }, 2000);
                };

                // For large skips (30s buttons), execute immediately for responsive feel
                // For fine scrubbing (progress bar), debounce to prevent spamming
                if (isLargeSkip) {
                    podcastDebugLog("seek: large skip, executing immediately", {
                        timeDelta,
                        time,
                    });
                    executeSeek();
                } else {
                    podcastDebugLog("seek: fine scrub, debouncing", {
                        timeDelta,
                        time,
                    });
                    seekDebounceRef.current = setTimeout(executeSeek, 150);
                }

                return;
            }

            // For audiobooks and tracks, set seeking flag to prevent load effect interference
            isSeekingRef.current = true;
            howlerEngine.seek(time);

            // Reset seeking flag after a short delay to allow seek to complete
            seekCompleteTimeoutRef.current = setTimeout(() => {
                isSeekingRef.current = false;
            }, 100);
        };

        const unsubscribe = audioSeekEmitter.subscribe(handleSeek);
        return unsubscribe;
    }, [playbackType, currentPodcast, setIsBuffering, setTargetSeekPosition, setIsPlaying]);

    // Cleanup cache polling, seek timeouts, and seek-reload listener on unmount
    useEffect(() => {
        return () => {
            if (cachePollingRef.current) {
                clearInterval(cachePollingRef.current);
            }
            if (seekCheckTimeoutRef.current) {
                clearTimeout(seekCheckTimeoutRef.current);
            }
            if (seekVerifyTimeoutRef.current) {
                clearTimeout(seekVerifyTimeoutRef.current);
            }
            if (seekCompleteTimeoutRef.current) {
                clearTimeout(seekCompleteTimeoutRef.current);
            }
            if (seekReloadListenerRef.current) {
                howlerEngine.off("load", seekReloadListenerRef.current);
                seekReloadListenerRef.current = null;
            }
            if (seekDebounceRef.current) {
                clearTimeout(seekDebounceRef.current);
                seekDebounceRef.current = null;
            }
        };
    }, []);

    // Periodic progress saving for audiobooks and podcasts
    useEffect(() => {
        if (playbackType !== "audiobook" && playbackType !== "podcast") {
            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
                progressSaveIntervalRef.current = null;
            }
            return;
        }

        if (!isPlaying) {
            if (playbackType === "audiobook") {
                saveAudiobookProgress();
            } else if (playbackType === "podcast") {
                savePodcastProgress();
            }
        }

        if (isPlaying) {
            // Clear any existing interval before creating a new one
            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
            }
            progressSaveIntervalRef.current = setInterval(() => {
                if (playbackType === "audiobook") {
                    saveAudiobookProgress();
                } else if (playbackType === "podcast") {
                    savePodcastProgress();
                }
            }, 30000);
        }

        return () => {
            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
                progressSaveIntervalRef.current = null;
            }
        };
    }, [playbackType, isPlaying, saveAudiobookProgress, savePodcastProgress]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            // Save final progress before cleanup
            if (playbackTypeRef.current === "audiobook") {
                saveAudiobookProgressRef.current();
            } else if (playbackTypeRef.current === "podcast") {
                savePodcastProgressRef.current();
            }

            howlerEngine.cleanup(true);

            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
            }
            // Clean up all listener refs to prevent memory leaks
            if (loadListenerRef.current) {
                howlerEngine.off("load", loadListenerRef.current);
                loadListenerRef.current = null;
            }
            if (loadErrorListenerRef.current) {
                howlerEngine.off("loaderror", loadErrorListenerRef.current);
                loadErrorListenerRef.current = null;
            }
            if (cachePollingLoadListenerRef.current) {
                howlerEngine.off("load", cachePollingLoadListenerRef.current);
                cachePollingLoadListenerRef.current = null;
            }
            if (loadingTimeoutRef.current) {
                clearTimeout(loadingTimeoutRef.current);
            }
            // Clean up preload refs
            if (preloadTimeoutRef.current) {
                clearTimeout(preloadTimeoutRef.current);
            }
            lastPreloadedTrackIdRef.current = null;
        };
    }, []);

    // This component doesn't render anything visible
    return null;
});
