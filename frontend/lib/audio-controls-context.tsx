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
    useAudioSetters,
    useCurrentMedia,
    useLiveAudioState,
    usePlayMode,
    useQueueState,
    useVolumeState,
    Track,
    Audiobook,
    Podcast,
    VibeOperation,
} from "./audio-state-context";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAudioPlayback } from "./audio-playback-context";
import { api, getApiBaseUrl } from "@/lib/api";
import { useAudioController } from "./audio-controller-context";
import { dispatchQueryEvent } from "@/lib/query-events";
import { notify } from "@/lib/notify";
import { BookSession } from "@/lib/book-session";
import { appendTracks, insertTrack, isLastInPlayOrder, removeTrack } from "@/lib/queue-edit";
import { freshQueueKeys, indexOfEntry, withQueueKeys } from "@/lib/queue-key";
import { refillAndResume, startStationSession, type StationSession } from "@/lib/station-refill";
import { shuffleArray } from "@/lib/shuffle";
import { playbackLength } from "@/lib/format";

/** The track ids the active vibe operation holds, under whichever field its kind uses. */
function operationTrackIds(operation: VibeOperation): string[] {
    return 'trackIds' in operation ? operation.trackIds
        : 'pathTrackIds' in operation ? operation.pathTrackIds
        : 'resultTrackIds' in operation ? operation.resultTrackIds
        : [];
}

interface PlayTracksOptions {
    skipOperationCheck?: boolean;
    /** Which page's play button started this queue (see `queue-source.ts`), so that button can tell it is current. */
    source?: string;
}

interface AudioControlsContextType {
    // Track methods
    playTrack: (track: Track) => void;
    playTracks: (tracks: Track[], startIndex?: number, options?: PlayTracksOptions) => void;
    /** Plays a station: when its last track starts, fetchBatch is asked for more and the new tracks are appended. */
    playStation: (tracks: Track[], fetchBatch: () => Promise<Track[]>, options?: { serverOrdered?: boolean }) => void;

    // Audiobook methods
    playAudiobook: (audiobook: Audiobook) => void;
    playAudiobookAt: (audiobook: Audiobook, bookTime: number) => void;

    // Podcast methods
    playPodcast: (podcast: Podcast) => void;
    nextPodcastEpisode: () => void;

    // Playback controls
    pause: () => void;
    resumeWithGesture: () => void;
    next: () => void;
    previous: () => void;

    // Queue controls
    addToQueue: (track: Track) => void;
    /** Plays the entry at this place of the queue as it is: same entries, same shuffle order, same source. */
    playQueueIndex: (index: number) => void;
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
    /** Opens the full-screen player over the page. */
    openOverlay: () => void;
    closeOverlay: () => void;

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
    queue: Track[],
    currentIndex: number,
    isShuffle: boolean,
    shuffleIndices: number[],
    repeatMode: "off" | "one" | "all"
): (Track & { index: number }) | null {
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

    return queue[nextIndex] ? { ...queue[nextIndex], index: nextIndex } : null;
}

/** A saved position as the player shows it: where, how far through, whether finished. */
function progressAt(position: number, duration: number, isFinished: boolean) {
    return {
        currentTime: position,
        progress: duration > 0 ? (position / duration) * 100 : 0,
        isFinished,
        lastPlayedAt: new Date(),
    };
}

const OPERATION_NAMES: Record<string, string> = {
    vibe: "Vibe",
    drift: "Drift",
    blend: "Blend",
    similar: "Similar",
};

function operationName(type: string | undefined): string {
    return (type && OPERATION_NAMES[type]) || "the current mix";
}

export function AudioControlsProvider({ children }: { children: ReactNode }) {
    const media = useCurrentMedia();
    const queueState = useQueueState();
    const playMode = usePlayMode();
    const volumeState = useVolumeState();
    const setters = useAudioSetters();
    const liveRef = useLiveAudioState();
    const playback = useAudioPlayback();
    const { setDuration } = playback;

    const controller = useAudioController();
    const controllerRef = useRef(controller);
    useEffect(() => { controllerRef.current = controller; }, [controller]);

    const currentTimeRef = useRef(playback.currentTime);
    useEffect(() => {
        currentTimeRef.current = playback.currentTime;
    }, [playback.currentTime]);
    const currentIndexRef = useRef(queueState.currentIndex);
    const upNextInsertRef = useRef<number>(0);
    const shuffleInsertPosRef = useRef<number>(0);
    const lastCursorTrackIndexRef = useRef<number | null>(null);
    const lastCursorIsShuffleRef = useRef<boolean | null>(null);

    // Skip button debouncing: accumulate rapid clicks into a single seek
    const skipAccumulatorRef = useRef<number>(0);
    const skipBaseTimeRef = useRef<number>(0);
    const skipDebounceRef = useRef<NodeJS.Timeout | null>(null);
    // A skip still waiting to seek must not fire after the player is gone.
    useEffect(() => () => {
        if (skipDebounceRef.current) clearTimeout(skipDebounceRef.current);
    }, []);
    // Stable ref for setCurrentTime to avoid adding unstable `playback` to skip deps
    const setCurrentTimeRef = useRef(playback.setCurrentTime);
    // The engine's duration, for seek to read without being rebuilt every time it changes.
    const durationRef = useRef(playback.duration);

    // Refs for ended/canplay/error handlers
    const playbackTypeRef = useRef(media.playbackType);
    const currentTrackRef = useRef(media.currentTrack);
    const currentAudiobookRef = useRef(media.currentAudiobook);
    const currentPodcastRef = useRef(media.currentPodcast);
    const repeatModeRef = useRef(playMode.repeatMode);
    const queueRef = useRef(queueState.queue);
    const isShuffleRef = useRef(playMode.isShuffle);
    const shuffleIndicesRef = useRef(queueState.shuffleIndices);
    const consecutiveErrorCountRef = useRef(0);
    // The item last saved as finished. While its file still sits at its end, a later save (a pause the engine
    // reports after the end, closing the page) would only record it as not finished again, so none is sent.
    const finishedRef = useRef<string | null>(null);
    const lastManualAdvanceAtRef = useRef(0);
    const lastSaveTimeRef = useRef(0);
    const errorClassifyingRef = useRef(false);
    // The queue key of the entry last prewarmed.
    const prewarmedKeyRef = useRef<string | null>(null);
    const stationRef = useRef<StationSession<Track> | null>(null);
    // Set when the last queued track ends and playback stops by itself; cleared when the playing track changes.
    const queueEndedRef = useRef(false);
    const refillStationNowRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
    const pendingGaplessNextRef = useRef<(Track & { index: number }) | null>(null);
    // Forgets the preloaded next entry everywhere it is held: the engine's expectation, the entry it was for, and
    // the note that it was prewarmed, so the same entry can be preloaded again.
    const dropExpectedNext = useCallback(() => {
        controllerRef.current?.clearExpectedNext();
        pendingGaplessNextRef.current = null;
        prewarmedKeyRef.current = null;
    }, []);

    // Session ref: always consulted by seek, handleEnded, and progress saves.
    const bookSessionRef = useRef<BookSession | null>(null);

    // Clear the session when the active book changes or playback leaves audiobook mode.
    const prevBookIdRef = useRef<string | null>(null);
    useEffect(() => {
        const currentId = media.playbackType === "audiobook" ? media.currentAudiobook?.id ?? null : null;
        if (currentId !== prevBookIdRef.current) {
            if (currentId === null) {
                bookSessionRef.current = null;
            }
            prevBookIdRef.current = currentId;
        }
    }, [media.playbackType, media.currentAudiobook?.id]);

    // Keep a stable "Up Next" insertion cursor like Spotify:
    // - When the current track changes, reset to "right after current"
    // - Each addToQueue inserts at the cursor and advances it
    useEffect(() => {
        if (media.playbackType !== "track") {
            upNextInsertRef.current = 0;
            shuffleInsertPosRef.current = 0;
            lastCursorTrackIndexRef.current = null;
            lastCursorIsShuffleRef.current = null;
            return;
        }
        const prevIdx = lastCursorTrackIndexRef.current;
        const prevShuffle = lastCursorIsShuffleRef.current;
        const trackChanged = prevIdx !== queueState.currentIndex;
        const shuffleToggled = prevShuffle !== playMode.isShuffle;

        // Up-next cursor should never move backwards unless track changes / shuffle toggles
        const baseUpNext = queueState.currentIndex + 1;
        upNextInsertRef.current =
            trackChanged || shuffleToggled
                ? baseUpNext
                : Math.max(upNextInsertRef.current, baseUpNext);

        if (playMode.isShuffle) {
            const currentShufflePos = queueState.shuffleIndices.indexOf(
                queueState.currentIndex
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

        lastCursorTrackIndexRef.current = queueState.currentIndex;
        lastCursorIsShuffleRef.current = playMode.isShuffle;
    }, [
        queueState.currentIndex,
        media.playbackType,
        playMode.isShuffle,
        queueState.shuffleIndices,
        queueState.queue.length,
    ]);

    const generateShuffleIndices = useCallback(
        (length: number, currentIdx: number) => {
            const others = Array.from({ length }, (_, i) => i).filter(
                (i) => i !== currentIdx
            );
            return [currentIdx, ...shuffleArray(others)];
        },
        []
    );

    const playTrack = useCallback(
        (song: Track) => {
            const [track] = withQueueKeys([song]);
            stationRef.current = null;
            if (liveRef.current.activeOperation.type !== 'idle') {
                const opTrackIds = operationTrackIds(liveRef.current.activeOperation);
                if (!opTrackIds.includes(track.id)) {
                    setters.setActiveOperation({ type: 'idle' });
                }
            }

            setters.setPlaybackType("track");
            setters.setCurrentTrack(track);
            setters.setCurrentAudiobook(null);
            setters.setCurrentPodcast(null);
            setters.setQueue([track]);
            setters.setCurrentIndex(0);
            setCurrentTimeRef.current(0);
            setters.setShuffleIndices([0]);
            setters.setRepeatOneCount(0);

            const streamUrl = api.getStreamUrl(track.id);
            controllerRef.current?.load(streamUrl, { autoplay: true, expectedDurationS: track.duration });
        },
        [setters, liveRef]
    );

    const playTracks = useCallback(
        (songs: Track[], requestedIndex = 0, { skipOperationCheck = false, source }: PlayTracksOptions = {}) => {
            if (songs.length === 0) return;
            // A place the list does not have (a stale index, a list that shrank) starts it from the top.
            const startIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < songs.length ? requestedIndex : 0;
            const tracks = withQueueKeys(songs);
            setters.setQueueOrigin(source ? { source, keys: new Set(tracks.map((t) => t.queueKey)) } : null);
            stationRef.current = null;

            if (!skipOperationCheck && liveRef.current.activeOperation.type !== 'idle') {
                const opTrackIds = operationTrackIds(liveRef.current.activeOperation);
                if (!opTrackIds.includes(tracks[startIndex]?.id)) {
                    setters.setActiveOperation({ type: 'idle' });
                }
            }

            setters.setPlaybackType("track");
            setters.setCurrentAudiobook(null);
            setters.setCurrentPodcast(null);
            setters.setQueue(tracks);
            setters.setCurrentIndex(startIndex);
            setters.setCurrentTrack(tracks[startIndex]);
            setCurrentTimeRef.current(0);
            setters.setRepeatOneCount(0);
            setters.setShuffleIndices(
                generateShuffleIndices(tracks.length, startIndex)
            );

            const streamUrl = api.getStreamUrl(tracks[startIndex].id);
            controllerRef.current?.load(streamUrl, { autoplay: true, expectedDurationS: tracks[startIndex].duration });
        },
        [setters, liveRef, generateShuffleIndices]
    );

    const playStation = useCallback(
        (tracks: Track[], fetchBatch: () => Promise<Track[]>, options?: { serverOrdered?: boolean }) => {
            playTracks(tracks, 0);
            if (tracks.length > 0) stationRef.current = startStationSession(tracks, fetchBatch, options);
        },
        [playTracks]
    );

    const startAudiobookSession = useCallback(
        async (audiobook: Audiobook, bookTime: number) => {
            let session: BookSession;
            try {
                session = await BookSession.open(audiobook);
            } catch (err) {
                if (err instanceof Error) {
                    notify.error("Couldn't load audiobook -- Audiobookshelf is unreachable");
                }
                return;
            }

            bookSessionRef.current = session;
            const { file, fileTime } = session.locate(bookTime);

            setters.setPlaybackType("audiobook");
            setters.setCurrentTrack(null);
            setters.setCurrentPodcast(null);
            setters.setQueue([]);
            setters.setCurrentIndex(0);
            setters.setShuffleIndices([]);
            setters.setCurrentAudiobook({
                ...audiobook,
                tracks: [...session.files],
                trackIndex: file.index,
                trackOffset: file.startOffset,
            });
            setCurrentTimeRef.current(bookTime);

            controllerRef.current?.load(
                api.getAudiobookStreamUrl(session.bookId, file.index),
                { autoplay: true, seekTo: fileTime }
            );
        },
        [setters]
    );

    const playAudiobookAt = useCallback(
        (audiobook: Audiobook, bookTime: number) => {
            startAudiobookSession(audiobook, bookTime).catch(() => notify.error("Couldn't start the audiobook"));
        },
        [startAudiobookSession]
    );

    /** Plays a book from where the listener left it. */
    const playAudiobook = useCallback(
        (audiobook: Audiobook) => playAudiobookAt(audiobook, audiobook.progress?.currentTime ?? 0),
        [playAudiobookAt]
    );

    const playPodcast = useCallback(
        (podcast: Podcast) => {
            setters.setPlaybackType("podcast");
            setters.setCurrentPodcast(podcast);
            setters.setCurrentTrack(null);
            setters.setCurrentAudiobook(null);
            setters.setQueue([]);
            setters.setCurrentIndex(0);
            setters.setShuffleIndices([]);

            const startTime = podcast.progress?.currentTime || 0;
            setCurrentTimeRef.current(startTime);

            const [podcastId, episodeId] = podcast.id.split(":");
            const streamUrl = api.getPodcastEpisodeStreamUrl(podcastId, episodeId);
            controllerRef.current?.load(streamUrl, { autoplay: true, seekTo: startTime });
        },
        [setters]
    );

    const pause = useCallback(() => {
        controllerRef.current?.pause();
    }, []);

    // The show's next episode by release date that has not been finished, as the server answers it; at the
    // show's end the player stops.
    const nextPodcastEpisode = useCallback(async () => {
        const playing = currentPodcastRef.current;
        if (!playing) {
            pause();
            return;
        }
        const [podcastId, episodeId] = playing.id.split(":");
        let answer: Awaited<ReturnType<typeof api.getNextPodcastEpisode>>;
        try {
            answer = await api.getNextPodcastEpisode(podcastId, episodeId);
        } catch (err) {
            console.error("[AudioControls] Couldn't find the next episode:", err);
            pause();
            return;
        }
        // Something else started meanwhile: leave it playing.
        if (currentPodcastRef.current?.id !== playing.id) return;
        if (!answer.episode || !answer.podcast) {
            pause();
            return;
        }
        playPodcast({
            id: `${answer.podcast.id}:${answer.episode.id}`,
            title: answer.episode.title,
            podcastTitle: answer.podcast.title,
            coverUrl: answer.episode.coverUrl || answer.podcast.coverUrl || "",
            duration: answer.episode.duration,
            progress: answer.episode.progress,
        });
    }, [playPodcast, pause]);

    const loadRestoredState = useCallback(async (): Promise<boolean> => {
        const ctrl = controllerRef.current;
        if (!ctrl || ctrl.getState().currentSrc) return false;

        if (liveRef.current.playbackType === "track" && liveRef.current.currentTrack) {
            ctrl.load(api.getStreamUrl(liveRef.current.currentTrack.id), { expectedDurationS: liveRef.current.currentTrack.duration });
            return true;
        }
        if (liveRef.current.playbackType === "audiobook" && liveRef.current.currentAudiobook) {
            const persisted = liveRef.current.currentAudiobook;
            let session: BookSession;
            try {
                session = await BookSession.open(persisted);
            } catch {
                notify.error("Couldn't load audiobook -- Audiobookshelf is unreachable");
                return false;
            }
            bookSessionRef.current = session;
            const resumeAt = persisted.progress?.currentTime ?? 0;
            const { file, fileTime } = session.locate(resumeAt);
            // Persisted trackIndex/trackOffset may be stale relative to the
            // saved position (progress synced from elsewhere); re-anchor state
            // to the located file so saves and ended-advance use real offsets.
            setters.setCurrentAudiobook((prev) =>
                prev ? {
                    ...prev,
                    tracks: [...session.files],
                    trackIndex: file.index,
                    trackOffset: file.startOffset,
                } : prev
            );
            setCurrentTimeRef.current(resumeAt);
            ctrl.load(
                api.getAudiobookStreamUrl(session.bookId, file.index),
                { seekTo: fileTime }
            );
            return true;
        }
        if (liveRef.current.playbackType === "podcast" && liveRef.current.currentPodcast) {
            const startTime = liveRef.current.currentPodcast.progress?.currentTime || 0;
            setCurrentTimeRef.current(startTime);
            const [podcastId, episodeId] = liveRef.current.currentPodcast.id.split(":");
            ctrl.load(
                api.getPodcastEpisodeStreamUrl(podcastId, episodeId),
                { seekTo: startTime }
            );
            return true;
        }
        return false;
    }, [setters, liveRef]);

    // Play after a station's queue ended: try its refill again (one try per press), and play the new
    // tracks if it brings any, otherwise replay as before.
    const playOrRefill = useCallback(async () => {
        if (queueEndedRef.current && (await refillStationNowRef.current())) return;
        controllerRef.current?.play();
    }, []);

    const resumeWithGesture = useCallback(async () => {
        await loadRestoredState();
        await playOrRefill();
    }, [loadRestoredState, playOrRefill]);

    const seek = useCallback(
        (time: number) => {
            const mediaDuration =
                liveRef.current.playbackType === "podcast"
                    ? liveRef.current.currentPodcast?.duration || 0
                    : liveRef.current.playbackType === "audiobook"
                    ? liveRef.current.currentAudiobook?.duration || 0
                    : liveRef.current.currentTrack?.duration || 0;
            const isMultiTrack = liveRef.current.playbackType === "audiobook" && (liveRef.current.currentAudiobook?.tracks?.length ?? 0) > 1;
            const maxDuration = playbackLength({ multiFile: isMultiTrack, stored: mediaDuration, engine: durationRef.current });
            const clampedTime =
                maxDuration > 0
                    ? Math.min(Math.max(time, 0), maxDuration)
                    : Math.max(time, 0);

            setCurrentTimeRef.current(clampedTime);

            if (liveRef.current.playbackType === "audiobook" && liveRef.current.currentAudiobook) {
                const session = bookSessionRef.current;
                if (session) {
                    const { file, fileTime } = session.locate(clampedTime);
                    const currentTrackIdx = liveRef.current.currentAudiobook.trackIndex ?? 0;

                    setters.setCurrentAudiobook((prev) => prev ? {
                        ...prev,
                        trackIndex: file.index,
                        trackOffset: file.startOffset,
                        progress: progressAt(clampedTime, prev.duration, false),
                    } : prev);

                    if (file.index !== currentTrackIdx) {
                        const wasPlaying = controllerRef.current?.isPlaying() ?? false;
                        controllerRef.current?.load(
                            api.getAudiobookStreamUrl(liveRef.current.currentAudiobook.id, file.index),
                            { autoplay: wasPlaying, seekTo: fileTime }
                        );
                    } else {
                        controllerRef.current?.seek(fileTime);
                    }
                } else {
                    // Degraded: no session (open failed or not yet restored).
                    // Plain element seek within the current file; never touch trackIndex.
                    const trackOffset = liveRef.current.currentAudiobook.trackOffset ?? 0;
                    controllerRef.current?.seek(clampedTime - trackOffset);
                }
            } else if (
                liveRef.current.playbackType === "podcast" &&
                liveRef.current.currentPodcast
            ) {
                setters.setCurrentPodcast((prev) =>
                    prev ? { ...prev, progress: progressAt(clampedTime, prev.duration || 0, false) } : prev
                );
                controllerRef.current?.seek(clampedTime);
            } else {
                controllerRef.current?.seek(clampedTime);
            }
        },
        [setters, liveRef]
    );

    const next = useCallback(() => {
        if (liveRef.current.playbackType === "podcast") {
            void nextPodcastEpisode();
            return;
        }
        if (liveRef.current.queue.length === 0) return;

        if (liveRef.current.repeatMode === "one" && liveRef.current.repeatOneCount === 0) {
            setters.setRepeatOneCount(1);
            seek(0);
            return;
        }

        setters.setRepeatOneCount(0);

        const nextTrack = getNextTrackInfo(
            liveRef.current.queue,
            liveRef.current.currentIndex,
            liveRef.current.isShuffle,
            liveRef.current.shuffleIndices,
            liveRef.current.repeatMode
        );
        if (!nextTrack) {
            controllerRef.current?.pause();
            return;
        }
        const nextIndex = nextTrack.index;

        setters.setCurrentIndex(nextIndex);
        setters.setCurrentTrack(liveRef.current.queue[nextIndex]);
        setCurrentTimeRef.current(0);
        lastManualAdvanceAtRef.current = Date.now();

        const streamUrl = api.getStreamUrl(liveRef.current.queue[nextIndex].id);
        controllerRef.current?.load(streamUrl, { autoplay: true, expectedDurationS: liveRef.current.queue[nextIndex].duration });
    }, [setters, liveRef, seek, nextPodcastEpisode]);

    const previous = useCallback(() => {
        if (liveRef.current.queue.length === 0) return;

        if (currentTimeRef.current > 3) {
            seek(0);
            return;
        }

        setters.setRepeatOneCount(0);

        let prevIndex: number;
        if (liveRef.current.isShuffle) {
            const currentShufflePos = liveRef.current.shuffleIndices.indexOf(
                liveRef.current.currentIndex
            );
            if (currentShufflePos > 0) {
                prevIndex = liveRef.current.shuffleIndices[currentShufflePos - 1];
            } else {
                seek(0);
                return;
            }
        } else {
            if (liveRef.current.currentIndex > 0) {
                prevIndex = liveRef.current.currentIndex - 1;
            } else {
                seek(0);
                return;
            }
        }

        setters.setCurrentIndex(prevIndex);
        setters.setCurrentTrack(liveRef.current.queue[prevIndex]);
        setCurrentTimeRef.current(0);
        lastManualAdvanceAtRef.current = Date.now();

        const streamUrl = api.getStreamUrl(liveRef.current.queue[prevIndex].id);
        controllerRef.current?.load(streamUrl, { autoplay: true, expectedDurationS: liveRef.current.queue[prevIndex].duration });
    }, [setters, liveRef, seek]);

    const queueSnapshot = useCallback(
        () => ({
            queue: queueRef.current,
            shuffleIndices: shuffleIndicesRef.current,
            isShuffle: isShuffleRef.current,
            currentIndex: currentIndexRef.current,
        }),
        []
    );

    const addToQueue = useCallback(
        (song: Track) => {
            // Each add is its own entry, so adding one song twice queues it twice.
            const [track] = freshQueueKeys([song]);
            // This branch replaces the whole queue, so it runs only when the queue
            // is really empty, read from the ref rather than a stale closure.
            // playbackType is not part of the test: adding a track during a
            // podcast starts a track queue below.
            if (queueRef.current.length === 0) {
                setters.setPlaybackType("track");
                setters.setQueue([track]);
                setters.setCurrentIndex(0);
                setters.setCurrentTrack(track);
                setters.setCurrentAudiobook(null);
                setters.setCurrentPodcast(null);
                setCurrentTimeRef.current(0);
                setters.setShuffleIndices([0]);
                queueRef.current = [track];
                currentIndexRef.current = 0;
                shuffleIndicesRef.current = [0];

                const streamUrl = api.getStreamUrl(track.id);
                controllerRef.current?.load(streamUrl, { autoplay: true, expectedDurationS: track.duration });
                return;
            }

            const next = insertTrack(
                queueSnapshot(),
                { upNextAt: upNextInsertRef.current, shufflePos: shuffleInsertPosRef.current },
                track,
            );
            queueRef.current = next.queue;
            shuffleIndicesRef.current = next.shuffleIndices;
            upNextInsertRef.current = next.upNextAt;
            shuffleInsertPosRef.current = next.shufflePos;

            // Added to the queue, not replacing it: the queue still came from the page that started it.
            setters.extendQueueOrigin([track.queueKey]);
            setters.setQueue(next.queue);
            if (isShuffleRef.current) setters.setShuffleIndices(next.shuffleIndices);
        },
        [setters, queueSnapshot]
    );

    const appendToQueue = useCallback(
        (songs: Track[]) => {
            const added = freshQueueKeys(songs);
            const next = appendTracks(queueSnapshot(), added);
            setters.extendQueueOrigin(added.map((song) => song.queueKey));
            queueRef.current = next.queue;
            shuffleIndicesRef.current = next.shuffleIndices;
            setters.setQueue(next.queue);
            if (isShuffleRef.current) setters.setShuffleIndices(next.shuffleIndices);
        },
        [setters, queueSnapshot]
    );

    const playQueueIndex = useCallback(
        (index: number) => {
            const track = queueRef.current[index];
            if (!track) return;
            currentIndexRef.current = index;
            setters.setPlaybackType("track");
            setters.setCurrentAudiobook(null);
            setters.setCurrentPodcast(null);
            setters.setCurrentIndex(index);
            setters.setCurrentTrack(track);
            setters.setRepeatOneCount(0);
            setCurrentTimeRef.current(0);
            controllerRef.current?.load(api.getStreamUrl(track.id), { autoplay: true, expectedDurationS: track.duration });
        },
        [setters]
    );

    // Refills the station from the live queue. If it fails the position can be tried again: on the next
    // player state change, or when the listener presses play after the queue ended.
    const refillStationNow = useCallback((): Promise<boolean> => {
        const session = stationRef.current;
        if (!session) return Promise.resolve(false);
        const snap = queueSnapshot();
        if (!isLastInPlayOrder(snap)) return Promise.resolve(false);
        return refillAndResume(
            session,
            `${snap.currentIndex}:${currentTrackRef.current?.id}`,
            snap.queue,
            {
                isCurrent: () => stationRef.current === session,
                append: (fresh) => {
                    const before = queueRef.current.length;
                    appendToQueue(fresh);
                    return before;
                },
                playbackEnded: () => queueEndedRef.current,
                startAt: playQueueIndex,
            }
        ).catch((error) => {
            console.error("Failed to refill station:", error);
            return false;
        });
    }, [queueSnapshot, appendToQueue, playQueueIndex]);

    // A station refills when its last queued track starts.
    useEffect(() => {
        queueEndedRef.current = false;
    }, [queueState.currentIndex, media.currentTrack?.id]);

    useEffect(() => {
        if (!stationRef.current) return;
        if (media.playbackType !== "track") {
            stationRef.current = null;
            return;
        }
        void refillStationNow();
    }, [media, queueState, playMode, refillStationNow]);

    const removeFromQueue = useCallback(
        (index: number) => {
            const next = removeTrack(
                queueSnapshot(),
                { upNextAt: upNextInsertRef.current, shufflePos: shuffleInsertPosRef.current },
                index,
            );
            queueRef.current = next.queue;
            shuffleIndicesRef.current = next.shuffleIndices;
            currentIndexRef.current = next.currentIndex;
            upNextInsertRef.current = next.upNextAt;
            shuffleInsertPosRef.current = next.shufflePos;

            setters.setQueue(next.queue);
            if (isShuffleRef.current) setters.setShuffleIndices(next.shuffleIndices);
            setters.setCurrentIndex(next.currentIndex);
            if (next.currentTrack !== undefined) setters.setCurrentTrack(next.currentTrack);
            if (next.currentTrack === null) controllerRef.current?.pause();
        },
        [setters, queueSnapshot]
    );

    const clearQueue = useCallback(() => {
        stationRef.current = null;
        setters.setQueue([]);
        setters.setCurrentIndex(0);
        setters.setCurrentTrack(null);
        controllerRef.current?.pause();
        setters.setShuffleIndices([]);
    }, [setters]);

    // Set upcoming tracks without interrupting current playback
    // preserveOrder=true will skip shuffle index generation (used for vibe mode)
    const setUpcoming = useCallback(
        (tracks: Track[], preserveOrder = false) => {
            stationRef.current = null;
            if (!liveRef.current.currentTrack || liveRef.current.playbackType !== "track") {
                if (tracks.length > 0) {
                    setters.setQueue(tracks);
                    setters.setCurrentIndex(0);
                    setters.setCurrentTrack(tracks[0]);
                    setters.setPlaybackType("track");
                    setCurrentTimeRef.current(0);
                    if (!preserveOrder && liveRef.current.activeOperation.type === 'idle') {
                        setters.setShuffleIndices(
                            generateShuffleIndices(tracks.length, 0)
                        );
                    } else {
                        setters.setShuffleIndices([]);
                    }

                    const streamUrl = api.getStreamUrl(tracks[0].id);
                    controllerRef.current?.load(streamUrl, { autoplay: true, expectedDurationS: tracks[0].duration });
                }
                return;
            }

            setters.setQueue((prev) => {
                const currentTrack = prev[liveRef.current.currentIndex];
                if (!currentTrack) return tracks;
                return [currentTrack, ...tracks];
            });

            setters.setCurrentIndex(0);

            if (liveRef.current.isShuffle && !preserveOrder && liveRef.current.activeOperation.type === 'idle') {
                setters.setShuffleIndices(
                    generateShuffleIndices(tracks.length + 1, 0)
                );
            } else {
                setters.setShuffleIndices([]);
            }
        },
        [setters, liveRef, generateShuffleIndices]
    );

    const toggleShuffle = useCallback(() => {
        if (liveRef.current.activeOperation.type !== 'idle') {
            return;
        }

        const newShuffle = !liveRef.current.isShuffle;
        setters.setIsShuffle(newShuffle);
        if (newShuffle && liveRef.current.queue.length > 0) {
            setters.setShuffleIndices(
                generateShuffleIndices(
                    liveRef.current.queue.length,
                    liveRef.current.currentIndex
                )
            );
        }
    }, [setters, liveRef, generateShuffleIndices]);

    const toggleRepeat = useCallback(() => {
        setters.setRepeatMode((prev) => {
            if (prev === "off") return "all";
            if (prev === "all") return "one";
            return "off";
        });
        setters.setRepeatOneCount(0);
    }, [setters]);

    const updateCurrentTime = playback.setCurrentTime;

    /** Skip by `delta` seconds; skips in quick succession add up into one seek. */
    const skipBy = useCallback(
        (delta: number) => {
            if (skipAccumulatorRef.current === 0) {
                skipBaseTimeRef.current = currentTimeRef.current;
            }
            skipAccumulatorRef.current += delta;
            setCurrentTimeRef.current(Math.max(0, skipBaseTimeRef.current + skipAccumulatorRef.current));
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
    const skipForward = useCallback((seconds: number = 30) => skipBy(seconds), [skipBy]);
    const skipBackward = useCallback((seconds: number = 30) => skipBy(-seconds), [skipBy]);

    const openOverlay = useCallback(() => setters.setOverlayOpen(true), [setters]);
    const closeOverlay = useCallback(() => setters.setOverlayOpen(false), [setters]);

    const setVolumeControl = useCallback(
        (newVolume: number) => {
            const clampedVolume = Math.max(0, Math.min(1, newVolume));
            setters.setVolume(clampedVolume);
            if (clampedVolume > 0) {
                setters.setIsMuted(false);
            }
        },
        [setters]
    );

    const toggleMute = useCallback(() => {
        setters.setIsMuted((prev) => !prev);
    }, [setters]);

    type PendingReplacement = {
        currentOpName: string;
        newOpName: string;
        resolve: (confirmed: boolean) => void;
    };
    const [pendingReplacement, setPendingReplacement] = useState<PendingReplacement | null>(null);
    const pendingReplacementRef = useRef<PendingReplacement | null>(null);

    const replaceOperation = useCallback(async (
        newOp: VibeOperation,
        newQueue: Track[],
        startIndex = 0,
    ): Promise<boolean> => {
        const op = liveRef.current.activeOperation;
        // A vibe queue is an ordered journey: it always plays in order.
        const start = () => {
            setters.setActiveOperation(newOp);
            playTracks(newQueue, startIndex, { skipOperationCheck: true });
            setters.setIsShuffle(false);
            setters.setShuffleIndices([]);
        };

        if (op.type === 'idle') {
            start();
            return true;
        }

        const currentTrackId = liveRef.current.currentTrack?.id;
        const opTrackIds = operationTrackIds(op);

        if (!currentTrackId || !opTrackIds.includes(currentTrackId)) {
            start();
            return true;
        }

        pendingReplacementRef.current?.resolve(false);
        return new Promise((resolve) => {
            let settled = false;
            const pending = {
                currentOpName: op.type,
                newOpName: newOp.type,
                resolve: (confirmed: boolean) => {
                    if (settled) return;
                    settled = true;
                    if (confirmed) start();
                    if (pendingReplacementRef.current === pending) {
                        pendingReplacementRef.current = null;
                        setPendingReplacement(null);
                    }
                    resolve(confirmed);
                },
            };
            pendingReplacementRef.current = pending;
            setPendingReplacement(pending);
        });
    }, [setters, liveRef, playTracks]);

    // Vibe mode controls - uses CLAP similarity API
    const startVibeMode = useCallback(async (): Promise<{
        success: boolean;
        trackCount: number;
    }> => {
        const currentTrack = liveRef.current.currentTrack;
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
                displayTitle: t.displayTitle,
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
                matches: Object.fromEntries(response.tracks.map((t) => [t.id, t.similarity])),
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

            return { success: true, trackCount: response.tracks.length };
        } catch (error) {
            console.error("[Vibe] Failed to get similar tracks:", error);
            return { success: false, trackCount: 0 };
        }
    }, [liveRef, replaceOperation]);

    const stopVibeMode = useCallback(() => {
        setters.setActiveOperation({ type: 'idle' });
    }, [setters]);

    // -- Refs kept in sync for event handlers --
    const nextRef = useRef(next);
    const nextPodcastEpisodeRef = useRef(nextPodcastEpisode);

    useLayoutEffect(() => {
        playbackTypeRef.current = media.playbackType;
        currentTrackRef.current = media.currentTrack;
        currentAudiobookRef.current = media.currentAudiobook;
        currentPodcastRef.current = media.currentPodcast;
        repeatModeRef.current = playMode.repeatMode;
        nextRef.current = next;
        refillStationNowRef.current = refillStationNow;
        nextPodcastEpisodeRef.current = nextPodcastEpisode;
        queueRef.current = queueState.queue;
        currentIndexRef.current = queueState.currentIndex;
        isShuffleRef.current = playMode.isShuffle;
        shuffleIndicesRef.current = queueState.shuffleIndices;
        setCurrentTimeRef.current = playback.setCurrentTime;
        durationRef.current = playback.duration;
    });

    // -- Progress saving callbacks --
    const saveAudiobookProgress = useCallback(
        async (isFinished: boolean = false) => {
            const audiobook = currentAudiobookRef.current;
            if (!audiobook) return;
            if (controllerRef.current?.isTransitioning) return;
            if (!isFinished && finishedRef.current === audiobook.id && controllerRef.current?.hasEnded()) return;
            if (isFinished) finishedRef.current = audiobook.id;

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
                setters.setCurrentAudiobook((prev) => {
                    if (!prev || prev.id !== audiobook.id) return prev;
                    const dur = prev.duration || 0;
                    return { ...prev, progress: progressAt(isFinished ? dur : totalBookTime, dur, isFinished) };
                });
                dispatchQueryEvent("audiobook-progress-updated");
            } catch (err) {
                // Same as podcasts: gone means gone, so stop trying to save against it.
                if ((err as { status?: number } | null)?.status === 404) {
                    setters.setCurrentAudiobook(null);
                    return;
                }
                console.error("[AudioControls] Failed to save audiobook progress:", err);
            }
        },
        [setters]
    );

    const savePodcastProgress = useCallback(
        async (isFinished: boolean = false) => {
            const podcast = currentPodcastRef.current;
            if (!podcast) return;
            if (controllerRef.current?.isTransitioning) return;
            if (!isFinished && finishedRef.current === podcast.id && controllerRef.current?.hasEnded()) return;
            if (isFinished) finishedRef.current = podcast.id;

            const currentTime = controllerRef.current?.getCurrentTime() || 0;
            // The audio's own length, once the player knows it; the server judges "nearly done" from it alone.
            // The feed's length stands in only for the local display.
            const measured = controllerRef.current?.getDuration() || 0;
            const duration = measured || podcast.duration;
            if (currentTime <= 0 && !isFinished) return;

            try {
                const [podcastId, episodeId] = podcast.id.split(":");
                const answer = await api.updatePodcastEpisodeProgress(
                    podcastId,
                    episodeId,
                    isFinished ? duration : currentTime,
                    measured || undefined,
                    isFinished
                );
                // The server decides "finished" (it also counts the last 5% as finished).
                const finished = answer?.progress?.isFinished ?? isFinished;
                const saved = {
                    currentTime: isFinished ? duration : currentTime,
                    progress: duration > 0 ? Math.min(100, ((isFinished ? duration : currentTime) / duration) * 100) : 0,
                    isFinished: finished,
                    lastPlayedAt: new Date(),
                };
                setters.setCurrentPodcast((prev) => {
                    if (!prev || prev.id !== podcast.id) return prev;
                    const dur = prev.duration || 0;
                    return { ...prev, progress: progressAt(isFinished ? dur : currentTime, dur, finished) };
                });
                // The episode and what was saved, so a page showing it updates that row alone.
                dispatchQueryEvent("podcast-progress-updated", { podcastId, episodeId, progress: saved });
            } catch (err) {
                // A 404 means the podcast is no longer subscribed or no longer exists.
                // Progress for it can never be saved again, so stop the player rather
                // than repeating the request every few seconds for the rest of the
                // session -- which is what happens if you unsubscribe while listening.
                if ((err as { status?: number } | null)?.status === 404) {
                    setters.setCurrentPodcast(null);
                    return;
                }
                console.error("[AudioControls] Failed to save podcast progress:", err);
            }
        },
        [setters]
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
            // Just after an advance, an 'ended' from the outgoing track would
            // double-advance. Judge by position: a stale 'ended' leaves the new
            // media near its start, a real end leaves it at its duration, so a
            // sub-second track that really finished still advances.
            if (Date.now() - lastManualAdvanceAtRef.current <= 1000) {
                const pos = ctrl.getCurrentTime();
                const dur = ctrl.getDuration();
                const reachedEnd = dur > 0 && pos >= dur - 1.5;
                if (!reachedEnd) return;
            }
            if (playbackTypeRef.current === "audiobook") {
                const audiobook = currentAudiobookRef.current;
                const session = bookSessionRef.current;

                if (session && audiobook) {
                    const currentTrackIdx = audiobook.trackIndex ?? 0;
                    const file = session.fileByIndex(currentTrackIdx);

                    if (file && !session.isLastFile(file)) {
                        const nextFile = session.files[session.files.indexOf(file) + 1];
                        setters.setCurrentAudiobook((prev) =>
                            prev ? { ...prev, trackIndex: nextFile.index, trackOffset: nextFile.startOffset } : prev
                        );
                        ctrl.load(
                            api.getAudiobookStreamUrl(audiobook.id, nextFile.index),
                            { autoplay: true, seekTo: 0 }
                        );
                        return;
                    }

                    if (file && session.isLastFile(file)) {
                        saveAudiobookProgressRef.current(true);
                        ctrl.pause();
                        return;
                    }
                }

                // Session or file unavailable: save progress but never mark finished.
                saveAudiobookProgressRef.current(false);
                ctrl.pause();
                return;
            } else if (playbackTypeRef.current === "podcast") {
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
                queueEndedRef.current = true;
                ctrl.pause();
                return;
            }

            setters.setCurrentIndex(nextTrack.index);
            setters.setCurrentTrack(nextTrack);
            setCurrentTimeRef.current(0);

            ctrl.load(api.getStreamUrl(nextTrack.id), { autoplay: true, expectedDurationS: nextTrack.duration });
        };

        ctrl.on("ended", handleEnded);
        return () => ctrl.off("ended", handleEnded);
    }, [controller, setters]);

    // Once per upcoming track, with 30s or less left, prewarms it and starts the
    // controller's gapless preload. Skipped on repeat-one, which has no next.
    useEffect(() => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;

        const handleTimeUpdate = (data?: unknown) => {
            if (playbackTypeRef.current !== "track") return;
            const { time } = data as { time: number };
            const duration = currentTrackRef.current?.duration;
            if (!duration || duration - time > 30) return;

            const nextTrack = getNextTrackInfo(
                queueRef.current,
                currentIndexRef.current,
                isShuffleRef.current,
                shuffleIndicesRef.current,
                repeatModeRef.current
            );
            if (!nextTrack) return;
            // Once per entry, not per song: a song queued twice in a row is preloaded for each of its entries.
            if (prewarmedKeyRef.current === nextTrack.queueKey) return;
            prewarmedKeyRef.current = nextTrack.queueKey ?? null;
            api.prewarmTrack(nextTrack.id);

            if (repeatModeRef.current === "one") return;
            pendingGaplessNextRef.current = nextTrack;
            ctrl.setExpectedNext(api.getStreamUrl(nextTrack.id), nextTrack.id, nextTrack.duration);
            ctrl.preloadNext();
        };

        ctrl.on("timeupdate", handleTimeUpdate);
        return () => ctrl.off("timeupdate", handleTimeUpdate);
    }, [controller]);

    // -- Gapless-advance handler --
    // The controller already swapped elements synchronously on `ended`; this
    // only advances the queue's index/currentTrack (and duration/time) to
    // match -- no ctrl.load(), the audio is already playing.
    useEffect(() => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;

        const handleGaplessAdvance = (data?: unknown) => {
            const { durationS, trackId } = (data ?? {}) as { durationS?: number; trackId?: string };

            // The entry that was preloaded, found where the queue holds it now (an edit may have moved it). With
            // none, the next entry in play order. Never the first entry that happens to be the same song.
            let resolved: (Track & { index: number }) | null = null;
            const pending = pendingGaplessNextRef.current;
            const pendingAt = pending && pending.id === trackId ? indexOfEntry(queueRef.current, pending.queueKey) : -1;
            if (pendingAt >= 0) {
                resolved = { ...queueRef.current[pendingAt], index: pendingAt };
            } else {
                resolved = getNextTrackInfo(
                    queueRef.current,
                    currentIndexRef.current,
                    isShuffleRef.current,
                    shuffleIndicesRef.current,
                    repeatModeRef.current
                );
            }
            if (!resolved) return;

            setters.setCurrentIndex(resolved.index);
            setters.setCurrentTrack(resolved);
            setDuration(durationS || resolved.duration || 0);
            setCurrentTimeRef.current(0);
            lastManualAdvanceAtRef.current = Date.now();
            // The preload is used up; the entry now playing may be preloaded again as its own next (a one-song loop).
            pendingGaplessNextRef.current = null;
            prewarmedKeyRef.current = null;
        };

        ctrl.on("gapless-advance", handleGaplessAdvance);
        return () => ctrl.off("gapless-advance", handleGaplessAdvance);
    }, [controller, setters, setDuration]);

    // -- Clear a stale gapless preload expectation --
    // Once playback leaves "track" mode or repeat flips to "one", any
    // preloaded next-track buffer can no longer be swapped in validly.
    useEffect(() => {
        if (media.playbackType !== "track" || playMode.repeatMode === "one") {
            dropExpectedNext();
        }
    }, [media.playbackType, playMode.repeatMode, dropExpectedNext]);

    // Gapless follows the queue: when an edit, a reorder, a shuffle or a replaced queue leaves the preloaded entry
    // no longer next, the engine would still swap to it while the player shows the entry that is next. Dropping
    // the preload lets the next time update preload the real next entry.
    useEffect(() => {
        const pending = pendingGaplessNextRef.current;
        if (!pending) return;
        const next = getNextTrackInfo(
            queueState.queue,
            queueState.currentIndex,
            playMode.isShuffle,
            queueState.shuffleIndices,
            playMode.repeatMode
        );
        if (next?.queueKey !== pending.queueKey) dropExpectedNext();
    }, [queueState.queue, queueState.currentIndex, playMode.isShuffle, queueState.shuffleIndices, playMode.repeatMode, dropExpectedNext]);

    // -- Canplay handler: duration update only --
    useEffect(() => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;

        const handleCanPlay = (data: unknown) => {
            const { duration: dur } = data as { duration: number };

            const audiobookDuration = playbackTypeRef.current === "audiobook"
                ? (currentAudiobookRef.current?.duration ?? 0) : 0;
            const fallback =
                currentTrackRef.current?.duration ||
                currentAudiobookRef.current?.duration ||
                currentPodcastRef.current?.duration || 0;
            setDuration(audiobookDuration || dur || fallback);
        };

        ctrl.on("canplay", handleCanPlay);
        return () => ctrl.off("canplay", handleCanPlay);
    }, [controller, setDuration]);

    // -- Error handler --
    useEffect(() => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;

        // Reset consecutive error count on any transition INTO "playing".

        const unsubscribePlayReset = ctrl.subscribe((snap) => {
            if (snap.status === "playing") {
                consecutiveErrorCountRef.current = 0;
            }
        });

        // "error" is terminal: the engine gave up on this src. A code-4 error may
        // be a 401 JSON body, so probe /api/auth/me (5s bound) first; on 401,
        // refresh and reload at the saved position. Anything else tears down. A
        // rejected refresh surfaces "Session expired" and playback ends.
        const doTeardown = () => {
            if (playbackTypeRef.current === "track") {
                consecutiveErrorCountRef.current++;
                if (queueRef.current.length <= 1) {
                    // Single track: retain + allow indefinite retry.
                    return;
                } else if (consecutiveErrorCountRef.current >= 3) {
                    setters.setCurrentTrack(null);
                    setters.setPlaybackType(null);
                } else {
                    // Multi-track: skip the bad track.
                    nextRef.current();
                }
            } else {
                // Single item (audiobook/podcast queues are always empty): retain
                // the item and playbackType so the shared player keeps rendering
                // (hasMedia + audioError), just persist progress before retry.
                if (playbackTypeRef.current === "audiobook") {
                    saveAudiobookProgressRef.current();
                }
                if (playbackTypeRef.current === "podcast") {
                    savePodcastProgressRef.current();
                }
            }
        };

        const handleError = (data: unknown) => {
            // Guard: if a classification is already in-flight, ignore duplicate events.
            if (errorClassifyingRef.current) return;

            const errCode = (data as { code?: number } | null)?.code;
            if (errCode !== 4) {
                doTeardown();
                return;
            }

            errorClassifyingRef.current = true;
            void (async () => {
                try {
                    const authHeader = api.getAuthHeader();
                    const probeUrl = `${getApiBaseUrl()}/api/auth/me`;
                    const ac = new AbortController();
                    const timer = setTimeout(() => ac.abort(), 5000);
                    let probeStatus = 0;
                    try {
                        const res = await fetch(probeUrl, {
                            headers: authHeader ? { Authorization: authHeader } : {},
                            signal: ac.signal,
                        });
                        probeStatus = res.status;
                    } catch {
                        // Probe failed (network/timeout): treat as non-401.
                    } finally {
                        clearTimeout(timer);
                    }

                    if (probeStatus !== 401) {
                        doTeardown();
                        return;
                    }

                    const result = await api.ensureFreshToken();

                    if (result === "refreshed") {
                        const ctrl2 = controllerRef.current;
                        if (!ctrl2) { doTeardown(); return; }

                        const position = ctrl2.getSnapshot().currentTime;
                        const type = playbackTypeRef.current;

                        if (type === "track") {
                            const track = currentTrackRef.current;
                            if (!track) { doTeardown(); return; }
                            ctrl2.load(api.getStreamUrl(track.id), { autoplay: true, seekTo: position, expectedDurationS: track.duration });
                        } else if (type === "audiobook") {
                            const book = currentAudiobookRef.current;
                            if (!book) { doTeardown(); return; }
                            ctrl2.load(
                                api.getAudiobookStreamUrl(book.id, book.trackIndex ?? 0),
                                { autoplay: true, seekTo: position }
                            );
                        } else if (type === "podcast") {
                            const pod = currentPodcastRef.current;
                            if (!pod) { doTeardown(); return; }
                            const [podcastId, episodeId] = pod.id.split(":");
                            ctrl2.load(
                                api.getPodcastEpisodeStreamUrl(podcastId, episodeId),
                                { autoplay: true, seekTo: position }
                            );
                        } else {
                            doTeardown();
                        }
                        return;
                    }

                    if (result === "rejected") {
                        notify.error("Session expired -- sign in again");
                    }
                    doTeardown();
                } finally {
                    errorClassifyingRef.current = false;
                }
            })();
        };

        ctrl.on("error", handleError);
        return () => {
            unsubscribePlayReset();
            ctrl.off("error", handleError);
        };
    }, [controller, setters]);

    // Save every 15s on a wall-clock timer while playing: iOS suspends
    // timeupdate with the screen off. Unchanged positions are de-duped.
    useEffect(() => {
        const ctrl = controllerRef.current;
        if (!ctrl) return;

        let interval: ReturnType<typeof setInterval> | null = null;
        const tick = () => {
            const type = playbackTypeRef.current;
            if (type !== "audiobook" && type !== "podcast") return;
            if (!controllerRef.current?.isPlaying()) return;
            if (controllerRef.current?.isTransitioning) return;
            if (type === "audiobook") saveAudiobookProgressRef.current();
            else savePodcastProgressRef.current();
        };
        const start = () => {
            if (interval) return;
            interval = setInterval(tick, 15000);
        };
        const stop = () => {
            if (interval) {
                clearInterval(interval);
                interval = null;
            }
        };

        const unsubscribe = ctrl.subscribe((snap) => {
            const { status } = snap;
            if (status === "playing") {
                start();
            } else {
                // Any non-playing status stops the interval.
                stop();
                // For pause-like exits (paused/error/blocked), save progress; after a natural end the save
                // functions send nothing (finishedRef).
                if (status === "paused" || status === "error" || status === "blocked") {
                    if (playbackTypeRef.current === "audiobook") saveAudiobookProgressRef.current();
                    else if (playbackTypeRef.current === "podcast") savePodcastProgressRef.current();
                }
            }
        });

        ctrl.on("ended", stop);
        if (ctrl.isPlaying()) start();

        return () => {
            stop();
            unsubscribe();
            ctrl.off("ended", stop);
        };
    }, [controller]);

    // -- Volume/mute sync --
    useEffect(() => { controllerRef.current?.setVolume(volumeState.volume); }, [volumeState.volume]);
    useEffect(() => { controllerRef.current?.setMuted(volumeState.isMuted); }, [volumeState.isMuted]);

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

        let deviceChangeAbort: (() => void) | undefined;
        try {
            const handler = () => {
                controllerRef.current?.notifyForeground();
            };
            navigator.mediaDevices?.addEventListener("devicechange", handler);
            deviceChangeAbort = () => navigator.mediaDevices?.removeEventListener("devicechange", handler);
        } catch {
            // API not available on this device/browser
        }

        document.addEventListener("visibilitychange", handleVisibility);
        window.addEventListener("pageshow", handlePageShow);
        window.addEventListener("pagehide", handlePageHide);
        return () => {
            document.removeEventListener("visibilitychange", handleVisibility);
            window.removeEventListener("pageshow", handlePageShow);
            window.removeEventListener("pagehide", handlePageHide);
            deviceChangeAbort?.();
        };
    }, []);

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

    const value = useMemo(
        () => ({
            playTrack,
            playTracks,
            playStation,
            playAudiobook,
            playAudiobookAt,
            playPodcast,
            nextPodcastEpisode,
            pause,
            resumeWithGesture,
            next,
            previous,
            addToQueue,
            playQueueIndex,
            removeFromQueue,
            clearQueue,
            setUpcoming,
            toggleShuffle,
            toggleRepeat,
            updateCurrentTime,
            seek,
            skipForward,
            skipBackward,
            openOverlay,
            closeOverlay,
            setVolume: setVolumeControl,
            toggleMute,
            startVibeMode,
            stopVibeMode,
            replaceOperation,
        }),
        [
            playTrack,
            playTracks,
            playStation,
            playAudiobook,
            playAudiobookAt,
            playPodcast,
            nextPodcastEpisode,
            pause,
            resumeWithGesture,
            next,
            previous,
            addToQueue,
            playQueueIndex,
            removeFromQueue,
            clearQueue,
            setUpcoming,
            toggleShuffle,
            toggleRepeat,
            updateCurrentTime,
            seek,
            skipForward,
            skipBackward,
            openOverlay,
            closeOverlay,
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
            <ConfirmDialog
                isOpen={pendingReplacement !== null}
                title={`Replace ${operationName(pendingReplacement?.currentOpName)}?`}
                message={`Start ${operationName(pendingReplacement?.newOpName)} instead. The current queue will be replaced.`}
                confirmText="Replace"
                variant="info"
                onConfirm={() => pendingReplacement?.resolve(true)}
                onClose={() => pendingReplacement?.resolve(false)}
            />
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
