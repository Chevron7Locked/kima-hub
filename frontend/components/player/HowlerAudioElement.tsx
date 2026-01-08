"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api } from "@/lib/api";
import { howlerEngine } from "@/lib/howler-engine";
import { audioSeekEmitter } from "@/lib/audio-seek-emitter";
import { dispatchQueryEvent } from "@/lib/query-events";
import {
    useEffect,
    useLayoutEffect,
    useRef,
    memo,
    useCallback,
    useMemo,
} from "react";

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
    } = useAudioState();

    // Playback context
    const {
        isPlaying,
        setCurrentTime,
        setCurrentTimeFromEngine,
        setDuration,
        setIsPlaying,
        isBuffering,
        setIsBuffering,
        setTargetSeekPosition,
        canSeek,
        setCanSeek,
        setDownloadProgress,
        lockSeek,
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

    // Reset duration when nothing is playing
    useEffect(() => {
        if (!currentTrack && !currentAudiobook && !currentPodcast) {
            setDuration(0);
        }
    }, [currentTrack, currentAudiobook, currentPodcast, setDuration]);

    // Subscribe to Howler events
    useEffect(() => {
        const handleTimeUpdate = (data: { time: number }) => {
            // Use setCurrentTimeFromEngine to respect seek lock
            // This prevents stale timeupdate events from overwriting optimistic seek updates
            setCurrentTimeFromEngine(data.time);
        };

        const handleLoad = (data: { duration: number }) => {
            const fallbackDuration =
                currentTrack?.duration ||
                currentAudiobook?.duration ||
                currentPodcast?.duration ||
                0;
            setDuration(data.duration || fallbackDuration);
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

        const handleError = (data: { error: any }) => {
            console.error("[HowlerAudioElement] Playback error:", data.error);
            setIsPlaying(false);
            isUserInitiatedRef.current = false;

            if (playbackType === "track") {
                if (queue.length > 1) {
                    console.log(
                        "[HowlerAudioElement] Track failed, trying next in queue"
                    );
                    lastTrackIdRef.current = null;
                    isLoadingRef.current = false;
                    next();
                } else {
                    console.log(
                        "[HowlerAudioElement] Track failed, no more in queue - clearing"
                    );
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
            if (!isUserInitiatedRef.current) {
                setIsPlaying(true);
            }
            isUserInitiatedRef.current = false;
        };

        const handlePause = () => {
            if (isLoadingRef.current) return;
            if (seekReloadInProgressRef.current) return;

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
    }, [playbackType, currentTrack, currentAudiobook, currentPodcast, repeatMode, next, nextPodcastEpisode, pause, setCurrentTimeFromEngine, setDuration, setIsPlaying, queue, setCurrentTrack, setCurrentAudiobook, setCurrentPodcast, setPlaybackType]);

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

                setCurrentAudiobook({
                    ...currentAudiobook,
                    progress: {
                        currentTime: isFinished ? duration : currentTime,
                        progress:
                            duration > 0
                                ? ((isFinished ? duration : currentTime) /
                                      duration) *
                                  100
                                : 0,
                        isFinished,
                        lastPlayedAt: new Date(),
                    },
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

        if (isLoadingRef.current) return;

        isLoadingRef.current = true;
        lastTrackIdRef.current = currentMediaId;
        loadIdRef.current += 1;
        const thisLoadId = loadIdRef.current;

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

            let format = "mp3";
            const filePath = currentTrack?.filePath || "";
            if (filePath) {
                const ext = filePath.split(".").pop()?.toLowerCase();
                if (ext === "flac") format = "flac";
                else if (ext === "m4a" || ext === "aac") format = "mp4";
                else if (ext === "ogg" || ext === "opus") format = "webm";
                else if (ext === "wav") format = "wav";
            }

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
                isLoadingRef.current = false;
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
    }, [currentTrack, currentAudiobook, currentPodcast, playbackType, setDuration]);

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

    // Poll for podcast cache and reload when ready
    const startCachePolling = useCallback(
        (podcastId: string, episodeId: string, targetTime: number) => {
            // Capture the current seek operation ID
            const pollingSeekId = seekOperationIdRef.current;

            if (cachePollingRef.current) {
                clearInterval(cachePollingRef.current);
            }

            let pollCount = 0;
            const maxPolls = 60;

            cachePollingRef.current = setInterval(async () => {
                // Check if a newer seek operation has started
                if (seekOperationIdRef.current !== pollingSeekId) {
                    if (cachePollingRef.current) {
                        clearInterval(cachePollingRef.current);
                        cachePollingRef.current = null;
                    }
                    podcastDebugLog("cache polling aborted (stale)", {
                        pollingSeekId,
                        currentId: seekOperationIdRef.current,
                    });
                    return;
                }

                pollCount++;

                try {
                    const status = await api.getPodcastEpisodeCacheStatus(
                        podcastId,
                        episodeId
                    );

                    // Re-check after async operation
                    if (seekOperationIdRef.current !== pollingSeekId) {
                        if (cachePollingRef.current) {
                            clearInterval(cachePollingRef.current);
                            cachePollingRef.current = null;
                        }
                        return;
                    }

                    podcastDebugLog("cache poll", {
                        podcastId,
                        episodeId,
                        pollCount,
                        cached: status.cached,
                        downloading: status.downloading,
                        downloadProgress: status.downloadProgress,
                        targetTime,
                    });

                    if (status.cached) {
                        if (cachePollingRef.current) {
                            clearInterval(cachePollingRef.current);
                            cachePollingRef.current = null;
                        }

                        podcastDebugLog(
                            "cache ready -> howlerEngine.reload()",
                            {
                                podcastId,
                                episodeId,
                                targetTime,
                            }
                        );
                        // Clean up any previous cache polling load listener
                        if (cachePollingLoadListenerRef.current) {
                            howlerEngine.off(
                                "load",
                                cachePollingLoadListenerRef.current
                            );
                            cachePollingLoadListenerRef.current = null;
                        }

                        howlerEngine.reload();

                        const onLoad = () => {
                            howlerEngine.off("load", onLoad);
                            cachePollingLoadListenerRef.current = null;

                            // Check if still current before acting
                            if (seekOperationIdRef.current !== pollingSeekId) {
                                podcastDebugLog(
                                    "cache polling load callback aborted (stale)",
                                    { pollingSeekId }
                                );
                                return;
                            }

                            howlerEngine.seek(targetTime);
                            setCurrentTime(targetTime);
                            howlerEngine.play();
                            podcastDebugLog("post-reload seek+play", {
                                podcastId,
                                episodeId,
                                targetTime,
                                howlerTime: howlerEngine.getCurrentTime(),
                                actualTime: howlerEngine.getActualCurrentTime(),
                            });

                            setIsBuffering(false);
                            setTargetSeekPosition(null);
                            setIsPlaying(true);
                        };

                        cachePollingLoadListenerRef.current = onLoad;
                        howlerEngine.on("load", onLoad);
                    } else if (pollCount >= maxPolls) {
                        if (cachePollingRef.current) {
                            clearInterval(cachePollingRef.current);
                            cachePollingRef.current = null;
                        }

                        console.warn(
                            "[HowlerAudioElement] Cache polling timeout"
                        );
                        setIsBuffering(false);
                        setTargetSeekPosition(null);
                    }
                } catch (error) {
                    console.error(
                        "[HowlerAudioElement] Cache polling error:",
                        error
                    );
                }
            }, 2000);
        },
        [setCurrentTime, setIsBuffering, setTargetSeekPosition, setIsPlaying]
    );

    // Handle seeking via event emitter
    useEffect(() => {
        // Store previous time to detect large skips vs fine scrubbing
        let previousTime = howlerEngine.getCurrentTime();
        
        const handleSeek = async (time: number) => {
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
                            setTimeout(() => {
                                if (seekOperationIdRef.current !== thisSeekId) {
                                    return;
                                }
                                
                                const actualPos = howlerEngine.getActualCurrentTime();
                                const seekSucceeded = Math.abs(actualPos - seekTime) < 5; // Within 5 seconds
                                
                                podcastDebugLog("seek: direct seek result", {
                                    seekTime,
                                    actualPos,
                                    seekSucceeded,
                                });
                                
                                if (!seekSucceeded) {
                                    // Direct seek failed, fall back to reload pattern
                                    podcastDebugLog("seek: direct seek failed, falling back to reload");
                                    seekReloadInProgressRef.current = true;

                                    howlerEngine.reload();

                                    const onLoad = () => {
                                        howlerEngine.off("load", onLoad);
                                        seekReloadListenerRef.current = null;
                                        seekReloadInProgressRef.current = false;

                                        if (seekOperationIdRef.current !== thisSeekId) {
                                            return;
                                        }

                                        howlerEngine.seek(seekTime);

                                        if (wasPlayingAtSeekStart) {
                                            howlerEngine.play();
                                            setIsPlaying(true);
                                        }
                                    };

                                    seekReloadListenerRef.current = onLoad;
                                    howlerEngine.on("load", onLoad);
                                } else {
                                    // Seek succeeded - resume playback if needed
                                    if (wasPlayingAtSeekStart && !howlerEngine.isPlaying()) {
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

                    seekCheckTimeoutRef.current = setTimeout(() => {
                        // Check if this seek is still current
                        if (seekOperationIdRef.current !== thisSeekId) {
                            return;
                        }

                        try {
                            const actualPos = howlerEngine.getActualCurrentTime();
                            const seekFailed = seekTime > 30 && actualPos < 30;
                            podcastDebugLog("seek check", {
                                time: seekTime,
                                actualPos,
                                seekFailed,
                                podcastId,
                                episodeId,
                            });

                            if (seekFailed) {
                                howlerEngine.pause();
                                setIsBuffering(true);
                                setTargetSeekPosition(seekTime);
                                setIsPlaying(false);
                                startCachePolling(podcastId, episodeId, seekTime);
                            }
                        } catch (e) {
                            console.error(
                                "[HowlerAudioElement] Seek check error:",
                                e
                            );
                        }
                    }, 1000);
                };
                
                // For large skips (30s buttons), execute immediately for responsive feel
                // For fine scrubbing (progress bar), debounce to prevent spamming
                if (isLargeSkip) {
                    podcastDebugLog("seek: large skip, executing immediately", { timeDelta, time });
                    executeSeek();
                } else {
                    podcastDebugLog("seek: fine scrub, debouncing", { timeDelta, time });
                    seekDebounceRef.current = setTimeout(executeSeek, 150);
                }
                
                return;
            }

            // For audiobooks and tracks, set seeking flag to prevent load effect interference
            isSeekingRef.current = true;
            howlerEngine.seek(time);

            // Reset seeking flag after a short delay to allow seek to complete
            setTimeout(() => {
                isSeekingRef.current = false;
            }, 100);
        };

        const unsubscribe = audioSeekEmitter.subscribe(handleSeek);
        return unsubscribe;
    }, [playbackType, currentPodcast, setIsBuffering, setTargetSeekPosition, setIsPlaying, startCachePolling]);

    // Cleanup cache polling, seek timeout, and seek-reload listener on unmount
    useEffect(() => {
        return () => {
            if (cachePollingRef.current) {
                clearInterval(cachePollingRef.current);
            }
            if (seekCheckTimeoutRef.current) {
                clearTimeout(seekCheckTimeoutRef.current);
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
            howlerEngine.stop();

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
        };
    }, []);

    // This component doesn't render anything visible
    return null;
});
