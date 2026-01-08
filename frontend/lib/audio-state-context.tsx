"use client";

import {
    createContext,
    useContext,
    useState,
    useEffect,
    ReactNode,
    useMemo,
} from "react";
import { api } from "@/lib/api";
import type { Episode } from "@/features/podcast/types";

function queueDebugEnabled(): boolean {
    try {
        return (
            typeof window !== "undefined" &&
            window.localStorage?.getItem("lidifyQueueDebug") === "1"
        );
    } catch {
        return false;
    }
}

function queueDebugLog(message: string, data?: Record<string, unknown>) {
    if (!queueDebugEnabled()) return;
    // eslint-disable-next-line no-console
    console.log(`[QueueDebug] ${message}`, data || {});
}

export type PlayerMode = "full" | "mini" | "overlay";

// Audio features for vibe mode visualization
export interface AudioFeatures {
    bpm?: number | null;
    energy?: number | null;
    valence?: number | null;
    arousal?: number | null;
    danceability?: number | null;
    keyScale?: string | null;
    instrumentalness?: number | null;
    // ML Mood predictions (Enhanced mode)
    moodHappy?: number | null;
    moodSad?: number | null;
    moodRelaxed?: number | null;
    moodAggressive?: number | null;
    moodParty?: number | null;
    moodAcoustic?: number | null;
    moodElectronic?: number | null;
    analysisMode?: string | null;
}

export interface Track {
    id: string;
    title: string;
    artist: { name: string; id?: string; mbid?: string };
    album: { title: string; coverArt?: string; id?: string };
    duration: number;
    filePath?: string;
    // Metadata override fields
    displayTitle?: string | null;
    displayTrackNo?: number | null;
    hasUserOverrides?: boolean;
    // Audio features for vibe mode visualization
    audioFeatures?: {
        bpm?: number | null;
        energy?: number | null;
        valence?: number | null;
        arousal?: number | null;
        danceability?: number | null;
        keyScale?: string | null;
        instrumentalness?: number | null;
        analysisMode?: string | null;
        // ML mood predictions
        moodHappy?: number | null;
        moodSad?: number | null;
        moodRelaxed?: number | null;
        moodAggressive?: number | null;
        moodParty?: number | null;
        moodAcoustic?: number | null;
        moodElectronic?: number | null;
    } | null;
}

export interface Audiobook {
    id: string;
    title: string;
    author: string;
    narrator?: string;
    coverUrl: string | null;
    duration: number;
    progress?: {
        currentTime: number;
        progress: number;
        isFinished: boolean;
        lastPlayedAt: Date;
    } | null;
}

export interface Podcast {
    id: string; // Format: "podcastId:episodeId"
    title: string;
    podcastTitle: string;
    coverUrl: string | null;
    duration: number;
    progress?: {
        currentTime: number;
        progress: number;
        isFinished: boolean;
        lastPlayedAt: Date;
    } | null;
}

type SetStateAction<T> = T | ((prev: T) => T);

interface AudioStateContextType {
    // Media state
    currentTrack: Track | null;
    currentAudiobook: Audiobook | null;
    currentPodcast: Podcast | null;
    playbackType: "track" | "audiobook" | "podcast" | null;

    // Queue state
    queue: Track[];
    currentIndex: number;
    isShuffle: boolean;
    repeatMode: "off" | "one" | "all";
    isRepeat: boolean;
    shuffleIndices: number[];
    podcastEpisodeQueue: Episode[] | null;

    // UI state
    playerMode: PlayerMode;
    previousPlayerMode: PlayerMode;
    volume: number;
    isMuted: boolean;

    // Vibe mode state
    vibeMode: boolean;
    vibeSourceFeatures: AudioFeatures | null;
    vibeQueueIds: string[];

    // Internal state
    isHydrated: boolean;
    lastServerSync: Date | null;
    repeatOneCount: number;

    // State setters (for controls context)
    setCurrentTrack: (track: SetStateAction<Track | null>) => void;
    setCurrentAudiobook: (audiobook: SetStateAction<Audiobook | null>) => void;
    setCurrentPodcast: (podcast: SetStateAction<Podcast | null>) => void;
    setPlaybackType: (
        type: SetStateAction<"track" | "audiobook" | "podcast" | null>
    ) => void;
    setQueue: (queue: SetStateAction<Track[]>) => void;
    setCurrentIndex: (index: SetStateAction<number>) => void;
    setIsShuffle: (shuffle: SetStateAction<boolean>) => void;
    setRepeatMode: (mode: SetStateAction<"off" | "one" | "all">) => void;
    setShuffleIndices: (indices: SetStateAction<number[]>) => void;
    setPodcastEpisodeQueue: (queue: SetStateAction<Episode[] | null>) => void;
    setPlayerMode: (mode: SetStateAction<PlayerMode>) => void;
    setPreviousPlayerMode: (mode: SetStateAction<PlayerMode>) => void;
    setVolume: (volume: SetStateAction<number>) => void;
    setIsMuted: (muted: SetStateAction<boolean>) => void;
    setLastServerSync: (date: SetStateAction<Date | null>) => void;
    setRepeatOneCount: (count: SetStateAction<number>) => void;
    setVibeMode: (mode: SetStateAction<boolean>) => void;
    setVibeSourceFeatures: (
        features: SetStateAction<AudioFeatures | null>
    ) => void;
    setVibeQueueIds: (ids: SetStateAction<string[]>) => void;
}

const AudioStateContext = createContext<AudioStateContextType | undefined>(
    undefined
);

// LocalStorage keys
const STORAGE_KEYS = {
    CURRENT_TRACK: "lidify_current_track",
    CURRENT_AUDIOBOOK: "lidify_current_audiobook",
    CURRENT_PODCAST: "lidify_current_podcast",
    PLAYBACK_TYPE: "lidify_playback_type",
    QUEUE: "lidify_queue",
    CURRENT_INDEX: "lidify_current_index",
    IS_SHUFFLE: "lidify_is_shuffle",
    REPEAT_MODE: "lidify_repeat_mode",
    PLAYER_MODE: "lidify_player_mode",
    VOLUME: "lidify_volume",
    IS_MUTED: "lidify_muted",
    PODCAST_EPISODE_QUEUE: "lidify_podcast_episode_queue",
};

export function AudioStateProvider({ children }: { children: ReactNode }) {
    const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
    const [currentAudiobook, setCurrentAudiobook] = useState<Audiobook | null>(
        null
    );
    const [currentPodcast, setCurrentPodcast] = useState<Podcast | null>(null);
    const [playbackType, setPlaybackType] = useState<
        "track" | "audiobook" | "podcast" | null
    >(null);
    const [queue, setQueue] = useState<Track[]>([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [isShuffle, setIsShuffle] = useState(false);
    const [shuffleIndices, setShuffleIndices] = useState<number[]>([]);
    const [repeatMode, setRepeatMode] = useState<"off" | "one" | "all">("off");
    const [repeatOneCount, setRepeatOneCount] = useState(0);
    const [podcastEpisodeQueue, setPodcastEpisodeQueue] = useState<Episode[] | null>(null);
    const [playerMode, setPlayerMode] = useState<PlayerMode>("full");
    const [previousPlayerMode, setPreviousPlayerMode] =
        useState<PlayerMode>("full");
    const [volume, setVolume] = useState(0.5); // Default to 50%
    const [isMuted, setIsMuted] = useState(false);
    const [isHydrated, setIsHydrated] = useState(false);
    const [lastServerSync, setLastServerSync] = useState<Date | null>(null);

    // Vibe mode state
    const [vibeMode, setVibeMode] = useState(false);
    const [vibeSourceFeatures, setVibeSourceFeatures] =
        useState<AudioFeatures | null>(null);
    const [vibeQueueIds, setVibeQueueIds] = useState<string[]>([]);

    // Restore state from localStorage on mount
    useEffect(() => {
        if (typeof window === "undefined") return;

        try {
            const savedTrack = localStorage.getItem(STORAGE_KEYS.CURRENT_TRACK);
            const savedAudiobook = localStorage.getItem(
                STORAGE_KEYS.CURRENT_AUDIOBOOK
            );
            const savedPodcast = localStorage.getItem(
                STORAGE_KEYS.CURRENT_PODCAST
            );
            const savedPlaybackType = localStorage.getItem(
                STORAGE_KEYS.PLAYBACK_TYPE
            );
            const savedQueue = localStorage.getItem(STORAGE_KEYS.QUEUE);
            const savedIndex = localStorage.getItem(STORAGE_KEYS.CURRENT_INDEX);
            const savedShuffle = localStorage.getItem(STORAGE_KEYS.IS_SHUFFLE);
            const savedRepeatMode = localStorage.getItem(
                STORAGE_KEYS.REPEAT_MODE
            );
            const savedPodcastQueue = localStorage.getItem(
                STORAGE_KEYS.PODCAST_EPISODE_QUEUE
            );
            const savedPlayerMode = localStorage.getItem(
                STORAGE_KEYS.PLAYER_MODE
            );
            const savedVolume = localStorage.getItem(STORAGE_KEYS.VOLUME);
            const savedMuted = localStorage.getItem(STORAGE_KEYS.IS_MUTED);

            if (savedTrack) setCurrentTrack(JSON.parse(savedTrack));

            // For audiobooks, restore then fetch fresh progress
            if (savedAudiobook) {
                const audiobookData = JSON.parse(savedAudiobook);
                setCurrentAudiobook(audiobookData);

                api.getAudiobook(audiobookData.id)
                    .then((audiobook: any) => {
                        if (audiobook && audiobook.progress) {
                            setCurrentAudiobook({
                                ...audiobookData,
                                progress: audiobook.progress,
                            });
                        }
                    })
                    .catch((err: any) => {
                        console.error(
                            "[AudioState] Failed to refresh audiobook progress:",
                            err
                        );
                    });
            }

            // For podcasts, restore then fetch fresh progress
            if (savedPodcast) {
                const podcastData = JSON.parse(savedPodcast);
                setCurrentPodcast(podcastData);

                const [podcastId, episodeId] = podcastData.id.split(":");
                if (podcastId && episodeId) {
                    api.getPodcast(podcastId)
                        .then((podcast: any) => {
                            const episode = podcast.episodes?.find(
                                (ep: any) => ep.id === episodeId
                            );
                            if (episode && episode.progress) {
                                setCurrentPodcast({
                                    ...podcastData,
                                    progress: episode.progress,
                                });
                            }
                        })
                        .catch((err: any) => {
                            console.error(
                                "[AudioState] Failed to refresh podcast progress:",
                                err
                            );
                        });
                }
            }

            if (savedPlaybackType)
                setPlaybackType(
                    savedPlaybackType as "track" | "audiobook" | "podcast"
                );
            if (savedQueue) setQueue(JSON.parse(savedQueue));
            if (savedIndex) setCurrentIndex(parseInt(savedIndex));
            if (savedShuffle) setIsShuffle(savedShuffle === "true");
            if (savedRepeatMode)
                setRepeatMode(savedRepeatMode as "off" | "one" | "all");
            if (savedPodcastQueue) setPodcastEpisodeQueue(JSON.parse(savedPodcastQueue));
            if (savedVolume) setVolume(parseFloat(savedVolume));
            if (savedMuted) setIsMuted(savedMuted === "true");
            if (savedPlayerMode) setPlayerMode(savedPlayerMode as PlayerMode);
        } catch (error) {
            console.error("[AudioState] Failed to restore state:", error);
        }
        setIsHydrated(true);

        // Load playback state from server
        api.getPlaybackState()
            .then((serverState) => {
                if (!serverState) return;

                if (
                    serverState.playbackType === "track" &&
                    serverState.trackId
                ) {
                    api.getTrack(serverState.trackId)
                        .then((track) => {
                            setCurrentTrack(track);
                            setPlaybackType("track");
                            setCurrentAudiobook(null);
                            setCurrentPodcast(null);
                        })
                        .catch(() => {
                            api.clearPlaybackState().catch(() => {});
                            setCurrentTrack(null);
                            setCurrentAudiobook(null);
                            setCurrentPodcast(null);
                            setPlaybackType(null);
                            setQueue([]);
                            setCurrentIndex(0);
                        });
                } else if (
                    serverState.playbackType === "audiobook" &&
                    serverState.audiobookId
                ) {
                    api.getAudiobook(serverState.audiobookId).then(
                        (audiobook) => {
                            setCurrentAudiobook(audiobook);
                            setPlaybackType("audiobook");
                            setCurrentTrack(null);
                            setCurrentPodcast(null);
                        }
                    );
                } else if (
                    serverState.playbackType === "podcast" &&
                    serverState.podcastId
                ) {
                    const [podcastId, episodeId] =
                        serverState.podcastId.split(":");
                    api.getPodcast(podcastId).then((podcast) => {
                        const episode = podcast.episodes?.find(
                            (ep: any) => ep.id === episodeId
                        );
                        if (episode) {
                            setCurrentPodcast({
                                id: serverState.podcastId,
                                title: episode.title,
                                podcastTitle: podcast.title,
                                coverUrl: podcast.coverUrl,
                                duration: episode.duration,
                                progress: episode.progress,
                            });
                            setPlaybackType("podcast");
                            setCurrentTrack(null);
                            setCurrentAudiobook(null);
                        }
                    });
                }

                if (serverState.queue) setQueue(serverState.queue);
                if (serverState.currentIndex !== undefined)
                    setCurrentIndex(serverState.currentIndex);
                if (serverState.isShuffle !== undefined)
                    setIsShuffle(serverState.isShuffle);
            })
            .catch(() => {
                // No server state available - this is expected on first load
            });
    }, []);

    // Save state to localStorage whenever it changes
    useEffect(() => {
        if (!isHydrated || typeof window === "undefined") return;

        try {
            if (currentTrack) {
                localStorage.setItem(
                    STORAGE_KEYS.CURRENT_TRACK,
                    JSON.stringify(currentTrack)
                );
            } else {
                localStorage.removeItem(STORAGE_KEYS.CURRENT_TRACK);
            }
            if (currentAudiobook) {
                localStorage.setItem(
                    STORAGE_KEYS.CURRENT_AUDIOBOOK,
                    JSON.stringify(currentAudiobook)
                );
            } else {
                localStorage.removeItem(STORAGE_KEYS.CURRENT_AUDIOBOOK);
            }
            if (currentPodcast) {
                localStorage.setItem(
                    STORAGE_KEYS.CURRENT_PODCAST,
                    JSON.stringify(currentPodcast)
                );
            } else {
                localStorage.removeItem(STORAGE_KEYS.CURRENT_PODCAST);
            }
            if (playbackType) {
                localStorage.setItem(STORAGE_KEYS.PLAYBACK_TYPE, playbackType);
            } else {
                localStorage.removeItem(STORAGE_KEYS.PLAYBACK_TYPE);
            }
            localStorage.setItem(STORAGE_KEYS.QUEUE, JSON.stringify(queue));
            localStorage.setItem(
                STORAGE_KEYS.CURRENT_INDEX,
                currentIndex.toString()
            );
            localStorage.setItem(STORAGE_KEYS.IS_SHUFFLE, isShuffle.toString());
            localStorage.setItem(STORAGE_KEYS.REPEAT_MODE, repeatMode);
            if (podcastEpisodeQueue) {
                localStorage.setItem(
                    STORAGE_KEYS.PODCAST_EPISODE_QUEUE,
                    JSON.stringify(podcastEpisodeQueue)
                );
            } else {
                localStorage.removeItem(STORAGE_KEYS.PODCAST_EPISODE_QUEUE);
            }
            localStorage.setItem(STORAGE_KEYS.PLAYER_MODE, playerMode);
            localStorage.setItem(STORAGE_KEYS.VOLUME, volume.toString());
            localStorage.setItem(STORAGE_KEYS.IS_MUTED, isMuted.toString());
        } catch (error) {
            console.error("[AudioState] Failed to save state:", error);
        }
    }, [
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        queue,
        currentIndex,
        isShuffle,
        repeatMode,
        podcastEpisodeQueue,
        playerMode,
        volume,
        isMuted,
        isHydrated,
    ]);

    // Save playback state to server
    useEffect(() => {
        if (!isHydrated) return;
        if (!playbackType) return;

        const saveToServer = async () => {
            try {
                // Limit queue to first 100 items to reduce payload size
                // Backend also limits to 100, so this matches server storage
                const limitedQueue = queue?.slice(0, 100);
                const adjustedIndex = Math.min(
                    currentIndex,
                    (limitedQueue?.length || 1) - 1
                );

                const result = await api.savePlaybackState({
                    playbackType,
                    trackId: currentTrack?.id,
                    audiobookId: currentAudiobook?.id,
                    podcastId: currentPodcast?.id,
                    queue: limitedQueue,
                    currentIndex: adjustedIndex,
                    isShuffle,
                });
                setLastServerSync(new Date(result.updatedAt));
                queueDebugLog("Saved playback state to server", {
                    playbackType,
                    trackId: currentTrack?.id,
                    queueLen: limitedQueue?.length || 0,
                    currentIndex: adjustedIndex,
                    isShuffle,
                    updatedAt: result.updatedAt,
                });
            } catch (err: any) {
                if (err.message !== "Not authenticated") {
                    console.error(
                        "[AudioState] Failed to save to server:",
                        err
                    );
                }
            }
        };

        const timeoutId = setTimeout(saveToServer, 1000);
        return () => clearTimeout(timeoutId);
    }, [
        playbackType,
        currentTrack?.id,
        currentAudiobook?.id,
        currentPodcast?.id,
        queue,
        currentIndex,
        isShuffle,
        isHydrated,
    ]);

    // Poll server for changes from other devices (pauses when tab is hidden)
    useEffect(() => {
        if (!isHydrated) return;
        if (typeof document === "undefined") return;

        let isAuthenticated = true;
        let mounted = true;
        let isVisible = !document.hidden;

        // Handle visibility changes to save battery/resources
        const handleVisibilityChange = () => {
            isVisible = !document.hidden;
        };
        document.addEventListener("visibilitychange", handleVisibilityChange);

        const pollInterval = setInterval(async () => {
            // Skip polling when tab is hidden, unmounted, or not authenticated
            if (!isAuthenticated || !mounted || !isVisible) return;

            try {
                const serverState = await api.getPlaybackState();
                if (!serverState || !mounted) return;

                const serverUpdatedAt = new Date(serverState.updatedAt);

                if (lastServerSync && serverUpdatedAt <= lastServerSync) {
                    return;
                }

                const serverMediaId =
                    serverState.trackId ||
                    serverState.audiobookId ||
                    serverState.podcastId;
                const currentMediaId =
                    currentTrack?.id ||
                    currentAudiobook?.id ||
                    currentPodcast?.id;

                if (
                    serverMediaId !== currentMediaId ||
                    serverState.playbackType !== playbackType
                ) {
                    if (
                        serverState.playbackType === "track" &&
                        serverState.trackId
                    ) {
                        try {
                            const track = await api.getTrack(
                                serverState.trackId
                            );
                            if (!mounted) return;
                            setCurrentTrack(track);
                            setPlaybackType("track");
                            setCurrentAudiobook(null);
                            setCurrentPodcast(null);
                            if (
                                serverState.queue &&
                                serverState.queue.length > 0
                            ) {
                                setQueue(serverState.queue);
                                setCurrentIndex(serverState.currentIndex || 0);
                                setIsShuffle(serverState.isShuffle || false);
                            }
                        } catch (trackErr) {
                            if (!mounted) return;
                            await api.clearPlaybackState().catch(() => {});
                            setCurrentTrack(null);
                            setCurrentAudiobook(null);
                            setCurrentPodcast(null);
                            setPlaybackType(null);
                            setQueue([]);
                            setCurrentIndex(0);
                            return;
                        }
                    } else if (
                        serverState.playbackType === "audiobook" &&
                        serverState.audiobookId
                    ) {
                        const audiobook = await api.getAudiobook(
                            serverState.audiobookId
                        );
                        if (!mounted) return;
                        setCurrentAudiobook(audiobook);
                        setPlaybackType("audiobook");
                        setCurrentTrack(null);
                        setCurrentPodcast(null);
                    } else if (
                        serverState.playbackType === "podcast" &&
                        serverState.podcastId
                    ) {
                        const [podcastId, episodeId] =
                            serverState.podcastId.split(":");
                        const podcast = await api.getPodcast(podcastId);
                        if (!mounted) return;
                        const episode = podcast.episodes?.find(
                            (ep: any) => ep.id === episodeId
                        );
                        if (episode) {
                            setCurrentPodcast({
                                id: serverState.podcastId,
                                title: episode.title,
                                podcastTitle: podcast.title,
                                coverUrl: podcast.coverUrl,
                                duration: episode.duration,
                                progress: episode.progress,
                            });
                            setPlaybackType("podcast");
                            setCurrentTrack(null);
                            setCurrentAudiobook(null);
                        }
                    }

                    if (!mounted) return;
                    if (
                        JSON.stringify(serverState.queue) !==
                        JSON.stringify(queue)
                    ) {
                        queueDebugLog("Polling applied server queue", {
                            serverQueueLen: serverState.queue?.length || 0,
                            localQueueLen: queue?.length || 0,
                            serverCurrentIndex: serverState.currentIndex || 0,
                            localCurrentIndex: currentIndex,
                            serverIsShuffle: serverState.isShuffle,
                            localIsShuffle: isShuffle,
                            serverUpdatedAt: serverState.updatedAt,
                        });
                        setQueue(serverState.queue || []);
                        setCurrentIndex(serverState.currentIndex || 0);
                        setIsShuffle(serverState.isShuffle || false);
                    }

                    setLastServerSync(serverUpdatedAt);
                }
            } catch (err: any) {
                if (err.message === "Not authenticated") {
                    isAuthenticated = false;
                    clearInterval(pollInterval);
                }
            }
        }, 30000);

        return () => {
            mounted = false;
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange
            );
            clearInterval(pollInterval);
        };
    }, [
        isHydrated,
        playbackType,
        currentTrack?.id,
        currentAudiobook?.id,
        currentPodcast?.id,
        queue,
        lastServerSync,
    ]);

    // Memoize the context value to prevent unnecessary re-renders
    const value = useMemo(
        () => ({
            currentTrack,
            currentAudiobook,
            currentPodcast,
            playbackType,
            queue,
            currentIndex,
            isShuffle,
            repeatMode,
            isRepeat: repeatMode !== "off",
            shuffleIndices,
            podcastEpisodeQueue,
            playerMode,
            previousPlayerMode,
            volume,
            isMuted,
            vibeMode,
            vibeSourceFeatures,
            vibeQueueIds,
            isHydrated,
            lastServerSync,
            repeatOneCount,
            setCurrentTrack,
            setCurrentAudiobook,
            setCurrentPodcast,
            setPlaybackType,
            setQueue,
            setCurrentIndex,
            setIsShuffle,
            setRepeatMode,
            setShuffleIndices,
            setPodcastEpisodeQueue,
            setPlayerMode,
            setPreviousPlayerMode,
            setVolume,
            setIsMuted,
            setLastServerSync,
            setRepeatOneCount,
            setVibeMode,
            setVibeSourceFeatures,
            setVibeQueueIds,
        }),
        [
            currentTrack,
            currentAudiobook,
            currentPodcast,
            playbackType,
            queue,
            currentIndex,
            isShuffle,
            repeatMode,
            shuffleIndices,
            podcastEpisodeQueue,
            playerMode,
            previousPlayerMode,
            volume,
            isMuted,
            vibeMode,
            vibeSourceFeatures,
            vibeQueueIds,
            isHydrated,
            lastServerSync,
            repeatOneCount,
        ]
    );

    return (
        <AudioStateContext.Provider value={value}>
            {children}
        </AudioStateContext.Provider>
    );
}

export function useAudioState() {
    const context = useContext(AudioStateContext);
    if (!context) {
        throw new Error("useAudioState must be used within AudioStateProvider");
    }
    return context;
}
