"use client";

import {
    createContext,
    useContext,
    useState,
    useEffect,
    useRef,
    ReactNode,
    useMemo,
    useCallback,
    type SetStateAction,
} from "react";
import { api } from "@/lib/api";
import { episodeForPlayer, type ShowWithEpisodes } from "./podcast-episode";
import { STORAGE_KEYS } from "./storage-keys";
import { useAudioController } from "./audio-controller-context";
import { withQueueKeys, withoutQueueKeys } from "./queue-key";


/** A song as the player holds it. */
export interface Track {
    id: string;
    title: string;
    artist: { name: string; id?: string; mbid?: string };
    album: { title: string; coverArt?: string; id?: string };
    duration: number;
    // A listener's edits to the song's tags.
    displayTitle?: string | null;
    displayTrackNo?: number | null;
    hasUserOverrides?: boolean;
    /**
     * Which entry of the queue this is, so two entries of one song stay apart. The queue gives every entry one; a
     * queue from a playlist uses the playlist item's id. Browser only: the server's copy of the queue has none.
     */
    queueKey?: string;
}

/** A queue started from a page: its source, and the keys of its entries (those the start put in, and those added to it since). */
export interface QueueOrigin {
    source: string;
    keys: ReadonlySet<string>;
}

/** The origin of a queue whose every entry came from the source. */
function originOf(queue: Track[], source: string): QueueOrigin {
    return { source, keys: new Set(queue.map((entry) => entry.queueKey!)) };
}

export interface AudiobookTrack {
    index: number;
    startOffset: number;
    duration: number;
}

export interface Audiobook {
    id: string;
    title: string;
    author: string;
    narrator?: string;
    coverUrl: string | null;
    duration: number;
    tracks?: AudiobookTrack[];
    trackCount?: number;
    trackIndex?: number;
    trackOffset?: number;
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

export type VibeOperation =
    | { type: 'idle' }
    | { type: 'vibe'; sourceTrackId: string; matches: Record<string, number>; trackIds: string[] }
    | { type: 'drift'; startTrackId: string; endTrackId: string; pathTrackIds: string[] }
    | { type: 'blend'; addTrackIds: string[]; subtractTrackIds: string[]; resultTrackIds: string[] }
    | { type: 'similar'; sourceTrackId: string; trackIds: string[] };

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
    shuffleIndices: number[];
    /** The key of the queue entry that is playing, or null when no queue entry is. */
    currentQueueKey: string | null;
    /**
     * Where the queue that is playing came from (see `queue-source.ts`), or null when the entry that is playing is not
     * from a queue a page's play button started: a song added to that queue stays with it, a queue another play
     * replaced does not. Saved with the queue, so a reload keeps it.
     */
    currentQueueSource: string | null;

    // UI state
    /** Whether the full-screen player is open over the page. */
    overlayOpen: boolean;
    volume: number;
    isMuted: boolean;

    // Vibe operation state
    activeOperation: VibeOperation;

    // Internal state
    repeatOneCount: number;

    // State setters (for controls context)
    setCurrentTrack: (track: SetStateAction<Track | null>) => void;
    setCurrentAudiobook: (audiobook: SetStateAction<Audiobook | null>) => void;
    setCurrentPodcast: (podcast: SetStateAction<Podcast | null>) => void;
    setPlaybackType: (
        type: SetStateAction<"track" | "audiobook" | "podcast" | null>
    ) => void;
    setQueue: (queue: SetStateAction<Track[]>) => void;
    /** Records which entries a page's play button put in the queue. Entries a play replaced it with are not among them. */
    setQueueOrigin: (origin: QueueOrigin | null) => void;
    /** Songs joining the queue (add to queue, play next) belong to the page it came from. */
    extendQueueOrigin: (keys: string[]) => void;
    setCurrentIndex: (index: SetStateAction<number>) => void;
    setIsShuffle: (shuffle: SetStateAction<boolean>) => void;
    setRepeatMode: (mode: SetStateAction<"off" | "one" | "all">) => void;
    setShuffleIndices: (indices: SetStateAction<number[]>) => void;
    setOverlayOpen: (open: SetStateAction<boolean>) => void;
    setVolume: (volume: SetStateAction<number>) => void;
    setIsMuted: (muted: SetStateAction<boolean>) => void;
    setRepeatOneCount: (count: SetStateAction<number>) => void;
    setActiveOperation: (op: SetStateAction<VibeOperation>) => void;
}

const AudioStateContext = createContext<AudioStateContextType | undefined>(
    undefined
);

function readStorage(key: string): string | null {
    if (typeof window === "undefined") return null;
    try { return localStorage.getItem(key); } catch { return null; }
}

function parseStorageJson<T>(key: string, fallback: T): T {
    const raw = readStorage(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/**
 * Only a 404 means the item is gone. Any other failure, such as a timeout or a
 * 500, is retried later rather than discarding what the user was listening to.
 */
function isGone(err: unknown): boolean {
    return (err as { status?: number } | null)?.status === 404;
}

/**
 * What a saved playback state says, as a string to compare: the item, the queue (cut to the server's limit, as a save
 * cuts it, and compared whole so an edited title still saves), the position in it and shuffle. Equal keys mean saving
 * would change nothing.
 */
function playbackKey(
    state: {
        playbackType?: string | null;
        trackId?: string | null;
        audiobookId?: string | null;
        podcastId?: string | null;
        queue?: Array<{ id: string; queueKey?: string }> | null;
        queueSource?: string | null;
        currentIndex?: number | null;
        isShuffle?: boolean | null;
    },
    queueLimit: number,
): string {
    const queue = withoutQueueKeys((state.queue ?? []).slice(0, queueLimit));
    return JSON.stringify([
        state.playbackType ?? null,
        state.trackId ?? null,
        state.audiobookId ?? null,
        state.podcastId ?? null,
        queue,
        state.queueSource ?? null,
        Math.min(state.currentIndex ?? 0, (queue.length || 1) - 1),
        !!state.isShuffle,
    ]);
}

/** Forget a stored item that the server no longer has. */
function forgetStorage(key: string): void {
    if (typeof window === "undefined") return;
    try { localStorage.removeItem(key); } catch { /* storage may be unavailable */ }
}

export function AudioStateProvider({ children }: { children: ReactNode }) {
    const controller = useAudioController();
    // Don't restore currentTrack from localStorage. The server state API is the
    // source of truth for what was playing. This prevents ghost tracks appearing
    // in the player when the track is no longer available or queued.
    const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
    const [currentAudiobook, setCurrentAudiobook] = useState<Audiobook | null>(
        () => parseStorageJson(STORAGE_KEYS.CURRENT_AUDIOBOOK, null)
    );
    const [currentPodcast, setCurrentPodcast] = useState<Podcast | null>(
        () => parseStorageJson(STORAGE_KEYS.CURRENT_PODCAST, null)
    );
    const [playbackType, setPlaybackType] = useState<
        "track" | "audiobook" | "podcast" | null
    >(() => {
        const stored = readStorage(STORAGE_KEYS.PLAYBACK_TYPE) as "track" | "audiobook" | "podcast" | null;
        // "track" type is not restored from localStorage.
        // Server state will re-set this if there was an active track.
        return stored === "track" ? null : stored;
    });
    const [queue, setQueueRaw] = useState<Track[]>([]);
    const [queueOrigin, setQueueOrigin] = useState<QueueOrigin | null>(null);
    // Songs joining a queue (add to queue, play next) belong to the page the queue came from.
    const extendQueueOrigin = useCallback(
        (keys: string[]) =>
            setQueueOrigin((prev) => (prev && keys.length > 0 ? { source: prev.source, keys: new Set([...prev.keys, ...keys]) } : prev)),
        [],
    );
    // Every queue that is set has every entry keyed, whichever way it arrives (a play, an edit, a restore).
    const setQueue = useCallback(
        (action: SetStateAction<Track[]>) =>
            // A queue given whole is keyed outside the updater, so the updater stays pure.
            setQueueRaw(
                typeof action === "function" ? (prev) => withQueueKeys(action(prev)) : withQueueKeys(action),
            ),
        [],
    );

    // A queue another device saved takes the place of this one, with the page it came from.
    const adoptQueue = useCallback(
        (serverQueue: Track[], source: string | null | undefined) => {
            const arrived = withQueueKeys(serverQueue);
            setQueue(arrived);
            setQueueOrigin(source ? originOf(arrived, source) : null);
        },
        [setQueue],
    );
    /**
     * The server's queue ceiling, fetched once. A ref so its arrival does not
     * re-run the save effect; starts at the server's own default.
     */
    const queueLimitRef = useRef(10000);

    useEffect(() => {
        let cancelled = false;
        api.getQueueLimit()
            .then((r) => {
                if (!cancelled && Number.isFinite(r?.maxQueueLength)) {
                    queueLimitRef.current = r.maxQueueLength;
                }
            })
            .catch(() => {
                // The default stands. A queue that saves slightly short is a
                // far smaller problem than one that does not save.
            });
        return () => { cancelled = true; };
    }, []);
    const [currentIndex, setCurrentIndex] = useState(
        () => { const v = readStorage(STORAGE_KEYS.CURRENT_INDEX); return v ? parseInt(v) : 0; }
    );
    const [isShuffle, setIsShuffle] = useState(
        () => readStorage(STORAGE_KEYS.IS_SHUFFLE) === "true"
    );
    const [shuffleIndices, setShuffleIndices] = useState<number[]>([]);
    const [repeatMode, setRepeatMode] = useState<"off" | "one" | "all">(
        () => (readStorage(STORAGE_KEYS.REPEAT_MODE) as "off" | "one" | "all") ?? "off"
    );
    const [repeatOneCount, setRepeatOneCount] = useState(0);
    // Stored as "overlay" while it is open; any other value (an older visit's "mini" or "full") reads as closed.
    const [overlayOpen, setOverlayOpen] = useState(() => readStorage(STORAGE_KEYS.PLAYER_MODE) === "overlay");
    const [volume, setVolume] = useState(
        () => { const v = readStorage(STORAGE_KEYS.VOLUME); return v ? parseFloat(v) : 0.5; }
    );
    const [isMuted, setIsMuted] = useState(
        () => readStorage(STORAGE_KEYS.IS_MUTED) === "true"
    );
    const [lastServerSync, setLastServerSync] = useState<Date | null>(null);
    // What the server is known to hold, as a playbackKey. Restoring or adopting the server's state is not a change,
    // so the save effect skips a state equal to it instead of writing it straight back.
    const serverKnownRef = useRef<string | null>(null);
    // A restore that failed left this page without what the server holds, so its first state is no listener's choice.
    const restoreFailedRef = useRef(false);
    const storedMediaRef = useRef<string | null>(currentAudiobook?.id ?? currentPodcast?.id ?? null);
    // Saves wait until the page-load restore has finished, so none goes out half-restored (the song still on its way).
    const [restoreSettled, setRestoreSettled] = useState(false);

    // Refs for polling effect to avoid restarting the interval on every state change
    const lastServerSyncRef = useRef(lastServerSync);
    useEffect(() => { lastServerSyncRef.current = lastServerSync; }, [lastServerSync]);
    const queueRef = useRef(queue);
    // When the queue last changed on THIS device. The cross-device poller needs it to tell
    // "another device changed the queue" from "my own change has not been uploaded yet".
    const localChangedAtRef = useRef<Date>(new Date(0));
    useEffect(() => {
        queueRef.current = queue;
        localChangedAtRef.current = new Date();
    }, [queue]);
    useEffect(() => {
        localChangedAtRef.current = new Date();
    }, [currentTrack?.id, currentAudiobook?.id, currentPodcast?.id]);
    const currentIndexRef = useRef(currentIndex);
    useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);
    const isShuffleRef = useRef(isShuffle);
    useEffect(() => { isShuffleRef.current = isShuffle; }, [isShuffle]);

    // Vibe operation state
    const [activeOperation, setActiveOperation] = useState<VibeOperation>({ type: 'idle' });

    // Refresh audiobook/podcast progress from API on mount, then sync with server
    useEffect(() => {
        if (typeof window === "undefined") return;

        // Fetch fresh audiobook progress
        const savedAudiobook = readStorage(STORAGE_KEYS.CURRENT_AUDIOBOOK);
        if (savedAudiobook) {
            try {
                const audiobookData = JSON.parse(savedAudiobook);
                api.getAudiobook(audiobookData.id)
                    .then((audiobook: { progress?: { currentTime: number; progress: number; isFinished: boolean } }) => {
                        if (audiobook && audiobook.progress) {
                            setCurrentAudiobook({
                                ...audiobookData,
                                progress: audiobook.progress,
                            });
                        }
                    })
                    .catch((err: unknown) => {
                        // The audiobook is gone -- removed from the library, or the
                        // Audiobookshelf connection no longer serves it. Drop it, or the
                        // stored id outlives it and every future page load repeats this
                        // request and this error, forever.
                        if (isGone(err)) {
                            forgetStorage(STORAGE_KEYS.CURRENT_AUDIOBOOK);
                            setCurrentAudiobook(null);
                            setPlaybackType((type) => (type === "audiobook" ? null : type));
                            return;
                        }
                        console.error(
                            "[AudioState] Failed to refresh audiobook progress:",
                            err
                        );
                    });
            } catch { /* ignore parse errors */ }
        }

        // Fetch fresh podcast progress
        const savedPodcast = readStorage(STORAGE_KEYS.CURRENT_PODCAST);
        if (savedPodcast) {
            try {
                const podcastData = JSON.parse(savedPodcast);
                const [podcastId, episodeId] = podcastData.id.split(":");
                if (podcastId && episodeId) {
                    api.getPodcast(podcastId)
                        .then((podcast: ShowWithEpisodes) => {
                            const episode = podcast.episodes?.find((ep) => ep.id === episodeId);
                            if (episode && episode.progress) {
                                setCurrentPodcast({
                                    ...podcastData,
                                    progress: episode.progress,
                                });
                            }
                        })
                        .catch((err: unknown) => {
                            // Unsubscribed, or the podcast was removed. Keeping the id
                            // means refetching a 404 on every single page load and
                            // showing a player for something that is not there any more.
                            if (isGone(err)) {
                                forgetStorage(STORAGE_KEYS.CURRENT_PODCAST);
                                setCurrentPodcast(null);
                                setPlaybackType((type) => (type === "podcast" ? null : type));
                                return;
                            }
                            console.error(
                                "[AudioState] Failed to refresh podcast progress:",
                                err
                            );
                        });
                }
            } catch { /* ignore parse errors */ }
        }

        // Clear a server-restored item that turns out not to exist, unless
        // something has been queued since: live playback beats a stale restore.
        const clearRestoredPlayback = () => {
            if (queueRef.current.length > 0) return;
            setCurrentTrack(null);
            setCurrentAudiobook(null);
            setCurrentPodcast(null);
            setPlaybackType(null);
            setQueue([]);
            setCurrentIndex(0);
        };

        // The server remembers an item that is gone: forget it and clear what the restore put on screen.
        const dropIfGone = (err: unknown) => {
            if (!isGone(err)) {
                restoreFailedRef.current = true;
                return;
            }
            serverKnownRef.current = null;
            api.clearPlaybackState().catch(() => {});
            clearRestoredPlayback();
        };

        api.getPlaybackState()
            .then((serverState) => {
                if (!serverState) return;

                serverKnownRef.current = playbackKey(serverState, queueLimitRef.current);
                if (serverState.updatedAt) setLastServerSync(new Date(serverState.updatedAt));

                let restoringMedia: Promise<unknown> = Promise.resolve();
                if (
                    serverState.playbackType === "track" &&
                    serverState.trackId
                ) {
                    restoringMedia = api.getTrack(serverState.trackId)
                        .then((track) => {
                            setCurrentTrack(track);
                            setPlaybackType("track");
                            setCurrentAudiobook(null);
                            setCurrentPodcast(null);
                        })
                        .catch(dropIfGone);
                } else if (
                    serverState.playbackType === "audiobook" &&
                    serverState.audiobookId
                ) {
                    restoringMedia = api.getAudiobook(serverState.audiobookId)
                        .then((audiobook) => {
                            setCurrentAudiobook(audiobook);
                            setPlaybackType("audiobook");
                            setCurrentTrack(null);
                            setCurrentPodcast(null);
                        })
                        .catch(dropIfGone);
                } else if (
                    serverState.playbackType === "podcast" &&
                    serverState.podcastId
                ) {
                    const [podcastId, episodeId] =
                        serverState.podcastId.split(":");
                    restoringMedia = api.getPodcast(podcastId)
                        .then((podcast: ShowWithEpisodes) => {
                            const episode = podcast.episodes?.find((ep) => ep.id === episodeId);
                            if (episode) {
                                setCurrentPodcast(episodeForPlayer(podcastId, podcast, episode));
                                setPlaybackType("podcast");
                                setCurrentTrack(null);
                                setCurrentAudiobook(null);
                            }
                        })
                        .catch(dropIfGone);
                }

                // A late restore must not overwrite a queue built since page load.
                // A functional update reads the real current queue; the effect-synced
                // queueRef can still be empty. Shuffle is restored either way.
                if (serverState.queue) {
                    const arrived = withQueueKeys(serverState.queue as Track[]);
                    setQueue((prev) => (prev.length > 0 ? prev : arrived));
                    // If the listener's own queue won, its entries are not these keys and the source never applies to it.
                    if (serverState.queueSource) setQueueOrigin((prev) => prev ?? originOf(arrived, serverState.queueSource));
                }
                if (serverState.currentIndex !== undefined) {
                    // An index only means anything alongside the queue it came from. If the
                    // listener's own queue won above, their position stands.
                    setCurrentIndex((prev) =>
                        queueRef.current.length === 0 ? serverState.currentIndex! : prev,
                    );
                }
                if (serverState.isShuffle !== undefined)
                    setIsShuffle(serverState.isShuffle);
                return restoringMedia;
            })
            .catch(() => {
                // The server could not be asked; what it holds is unknown.
                restoreFailedRef.current = true;
            })
            .finally(() => setRestoreSettled(true));
    }, [setQueue]);

    // Save state to localStorage whenever it changes (debounced)
    useEffect(() => {
        const timeoutId = setTimeout(() => {
            try {
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
                // The queue is not written here: it lives on the server
                // (`PlaybackState.queue`), and a large queue in this try/catch would
                // exceed the storage quota and take the other keys down with it.
                localStorage.setItem(
                    STORAGE_KEYS.CURRENT_INDEX,
                    currentIndex.toString()
                );
                localStorage.setItem(STORAGE_KEYS.IS_SHUFFLE, isShuffle.toString());
                localStorage.setItem(STORAGE_KEYS.REPEAT_MODE, repeatMode);
                localStorage.setItem(STORAGE_KEYS.PLAYER_MODE, overlayOpen ? "overlay" : "closed");
                localStorage.setItem(STORAGE_KEYS.VOLUME, volume.toString());
                localStorage.setItem(STORAGE_KEYS.IS_MUTED, isMuted.toString());
            } catch (error) {
                console.error("[AudioState] Failed to save state:", error);
            }
        }, 500);

        return () => clearTimeout(timeoutId);
    }, [
        currentAudiobook,
        currentPodcast,
        playbackType,
        queue,
        currentIndex,
        isShuffle,
        repeatMode,
        overlayOpen,
        volume,
        isMuted,
    ]);

    useEffect(() => {
        if (!restoreSettled) return;
        const failedRestore = restoreFailedRef.current;
        restoreFailedRef.current = false;
        if (!playbackType) return;
        const listenerChose = (currentTrack?.id ?? currentAudiobook?.id ?? currentPodcast?.id ?? null) !== storedMediaRef.current;

        // Sliced to the server's queue limit, fetched once and remembered.
        const limitedQueue = queue.slice(0, queueLimitRef.current);
        const adjustedIndex = Math.min(currentIndex, (limitedQueue.length || 1) - 1);
        // Where the queue came from is saved only while every entry in it did.
        const queueSource =
            queueOrigin && limitedQueue.length > 0 && limitedQueue.every((entry) => entry.queueKey && queueOrigin.keys.has(entry.queueKey))
                ? queueOrigin.source
                : null;
        const state = {
            playbackType,
            // Null, never omitted: the server leaves a field it was not sent alone, so a song cleared here would stay.
            trackId: currentTrack?.id ?? null,
            audiobookId: currentAudiobook?.id ?? null,
            podcastId: currentPodcast?.id ?? null,
            queue: withoutQueueKeys(limitedQueue),
            queueSource,
            currentIndex: adjustedIndex,
            isShuffle,
        };
        const key = playbackKey(state, queueLimitRef.current);
        // Written back, it would replace what another device saved; the listener's next change saves as usual.
        if (failedRestore && !listenerChose) serverKnownRef.current = key;

        const saveToServer = async () => {
            if (key === serverKnownRef.current) return;
            try {
                const result = await api.savePlaybackState(state);
                serverKnownRef.current = key;
                setLastServerSync(new Date(result.updatedAt));
            } catch (err: unknown) {
                if (err instanceof Error && err.message !== "Not authenticated") {
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
        restoreSettled,
        playbackType,
        currentTrack?.id,
        currentAudiobook?.id,
        currentPodcast?.id,
        queue,
        queueOrigin,
        currentIndex,
        isShuffle,
    ]);

    // Poll server for changes from other devices (pauses when tab is hidden)
    useEffect(() => {
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

                if (lastServerSyncRef.current && serverUpdatedAt <= lastServerSyncRef.current) {
                    return;
                }

                // Adopt the server's queue only when it is newer than the local one.
                // Saves are debounced, so right after play the server still holds
                // the previous queue, which differs but is older.
                const serverIsNewer =
                    serverUpdatedAt.getTime() > localChangedAtRef.current.getTime();

                const serverMediaId =
                    serverState.trackId ||
                    serverState.audiobookId ||
                    serverState.podcastId;
                const currentMediaId =
                    currentTrack?.id ||
                    currentAudiobook?.id ||
                    currentPodcast?.id;

                // Cleared on another device: the newest word wins here as it does for a song change. Playing on would
                // write the cleared song straight back.
                if (!serverMediaId && !serverState.queue?.length && currentMediaId && serverIsNewer) {
                    setCurrentTrack(null);
                    setCurrentAudiobook(null);
                    setCurrentPodcast(null);
                    setPlaybackType(null);
                    setQueue([]);
                    setCurrentIndex(0);
                    controller?.pause();
                    serverKnownRef.current = playbackKey(serverState, queueLimitRef.current);
                    setLastServerSync(serverUpdatedAt);
                    return;
                }

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
                                adoptQueue(serverState.queue, serverState.queueSource);
                                setCurrentIndex(serverState.currentIndex || 0);
                                setIsShuffle(serverState.isShuffle || false);
                            }
                        } catch (err) {
                            // The server remembers a track that is gone; what plays here stays.
                            if (mounted && isGone(err)) {
                                serverKnownRef.current = null;
                                await api.clearPlaybackState().catch(() => {});
                            }
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
                        const podcast: ShowWithEpisodes = await api.getPodcast(podcastId);
                        if (!mounted) return;
                        const episode = podcast.episodes?.find((ep) => ep.id === episodeId);
                        if (episode) {
                            setCurrentPodcast(episodeForPlayer(podcastId, podcast, episode));
                            setPlaybackType("podcast");
                            setCurrentTrack(null);
                            setCurrentAudiobook(null);
                        }
                    }

                    if (!mounted) return;
                    if (
                        serverIsNewer &&
                        JSON.stringify(serverState.queue) !==
                        JSON.stringify(withoutQueueKeys(queueRef.current))
                    ) {
                        adoptQueue(serverState.queue || [], serverState.queueSource);
                        setCurrentIndex(serverState.currentIndex || 0);
                        setIsShuffle(serverState.isShuffle || false);
                    }

                    serverKnownRef.current = playbackKey(serverState, queueLimitRef.current);
                    setLastServerSync(serverUpdatedAt);
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.message === "Not authenticated") {
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
        controller,
        playbackType,
        currentTrack?.id,
        currentAudiobook?.id,
        currentPodcast?.id,
        setQueue,
        adoptQueue,
    ]);

    // The playing entry is the queue's entry at the playing place, while it holds the song that is playing.
    const currentQueueKey = useMemo(() => {
        const entry = queue[currentIndex];
        return playbackType === "track" && entry && entry.id === currentTrack?.id ? (entry.queueKey ?? null) : null;
    }, [queue, currentIndex, currentTrack?.id, playbackType]);

    // The playing entry came from the source if it is one of the queue's own entries; a queue another play, a station or
    // an edit put in its place has other keys.
    const currentQueueSource = useMemo(
        () => (queueOrigin && currentQueueKey && queueOrigin.keys.has(currentQueueKey) ? queueOrigin.source : null),
        [queueOrigin, currentQueueKey],
    );

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
            shuffleIndices,
            currentQueueKey,
            currentQueueSource,
            overlayOpen,
            volume,
            isMuted,
            activeOperation,
            repeatOneCount,
            setCurrentTrack,
            setCurrentAudiobook,
            setCurrentPodcast,
            setPlaybackType,
            setQueue,
            setQueueOrigin,
            extendQueueOrigin,
            setCurrentIndex,
            setIsShuffle,
            setRepeatMode,
            setShuffleIndices,
            setOverlayOpen,
            setVolume,
            setIsMuted,
            setRepeatOneCount,
            setActiveOperation,
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
            currentQueueKey,
            currentQueueSource,
            overlayOpen,
            volume,
            isMuted,
            activeOperation,
            repeatOneCount,
            setQueue,
            setQueueOrigin,
            extendQueueOrigin,
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
