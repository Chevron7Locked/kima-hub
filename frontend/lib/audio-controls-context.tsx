"use client";

import {
    createContext,
    useContext,
    useCallback,
    useRef,
    useEffect,
    useLayoutEffect,
    useState,
    ReactNode,
    useMemo,
} from "react";
import {
    useAudioState,
    Track,
    Audiobook,
    Podcast,
    PlayerMode,
    VibeOperation,
} from "./audio-state-context";
import { OperationConfirmToast } from "@/components/ui/OperationConfirmToast";
import { useAudioPlayback } from "./audio-playback-context";
import { api } from "@/lib/api";
import { useAudioController } from "./audio-controller-context";
import { dispatchQueryEvent } from "@/lib/query-events";

interface AudioControlsContextType {
    // Track methods
    playTrack: (track: Track) => void;
    playTracks: (tracks: Track[], startIndex?: number) => void;

    // Audiobook methods
    playAudiobook: (audiobook: Audiobook) => void;

    // Podcast methods
    playPodcast: (podcast: Podcast) => void;
    nextPodcastEpisode: () => void;

    // Playback controls
    pause: () => void;
    resume: () => void;
    resumeWithGesture: () => void;
    next: () => void;
    previous: () => void;

    // Queue controls
    addToQueue: (track: Track) => void;
    removeFromQueue: (index: number) => void;
    clearQueue: () => void;
    setUpcoming: (tracks: Track[], preserveOrder?: boolean) => void;

    // Playback modes
    toggleShuffle: () => void;
    toggleRepeat: () => void;

    // Time controls
    updateCurrentTime: (time: number) => void;
    seek: (time: number) => void;
    skipForward: (seconds?: number) => void;
    skipBackward: (seconds?: number) => void;

    // Player mode controls
    setPlayerMode: (mode: PlayerMode) => void;
    returnToPreviousMode: () => void;

    // Volume controls
    setVolume: (volume: number) => void;
    toggleMute: () => void;

    // Vibe mode controls
    startVibeMode: () => Promise<{ success: boolean; trackCount: number }>;
    stopVibeMode: () => void;
    replaceOperation: (
        newOp: VibeOperation,
        queue: Track[],
        startIndex?: number,
    ) => Promise<boolean>;
}

const AudioControlsContext = createContext<
    AudioControlsContextType | undefined
>(undefined);

function getNextTrackInfo(
    queue: { id: string }[],
    currentIndex: number,
    isShuffle: boolean,
    shuffleIndices: number[],
    repeatMode: "off" | "one" | "all"
): { id: string } | null {
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

export function AudioControlsProvider({ children }: { children: ReactNode }) {
    const state = useAudioState();
    const playback = useAudioPlayback();

    const controller = useAudioController();
    const controllerRef = useRef(controller);
    useEffect(() => { controllerRef.current = controller; }, [controller]);

    const currentTimeRef = useRef(playback.currentTime);
    useEffect(() => {
        currentTimeRef.current = playback.currentTime;
    }, [playback.currentTime]);
    const currentIndexRef = useRef(state.currentIndex);
    useEffect(() => {
        currentIndexRef.current = state.currentIndex;
    }, [state.currentIndex]);
    const upNextInsertRef = useRef<number>(0);
    const shuffleInsertPosRef = useRef<number>(0);
    const lastQueueInsertAtRef = useRef<number | null>(null);
    const lastCursorTrackIndexRef = useRef<number | null>(null);
    const lastCursorIsShuffleRef = useRef<boolean | null>(null);

    // Skip button debouncing: accumulate rapid clicks into a single seek
    const skipAccumulatorRef = useRef<number>(0);
    const skipBaseTimeRef = useRef<number>(0);
    const skipDebounceRef = useRef<NodeJS.Timeout | null>(null);
    // Stable ref for setCurrentTime to avoid adding unstable `playback` to skip deps
    const setCurrentTimeRef = useRef(playback.setCurrentTime);

    // Refs for ended/canplay/error handlers
    const pendingStartTimeRef = useRef<number>(0);
    const playbackTypeRef = useRef(state.playbackType);
    const currentTrackRef = useRef(state.currentTrack);
    const currentAudiobookRef = useRef(state.currentAudiobook);
    const currentPodcastRef = useRef(state.currentPodcast);
    const repeatModeRef = useRef(state.repeatMode);
    const queueRef = useRef(state.queue);
    const isShuffleRef = useRef(state.isShuffle);
    const shuffleIndicesRef = useRef(state.shuffleIndices);
    const consecutiveErrorCountRef = useRef(0);
    const justFinishedRef = useRef(false);
    const lastSaveTimeRef = useRef(0);

    // Keep a stable "Up Next" insertion cursor like Spotify:
    // - When the current track changes, reset to "right after current"
    // - Each addToQueue inserts at the cursor and advances it
    useEffect(() => {
        if (state.playbackType !== "track") {
            upNextInsertRef.current = 0;
            shuffleInsertPosRef.current = 0;
            lastCursorTrackIndexRef.current = null;
            lastCursorIsShuffleRef.current = null;
            return;
        }
        const prevIdx = lastCursorTrackIndexRef.current;
        const prevShuffle = lastCursorIsShuffleRef.current;
        const trackChanged = prevIdx !== state.currentIndex;
        const shuffleToggled = prevShuffle !== state.isShuffle;

        // Up-next cursor should never move backwards unless track changes / shuffle toggles
        const baseUpNext = state.currentIndex + 1;
        upNextInsertRef.current =
            trackChanged || shuffleToggled
                ? baseUpNext
                : Math.max(upNextInsertRef.current, baseUpNext);

        if (state.isShuffle) {
            const currentShufflePos = state.shuffleIndices.indexOf(
                state.currentIndex
            );
            const baseShufflePos =
                currentShufflePos >= 0 ? currentShufflePos + 1 : 0;
            // Do NOT reset to base on every shuffleIndices update; only move forward.
            shuffleInsertPosRef.current =
                trackChanged || shuffleToggled
                    ? baseShufflePos
                    : Math.max(shuffleInsertPosRef.current, baseShufflePos);
        } else {
            shuffleInsertPosRef.current = 0;
        }

        lastCursorTrackIndexRef.current = state.currentIndex;
        lastCursorIsShuffleRef.current = state.isShuffle;
    }, [
        state.currentIndex,
        state.playbackType,
        state.isShuffle,
        state.shuffleIndices,
        state.queue.length,
    ]);

    // Generate shuffled indices
    const generateShuffleIndices = useCallback(
        (length: number, currentIdx: number) => {
            const indices = Array.from({ length }, (_, i) => i).filter(
                (i) => i !== currentIdx
            );
            for (let i = indices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [indices[i], indices[j]] = [indices[j], indices[i]];
            }
            return [currentIdx, ...indices];
        },
        []
    );

    const playTrack = useCallback(
        (track: Track) => {
            if (state.activeOperation.type !== 'idle') {
                const opTrackIds = 'trackIds' in state.activeOperation
                    ? state.activeOperation.trackIds
                    : 'pathTrackIds' in state.activeOperation
                        ? state.activeOperation.pathTrackIds
                        : 'resultTrackIds' in state.activeOperation
                            ? state.activeOperation.resultTrackIds
                            : [];
                if (!opTrackIds.includes(track.id)) {
                    state.setActiveOperation({ type: 'idle' });
                }
            }

            state.setPlaybackType("track");
            state.setCurrentTrack(track);
            state.setCurrentAudiobook(null);
            state.setCurrentPodcast(null);
            state.setPodcastEpisodeQueue(null);
            state.setQueue([track]);
            state.setCurrentIndex(0);
            setCurrentTimeRef.current(0);
            state.setShuffleIndices([0]);
            state.setRepeatOneCount(0);

            const streamUrl = api.getStreamUrl(track.id);
            controllerRef.current?.load(streamUrl, true);
        },
        [state]
    );

    const playTracks = useCallback(
        (tracks: Track[], startIndex = 0, { skipOperationCheck = false } = {}) => {
            if (tracks.length === 0) return;

            if (!skipOperationCheck && state.activeOperation.type !== 'idle') {
                const opTrackIds = 'trackIds' in state.activeOperation
                    ? state.activeOperation.trackIds
                    : 'pathTrackIds' in state.activeOperation
                        ? state.activeOperation.pathTrackIds
                        : 'resultTrackIds' in state.activeOperation
                            ? state.activeOperation.resultTrackIds
                            : [];
                if (!opTrackIds.includes(tracks[startIndex]?.id)) {
                    state.setActiveOperation({ type: 'idle' });
                }
            }

            state.setPlaybackType("track");
            state.setCurrentAudiobook(null);
            state.setCurrentPodcast(null);
            state.setPodcastEpisodeQueue(null);
            state.setQueue(tracks);
            state.setCurrentIndex(startIndex);
            state.setCurrentTrack(tracks[startIndex]);
            setCurrentTimeRef.current(0);
            state.setRepeatOneCount(0);
            state.setShuffleIndices(
                generateShuffleIndices(tracks.length, startIndex)
            );

            const streamUrl = api.getStreamUrl(tracks[startIndex].id);
            controllerRef.current?.load(streamUrl, true);
        },
        [state, generateShuffleIndices]
    );

    const playAudiobook = useCallback(
        (audiobook: Audiobook) => {
            state.setPlaybackType("audiobook");
            state.setCurrentTrack(null);
            state.setCurrentPodcast(null);
            state.setPodcastEpisodeQueue(null);
            state.setQueue([]);
            state.setCurrentIndex(0);
            state.setShuffleIndices([]);

            const totalBookStartTime = audiobook.progress?.currentTime ?? 0;
            const tracks = audiobook.tracks ?? [];

            let startTrackIndex = 0;
            let trackStartOffset = 0;
            if (tracks.length > 1) {
                for (const t of tracks) {
                    if (t.startOffset <= totalBookStartTime) {
                        startTrackIndex = t.index;
                        trackStartOffset = t.startOffset;
                    }
                }
            }
            const withinTrackStartTime = totalBookStartTime - trackStartOffset;

            state.setCurrentAudiobook({ ...audiobook, trackIndex: startTrackIndex, trackOffset: trackStartOffset });
            pendingStartTimeRef.current = withinTrackStartTime;
            setCurrentTimeRef.current(totalBookStartTime);

            controllerRef.current?.load(api.getAudiobookStreamUrl(audiobook.id, startTrackIndex), true);
        },
        [state]
    );

    const playPodcast = useCallback(
        (podcast: Podcast) => {
            state.setPlaybackType("podcast");
            state.setCurrentPodcast(podcast);
            state.setCurrentTrack(null);
            state.setCurrentAudiobook(null);
            state.setQueue([]);
            state.setCurrentIndex(0);
            state.setShuffleIndices([]);

            const startTime = podcast.progress?.currentTime || 0;
            pendingStartTimeRef.current = startTime;
            setCurrentTimeRef.current(startTime);

            const [podcastId, episodeId] = podcast.id.split(":");
            const streamUrl = api.getPodcastEpisodeStreamUrl(podcastId, episodeId);
            controllerRef.current?.load(streamUrl, true);
        },
        [state]
    );

    const pause = useCallback(() => {
        controllerRef.current?.pause();
    }, []);

    const nextPodcastEpisode = useCallback(() => {
        if (!state.podcastEpisodeQueue || state.podcastEpisodeQueue.length === 0) {
            pause();
            return;
        }

        if (!state.currentPodcast) {
            pause();
            return;
        }

        const [podcastId, currentEpisodeId] = state.currentPodcast.id.split(":");

        const currentIndex = state.podcastEpisodeQueue.findIndex(
            (ep) => ep.id === currentEpisodeId
        );

        if (currentIndex >= 0 && currentIndex < state.podcastEpisodeQueue.length - 1) {
            const nextEpisode = state.podcastEpisodeQueue[currentIndex + 1];
            playPodcast({
                id: `${podcastId}:${nextEpisode.id}`,
                title: nextEpisode.title,
                podcastTitle: state.currentPodcast.podcastTitle,
                coverUrl: state.currentPodcast.coverUrl,
                duration: nextEpisode.duration,
                progress: nextEpisode.progress || null,
            });
        } else {
            pause();
            state.setPodcastEpisodeQueue(null);
        }
    }, [state, playPodcast, pause]);

    const loadRestoredState = useCallback(() => {
        const ctrl = controllerRef.current;
        if (!ctrl || ctrl.getState().currentSrc) return false;

        if (state.playbackType === "track" && state.currentTrack) {
            ctrl.load(api.getStreamUrl(state.currentTrack.id));
            return true;
        }
        if (state.playbackType === "audiobook" && state.currentAudiobook) {
            const totalBookStartTime = state.currentAudiobook.progress?.currentTime ?? 0;
            const trackIndex = state.currentAudiobook.trackIndex ?? 0;
            const trackOffset = state.currentAudiobook.trackOffset ?? 0;
            pendingStartTimeRef.current = totalBookStartTime - trackOffset;
            playback.setCurrentTime(totalBookStartTime);
            ctrl.load(api.getAudiobookStreamUrl(state.currentAudiobook.id, trackIndex));
            return true;
        }
        if (state.playbackType === "podcast" && state.currentPodcast) {
            const startTime = state.currentPodcast.progress?.currentTime || 0;
            pendingStartTimeRef.current = startTime;
            playback.setCurrentTime(startTime);
            const [podcastId, episodeId] = state.currentPodcast.id.split(":");
            ctrl.load(api.getPodcastEpisodeStreamUrl(podcastId, episodeId));
            return true;
        }
        return false;
    }, [state.playbackType, state.currentTrack, state.currentAudiobook, state.currentPodcast, playback]);

    const resume = useCallback(() => {
        loadRestoredState();
        controllerRef.current?.play();
    }, [loadRestoredState]);

    const resumeWithGesture = useCallback(() => {
        loadRestoredState();
        controllerRef.current?.play();
    }, [loadRestoredState]);

    const seek = useCallback(
        (time: number) => {
            const mediaDuration =
                state.playbackType === "podcast"
                    ? state.currentPodcast?.duration || 0
                    : state.playbackType === "audiobook"
                    ? state.currentAudiobook?.duration || 0
                    : state.currentTrack?.duration || 0;
            const isMultiTrack = state.playbackType === "audiobook" && (state.currentAudiobook?.tracks?.length ?? 0) > 1;
            const maxDuration = isMultiTrack
                ? mediaDuration
                : mediaDuration > 0 && playback.duration > 0
                    ? Math.min(mediaDuration, playback.duration)
                    : mediaDuration || playback.duration || 0;
            const clampedTime =
                maxDuration > 0
                    ? Math.min(Math.max(time, 0), maxDuration)
                    : Math.max(time, 0);

            setCurrentTimeRef.current(clampedTime);

            if (state.playbackType === "audiobook" && state.currentAudiobook) {
                const tracks = state.currentAudiobook.tracks;
                if (tracks && tracks.length > 1) {
                    let targetTrack = tracks[0];
                    for (const t of tracks) {
                        if (t.startOffset <= clampedTime) targetTrack = t;
                    }
                    const withinTrackTime = clampedTime - targetTrack.startOffset;
                    const currentTrackIdx = state.currentAudiobook.trackIndex ?? 0;

                    state.setCurrentAudiobook((prev) => prev ? {
                        ...prev,
                        trackIndex: targetTrack.index,
                        trackOffset: targetTrack.startOffset,
                        progress: {
                            currentTime: clampedTime,
                            progress: prev.duration > 0 ? (clampedTime / prev.duration) * 100 : 0,
                            isFinished: false,
                            lastPlayedAt: new Date(),
                        },
                    } : prev);

                    if (targetTrack.index !== currentTrackIdx) {
                        const wasPlaying = controllerRef.current?.isPlaying() ?? false;
                        pendingStartTimeRef.current = withinTrackTime;
                        controllerRef.current?.load(api.getAudiobookStreamUrl(state.currentAudiobook.id, targetTrack.index), wasPlaying);
                    } else {
                        controllerRef.current?.seek(withinTrackTime);
                    }
                } else {
                    state.setCurrentAudiobook((prev) => {
                        if (!prev) return prev;
                        const duration = prev.duration || 0;
                        const progressPercent =
                            duration > 0 ? (clampedTime / duration) * 100 : 0;
                        return {
                            ...prev,
                            progress: {
                                currentTime: clampedTime,
                                progress: progressPercent,
                                isFinished: false,
                                lastPlayedAt: new Date(),
                            },
                        };
                    });
                    controllerRef.current?.seek(clampedTime);
                }
            } else if (
                state.playbackType === "podcast" &&
                state.currentPodcast
            ) {
                state.setCurrentPodcast((prev) => {
                    if (!prev) return prev;
                    const duration = prev.duration || 0;
                    const progressPercent =
                        duration > 0 ? (clampedTime / duration) * 100 : 0;
                    return {
                        ...prev,
                        progress: {
                            currentTime: clampedTime,
                            progress: progressPercent,
                            isFinished: false,
                            lastPlayedAt: new Date(),
                        },
                    };
                });
                controllerRef.current?.seek(clampedTime);
            } else {
                controllerRef.current?.seek(clampedTime);
            }
        },
        [state, playback.duration]
    );

    const next = useCallback(() => {
        if (state.queue.length === 0) return;

        if (state.repeatMode === "one" && state.repeatOneCount === 0) {
            state.setRepeatOneCount(1);
            seek(0);
            return;
        }

        state.setRepeatOneCount(0);

        let nextIndex: number;
        if (state.isShuffle) {
            const currentShufflePos = state.shuffleIndices.indexOf(
                state.currentIndex
            );
            if (currentShufflePos < state.shuffleIndices.length - 1) {
                nextIndex = state.shuffleIndices[currentShufflePos + 1];
            } else {
                if (state.repeatMode === "all") {
                    nextIndex = state.shuffleIndices[0];
                } else {
                    controllerRef.current?.pause();
                    return;
                }
            }
        } else {
            if (state.currentIndex < state.queue.length - 1) {
                nextIndex = state.currentIndex + 1;
            } else {
                if (state.repeatMode === "all") {
                    nextIndex = 0;
                } else {
                    controllerRef.current?.pause();
                    return;
                }
            }
        }

        state.setCurrentIndex(nextIndex);
        state.setCurrentTrack(state.queue[nextIndex]);
        setCurrentTimeRef.current(0);

        const streamUrl = api.getStreamUrl(state.queue[nextIndex].id);
        controllerRef.current?.load(streamUrl, true);
    }, [state, seek]);

    const previous = useCallback(() => {
        if (state.queue.length === 0) return;

        if (currentTimeRef.current > 3) {
            setCurrentTimeRef.current(0);
            seek(0);
            return;
        }

        state.setRepeatOneCount(0);

        let prevIndex: number;
        if (state.isShuffle) {
            const currentShufflePos = state.shuffleIndices.indexOf(
                state.currentIndex
            );
            if (currentShufflePos > 0) {
                prevIndex = state.shuffleIndices[currentShufflePos - 1];
            } else {
                setCurrentTimeRef.current(0);
                seek(0);
                return;
            }
        } else {
            if (state.currentIndex > 0) {
                prevIndex = state.currentIndex - 1;
            } else {
                setCurrentTimeRef.current(0);
                seek(0);
                return;
            }
        }

        state.setCurrentIndex(prevIndex);
        state.setCurrentTrack(state.queue[prevIndex]);
        setCurrentTimeRef.current(0);

        const streamUrl = api.getStreamUrl(state.queue[prevIndex].id);
        controllerRef.current?.load(streamUrl, true);
    }, [state, seek]);

    const addToQueue = useCallback(
        (track: Track) => {
            if (state.queue.length === 0 || state.playbackType !== "track") {
                state.setPlaybackType("track");
                state.setQueue([track]);
                state.setCurrentIndex(0);
                state.setCurrentTrack(track);
                state.setCurrentAudiobook(null);
                state.setCurrentPodcast(null);
                setCurrentTimeRef.current(0);
                state.setShuffleIndices([0]);

                const streamUrl = api.getStreamUrl(track.id);
                controllerRef.current?.load(streamUrl, true);
                return;
            }

            const playingIdx = state.currentIndex;
            const plannedInsertAt = upNextInsertRef.current;

            state.setQueue((prevQueue) => {
                const insertAt = Math.min(
                    Math.max(0, plannedInsertAt),
                    prevQueue.length
                );
                const newQueue = [...prevQueue];
                newQueue.splice(insertAt, 0, track);
                upNextInsertRef.current = insertAt + 1;
                lastQueueInsertAtRef.current = insertAt;

                return newQueue;
            });

            if (state.isShuffle) {
                state.setShuffleIndices((prevIndices) => {
                    if (prevIndices.length === 0) return prevIndices;
                    const insertAtCandidate =
                        lastQueueInsertAtRef.current ?? plannedInsertAt;
                    const insertAt = Math.min(
                        Math.max(0, insertAtCandidate),
                        state.queue.length
                    );
                    const shifted = prevIndices.map((i) =>
                        i >= insertAt ? i + 1 : i
                    );
                    const currentShufflePos = shifted.indexOf(playingIdx);
                    const baseInsertPos =
                        currentShufflePos >= 0 ? currentShufflePos + 1 : 0;
                    const insertPos = Math.min(
                        Math.max(baseInsertPos, shuffleInsertPosRef.current),
                        shifted.length
                    );
                    const newIndices = [...shifted];
                    newIndices.splice(insertPos, 0, insertAt);
                    shuffleInsertPosRef.current = insertPos + 1;

                    return newIndices;
                });
            }
        },
        [state]
    );

    const removeFromQueue = useCallback(
        (index: number) => {
            state.setQueue((prev) => {
                const newQueue = [...prev];
                newQueue.splice(index, 1);

                const curIdx = currentIndexRef.current;

                if (index < curIdx) {
                    state.setCurrentIndex((prevIndex) => prevIndex - 1);
                } else if (index === curIdx) {
                    if (newQueue.length === 0) {
                        state.setCurrentTrack(null);
                        controllerRef.current?.pause();
                    } else if (index >= newQueue.length) {
                        state.setCurrentIndex(0);
                        state.setCurrentTrack(newQueue[0]);
                    } else {
                        state.setCurrentTrack(newQueue[index]);
                    }
                }

                return newQueue;
            });

            if (state.isShuffle) {
                state.setShuffleIndices((prev) => {
                    return prev
                        .filter((i) => i !== index)
                        .map((i) => (i > index ? i - 1 : i));
                });
            }
        },
        [state]
    );

    const clearQueue = useCallback(() => {
        state.setQueue([]);
        state.setCurrentIndex(0);
        state.setCurrentTrack(null);
        controllerRef.current?.pause();
        state.setShuffleIndices([]);
    }, [state]);

    // Set upcoming tracks without interrupting current playback
    // preserveOrder=true will skip shuffle index generation (used for vibe mode)
    const setUpcoming = useCallback(
        (tracks: Track[], preserveOrder = false) => {
            if (!state.currentTrack || state.playbackType !== "track") {
                if (tracks.length > 0) {
                    state.setQueue(tracks);
                    state.setCurrentIndex(0);
                    state.setCurrentTrack(tracks[0]);
                    state.setPlaybackType("track");
                    playback.setCurrentTime(0);
                    if (!preserveOrder && state.activeOperation.type === 'idle') {
                        state.setShuffleIndices(
                            generateShuffleIndices(tracks.length, 0)
                        );
                    } else {
                        state.setShuffleIndices([]);
                    }

                    const streamUrl = api.getStreamUrl(tracks[0].id);
                    controllerRef.current?.load(streamUrl, true);
                }
                return;
            }

            state.setQueue((prev) => {
                const currentTrack = prev[state.currentIndex];
                if (!currentTrack) return tracks;
                return [currentTrack, ...tracks];
            });

            state.setCurrentIndex(0);

            if (state.isShuffle && !preserveOrder && state.activeOperation.type === 'idle') {
                state.setShuffleIndices(
                    generateShuffleIndices(tracks.length + 1, 0)
                );
            } else {
                state.setShuffleIndices([]);
            }
        },
        [state, playback, generateShuffleIndices]
    );

    const toggleShuffle = useCallback(() => {
        if (state.activeOperation.type !== 'idle') {
            return;
        }

        state.setIsShuffle((prev) => {
            const newShuffle = !prev;
            if (newShuffle && state.queue.length > 0) {
                state.setShuffleIndices(
                    generateShuffleIndices(
                        state.queue.length,
                        state.currentIndex
                    )
                );
            }
            return newShuffle;
        });
    }, [state, generateShuffleIndices]);

    const toggleRepeat = useCallback(() => {
        state.setRepeatMode((prev) => {
            if (prev === "off") return "all";
            if (prev === "all") return "one";
            return "off";
        });
        state.setRepeatOneCount(0);
    }, [state]);

    const updateCurrentTime = useCallback(
        (time: number) => {
            playback.setCurrentTime(time);
        },
        [playback]
    );

    const skipForward = useCallback(
        (seconds: number = 30) => {
            const isFirstInBatch = skipAccumulatorRef.current === 0;
            if (isFirstInBatch) {
                skipBaseTimeRef.current = currentTimeRef.current;
            }
            skipAccumulatorRef.current += seconds;
            setCurrentTimeRef.current(skipBaseTimeRef.current + skipAccumulatorRef.current);
            if (skipDebounceRef.current) {
                clearTimeout(skipDebounceRef.current);
            }
            skipDebounceRef.current = setTimeout(() => {
                skipDebounceRef.current = null;
                const targetTime = skipBaseTimeRef.current + skipAccumulatorRef.current;
                skipAccumulatorRef.current = 0;
                seek(targetTime);
            }, 200);
        },
        [seek]
    );

    const skipBackward = useCallback(
        (seconds: number = 30) => {
            const isFirstInBatch = skipAccumulatorRef.current === 0;
            if (isFirstInBatch) {
                skipBaseTimeRef.current = currentTimeRef.current;
            }
            skipAccumulatorRef.current -= seconds;
            setCurrentTimeRef.current(
                Math.max(0, skipBaseTimeRef.current + skipAccumulatorRef.current)
            );
            if (skipDebounceRef.current) {
                clearTimeout(skipDebounceRef.current);
            }
            skipDebounceRef.current = setTimeout(() => {
                skipDebounceRef.current = null;
                const targetTime = skipBaseTimeRef.current + skipAccumulatorRef.current;
                skipAccumulatorRef.current = 0;
                seek(targetTime);
            }, 200);
        },
        [seek]
    );

    const setPlayerModeWithHistory = useCallback(
        (mode: PlayerMode) => {
            state.setPreviousPlayerMode(state.playerMode);
            state.setPlayerMode(mode);
        },
        [state]
    );

    const returnToPreviousMode = useCallback(() => {
        const targetMode =
            state.playerMode === "overlay" ? "mini" : state.previousPlayerMode;
        const temp = state.playerMode;
        state.setPlayerMode(targetMode);
        state.setPreviousPlayerMode(temp);
    }, [state]);

    const setVolumeControl = useCallback(
        (newVolume: number) => {
            const clampedVolume = Math.max(0, Math.min(1, newVolume));
            state.setVolume(clampedVolume);
            if (clampedVolume > 0) {
                state.setIsMuted(false);
            }
        },
        [state]
    );

    const toggleMute = useCallback(() => {
        state.setIsMuted((prev) => !prev);
    }, [state]);

    const [pendingReplacement, setPendingReplacement] = useState<{
        currentOpName: string;
        newOpName: string;
        resolve: (confirmed: boolean) => void;
    } | null>(null);

    const replaceOperation = useCallback(async (
        newOp: VibeOperation,
        newQueue: Track[],
        startIndex = 0,
    ): Promise<boolean> => {
        const op = state.activeOperation;

        if (op.type === 'idle') {
            state.setActiveOperation(newOp);
            playTracks(newQueue, startIndex, { skipOperationCheck: true });
            return true;
        }

        const currentTrackId = state.currentTrack?.id;
        const opTrackIds = 'trackIds' in op ? op.trackIds
            : 'pathTrackIds' in op ? op.pathTrackIds
            : 'resultTrackIds' in op ? op.resultTrackIds
            : [];

        if (!currentTrackId || !opTrackIds.includes(currentTrackId)) {
            state.setActiveOperation(newOp);
            playTracks(newQueue, startIndex, { skipOperationCheck: true });
            return true;
        }

        return new Promise((resolve) => {
            setPendingReplacement((prev) => {
                if (prev) prev.resolve(false);
                return {
                    currentOpName: op.type,
                    newOpName: newOp.type,
                    resolve: (confirmed) => {
                        if (confirmed) {
                            state.setActiveOperation(newOp);
                            playTracks(newQueue, startIndex, { skipOperationCheck: true });
                        }
                        setPendingReplacement(null);
                        resolve(confirmed);
                    },
                };
            });
        });
    }, [state, playTracks]);

    // Vibe mode controls - uses CLAP similarity API
    const startVibeMode = useCallback(async (): Promise<{
        success: boolean;
        trackCount: number;
    }> => {
        const currentTrack = state.currentTrack;
        if (!currentTrack?.id) {
            return { success: false, trackCount: 0 };
        }

        try {
            const response = await api.getVibeSimilarTracks(currentTrack.id, 50);

            if (!response.tracks || response.tracks.length === 0) {
                return { success: false, trackCount: 0 };
            }

            const queueIds = [
                currentTrack.id,
                ...response.tracks.map((t) => t.id),
            ];

            const vibeTracks: Track[] = response.tracks.map((t) => ({
                id: t.id,
                title: t.title,
                duration: t.duration,
                artist: { name: t.artist.name, id: t.artist.id },
                album: {
                    title: t.album.title,
                    coverArt: t.album.coverUrl || undefined,
                    id: t.album.id,
                },
            }));

            const newOp: VibeOperation = {
                type: 'vibe',
                sourceTrackId: currentTrack.id,
                sourceFeatures: currentTrack.audioFeatures || {},
                trackIds: queueIds,
            };

            const confirmed = await replaceOperation(
                newOp,
                [currentTrack, ...vibeTracks],
                0,
            );

            if (!confirmed) {
                return { success: false, trackCount: 0 };
            }

            state.setIsShuffle(false);
            state.setShuffleIndices([]);

            return { success: true, trackCount: response.tracks.length };
        } catch (error) {
            console.error("[Vibe] Failed to get similar tracks:", error);
            return { success: false, trackCount: 0 };
        }
    }, [state, replaceOperation]);

    const stopVibeMode = useCallback(() => {
        state.setActiveOperation({ type: 'idle' });
    }, [state]);

    // -- Refs kept in sync for event handlers --
    const nextRef = useRef(next);
    const nextPodcastEpisodeRef = useRef(nextPodcastEpisode);

    useLayoutEffect(() => {
        playbackTypeRef.current = state.playbackType;
        currentTrackRef.current = state.currentTrack;
        currentAudiobookRef.current = state.currentAudiobook;
        currentPodcastRef.current = state.currentPodcast;
        repeatModeRef.current = state.repeatMode;
        nextRef.current = next;
        nextPodcastEpisodeRef.current = nextPodcastEpisode;
        queueRef.current = state.queue;
        isShuffleRef.current = state.isShuffle;
        shuffleIndicesRef.current = state.shuffleIndices;
        setCurrentTimeRef.current = playback.setCurrentTime;
    });

    // -- Progress saving callbacks --
    const saveAudiobookProgress = useCallback(
        async (isFinished: boolean = false) => {
            const audiobook = currentAudiobookRef.current;
            if (!audiobook) return;

            const trackOffset = audiobook.trackOffset ?? 0;
            const withinTrackTime = controllerRef.current?.getCurrentTime() || 0;
            const totalBookTime = trackOffset + withinTrackTime;
            const bookDuration = audiobook.duration || 0;

            if (totalBookTime === lastSaveTimeRef.current && !isFinished) return;
            lastSaveTimeRef.current = totalBookTime;

            try {
                await api.updateAudiobookProgress(
                    audiobook.id,
                    isFinished ? bookDuration : totalBookTime,
                    bookDuration,
                    isFinished
                );
                state.setCurrentAudiobook((prev) => {
                    if (!prev || prev.id !== audiobook.id) return prev;
                    const dur = prev.duration || 0;
                    const pos = isFinished ? dur : totalBookTime;
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
                console.error("[AudioControls] Failed to save audiobook progress:", err);
            }
        },
        [state]
    );

    const savePodcastProgress = useCallback(
        async (isFinished: boolean = false) => {
            const podcast = currentPodcastRef.current;
            if (!podcast) return;

            const currentTime = controllerRef.current?.getCurrentTime() || 0;
            const duration = controllerRef.current?.getDuration() || podcast.duration;
            if (currentTime <= 0 && !isFinished) return;

            try {
                const [podcastId, episodeId] = podcast.id.split(":");
                await api.updatePodcastEpisodeProgress(
                    podcastId,
                    episodeId,
                    isFinished ? duration : currentTime,
                    duration,
                    isFinished
                );
                state.setCurrentPodcast((prev) => {
                    if (!prev || prev.id !== podcast.id) return prev;
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
                dispatchQueryEvent("podcast-progress-updated");
            } catch (err) {
                console.error("[AudioControls] Failed to save podcast progress:", err);
            }
        },
        [state]
    );

    const saveAudiobookProgressRef = useRef(saveAudiobookProgress);
    const savePodcastProgressRef = useRef(savePodcastProgress);
    useLayoutEffect(() => {
        saveAudiobookProgressRef.current = saveAudiobookProgress;
        savePodcastProgressRef.current = savePodcastProgress;
    }, [saveAudiobookProgress, savePodcastProgress]);

    // -- Ended handler --
    useEffect(() => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;

        const handleEnded = () => {
            if (playbackTypeRef.current === "audiobook") {
                const audiobook = currentAudiobookRef.current;
                const tracks = audiobook?.tracks ?? [];
                const currentTrackIdx = audiobook?.trackIndex ?? 0;

                if (tracks.length > 1) {
                    const pos = tracks.findIndex(t => t.index === currentTrackIdx);
                    const nextTrack = pos >= 0 && pos < tracks.length - 1 ? tracks[pos + 1] : null;

                    if (nextTrack && audiobook) {
                        state.setCurrentAudiobook(prev =>
                            prev ? { ...prev, trackIndex: nextTrack.index, trackOffset: nextTrack.startOffset } : prev
                        );
                        pendingStartTimeRef.current = 0;
                        ctrl.load(api.getAudiobookStreamUrl(audiobook.id, nextTrack.index), true);
                        return;
                    }
                }

                justFinishedRef.current = true;
                saveAudiobookProgressRef.current(true);
                ctrl.pause();
                return;
            } else if (playbackTypeRef.current === "podcast") {
                justFinishedRef.current = true;
                savePodcastProgressRef.current(true);
                nextPodcastEpisodeRef.current();
                return;
            }

            // Track ended
            if (repeatModeRef.current === "one") {
                ctrl.seek(0);
                ctrl.play();
                return;
            }

            const nextTrack = getNextTrackInfo(
                queueRef.current,
                currentIndexRef.current,
                isShuffleRef.current,
                shuffleIndicesRef.current,
                repeatModeRef.current
            );

            if (!nextTrack) {
                ctrl.pause();
                return;
            }

            let nextIndex: number;
            if (isShuffleRef.current) {
                const currentShufflePos = shuffleIndicesRef.current.indexOf(currentIndexRef.current);
                nextIndex = shuffleIndicesRef.current[currentShufflePos + 1];
                if (nextIndex === undefined && repeatModeRef.current === "all") {
                    nextIndex = shuffleIndicesRef.current[0];
                }
            } else {
                nextIndex = currentIndexRef.current + 1;
                if (nextIndex >= queueRef.current.length && repeatModeRef.current === "all") {
                    nextIndex = 0;
                }
            }

            state.setCurrentIndex(nextIndex);
            state.setCurrentTrack(queueRef.current[nextIndex]);
            playback.setCurrentTime(0);

            ctrl.load(api.getStreamUrl(nextTrack.id), true);
        };

        ctrl.on("ended", handleEnded);
        return () => ctrl.off("ended", handleEnded);
    }, [controller, state, playback]);

    // -- Canplay handler for pending seek --
    useEffect(() => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;

        const handleCanPlay = (data: unknown) => {
            const { duration: dur } = data as { duration: number };

            if (pendingStartTimeRef.current > 0) {
                const startPos = pendingStartTimeRef.current;
                pendingStartTimeRef.current = 0;
                ctrl.seek(startPos);
                const trackOffset = playbackTypeRef.current === "audiobook"
                    ? (currentAudiobookRef.current?.trackOffset ?? 0) : 0;
                playback.setCurrentTime(startPos + trackOffset);
            }

            const audiobookDuration = playbackTypeRef.current === "audiobook"
                ? (currentAudiobookRef.current?.duration ?? 0) : 0;
            const fallback =
                currentTrackRef.current?.duration ||
                currentAudiobookRef.current?.duration ||
                currentPodcastRef.current?.duration || 0;
            playback.setDuration(audiobookDuration || dur || fallback);
        };

        ctrl.on("canplay", handleCanPlay);
        return () => ctrl.off("canplay", handleCanPlay);
    }, [controller, playback]);

    // -- Error handler --
    useEffect(() => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;

        const handlePlay = () => {
            consecutiveErrorCountRef.current = 0;
        };

        const handleError = (data: unknown) => {
            const { code } = data as { error: string; code?: number };
            if (code === 2) return;

            if (playbackTypeRef.current === "track") {
                consecutiveErrorCountRef.current++;
                if (consecutiveErrorCountRef.current >= 3 || queueRef.current.length <= 1) {
                    state.setCurrentTrack(null);
                    state.setPlaybackType(null);
                } else {
                    nextRef.current();
                }
            } else {
                if (playbackTypeRef.current === "audiobook") state.setCurrentAudiobook(null);
                if (playbackTypeRef.current === "podcast") state.setCurrentPodcast(null);
                state.setPlaybackType(null);
            }
        };

        ctrl.on("play", handlePlay);
        ctrl.on("error", handleError);
        return () => {
            ctrl.off("play", handlePlay);
            ctrl.off("error", handleError);
        };
    }, [controller, state]);

    // -- Save on pause --
    useEffect(() => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;

        const onPause = () => {
            if (justFinishedRef.current) {
                justFinishedRef.current = false;
                return;
            }
            if (playbackTypeRef.current === "audiobook") saveAudiobookProgressRef.current();
            else if (playbackTypeRef.current === "podcast") savePodcastProgressRef.current();
        };

        ctrl.on("pause", onPause);
        return () => ctrl.off("pause", onPause);
    }, [controller]);

    // -- Periodic save via timeupdate (30s throttle) --
    useEffect(() => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;
        const lastPeriodicSave = { time: 0 };

        const onTimeUpdate = () => {
            if (playbackTypeRef.current !== "audiobook" && playbackTypeRef.current !== "podcast") return;
            const now = Date.now();
            if (now - lastPeriodicSave.time < 30000) return;
            lastPeriodicSave.time = now;

            if (playbackTypeRef.current === "audiobook") saveAudiobookProgressRef.current();
            else if (playbackTypeRef.current === "podcast") savePodcastProgressRef.current();
        };

        ctrl.on("timeupdate", onTimeUpdate);
        return () => ctrl.off("timeupdate", onTimeUpdate);
    }, [controller]);

    // -- Volume/mute sync --
    useEffect(() => { controllerRef.current?.setVolume(state.volume); }, [state.volume]);
    useEffect(() => { controllerRef.current?.setMuted(state.isMuted); }, [state.isMuted]);

    // -- Foreground recovery --
    // Uses both visibilitychange and pageshow/pagehide for iOS PWA reliability.
    // iOS Safari PWA fires pageshow/pagehide more reliably than visibilitychange
    // when the app is suspended/resumed from the app switcher.
    useEffect(() => {
        const handleBackground = () => {
            if (playbackTypeRef.current === "audiobook") {
                saveAudiobookProgressRef.current();
            } else if (playbackTypeRef.current === "podcast") {
                savePodcastProgressRef.current();
            }
        };

        const handleForeground = () => {
            const ctrl = controllerRef.current;
            if (!ctrl) return;

            ctrl.notifyForeground();

            if (playbackTypeRef.current) {
                const hasMedia = currentTrackRef.current || currentAudiobookRef.current || currentPodcastRef.current;
                if (hasMedia) {
                    playback.setAudioError(null);

                    if (ctrl.isPlaying()) {
                        ctrl.tryResume().catch(() => {});
                    } else if (ctrl.wasInterrupted()) {
                        // iOS interrupted playback (notification, phone call, etc.)
                        // The auto-resume timer in the controller may have already
                        // tried, but if the app was suspended it couldn't run.
                        // Try again now that we're back in foreground.
                        ctrl.clearInterruptFlag();
                        ctrl.play().catch(() => {
                            ctrl.reloadAndPlay();
                        });
                    }
                }
            }
        };

        const handleVisibility = () => {
            if (document.hidden) {
                handleBackground();
            } else {
                handleForeground();
            }
        };

        const handlePageShow = (e: PageTransitionEvent) => {
            if (e.persisted) handleForeground();
        };

        const handlePageHide = () => {
            handleBackground();
        };

        document.addEventListener("visibilitychange", handleVisibility);
        window.addEventListener("pageshow", handlePageShow);
        window.addEventListener("pagehide", handlePageHide);
        return () => {
            document.removeEventListener("visibilitychange", handleVisibility);
            window.removeEventListener("pageshow", handlePageShow);
            window.removeEventListener("pagehide", handlePageHide);
        };
    }, [playback]);

    // -- Preload hint --
    useEffect(() => {
        if (state.playbackType !== "track" || !state.currentTrack) return;
        const ctrl = controllerRef.current;
        if (!ctrl) return;

        const nextTrack = getNextTrackInfo(
            state.queue, state.currentIndex, state.isShuffle,
            state.shuffleIndices, state.repeatMode
        );
        if (!nextTrack) return;

        const timer = setTimeout(() => {
            ctrl.preloadHint(api.getStreamUrl(nextTrack.id));
        }, 2000);

        return () => clearTimeout(timer);
    }, [state.playbackType, state.currentTrack, state.queue, state.currentIndex,
        state.isShuffle, state.shuffleIndices, state.repeatMode]);

    // -- Cleanup on unmount --
    useEffect(() => {
        return () => {
            if (playbackTypeRef.current === "audiobook") {
                saveAudiobookProgressRef.current();
            } else if (playbackTypeRef.current === "podcast") {
                savePodcastProgressRef.current();
            }
        };
    }, []);

    // Memoize the entire context value
    const value = useMemo(
        () => ({
            playTrack,
            playTracks,
            playAudiobook,
            playPodcast,
            nextPodcastEpisode,
            pause,
            resume,
            resumeWithGesture,
            next,
            previous,
            addToQueue,
            removeFromQueue,
            clearQueue,
            setUpcoming,
            toggleShuffle,
            toggleRepeat,
            updateCurrentTime,
            seek,
            skipForward,
            skipBackward,
            setPlayerMode: setPlayerModeWithHistory,
            returnToPreviousMode,
            setVolume: setVolumeControl,
            toggleMute,
            startVibeMode,
            stopVibeMode,
            replaceOperation,
        }),
        [
            playTrack,
            playTracks,
            playAudiobook,
            playPodcast,
            nextPodcastEpisode,
            pause,
            resume,
            resumeWithGesture,
            next,
            previous,
            addToQueue,
            removeFromQueue,
            clearQueue,
            setUpcoming,
            toggleShuffle,
            toggleRepeat,
            updateCurrentTime,
            seek,
            skipForward,
            skipBackward,
            setPlayerModeWithHistory,
            returnToPreviousMode,
            setVolumeControl,
            toggleMute,
            startVibeMode,
            stopVibeMode,
            replaceOperation,
        ]
    );

    return (
        <AudioControlsContext.Provider value={value}>
            {children}
            {pendingReplacement && (
                <OperationConfirmToast
                    currentOpName={pendingReplacement.currentOpName}
                    newOpName={pendingReplacement.newOpName}
                    onConfirm={() => pendingReplacement.resolve(true)}
                    onCancel={() => pendingReplacement.resolve(false)}
                />
            )}
        </AudioControlsContext.Provider>
    );
}

export function useAudioControls() {
    const context = useContext(AudioControlsContext);
    if (!context) {
        throw new Error(
            "useAudioControls must be used within AudioControlsProvider"
        );
    }
    return context;
}
