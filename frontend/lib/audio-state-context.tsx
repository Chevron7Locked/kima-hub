"use client";

import {
    createContext,
    useContext,
    useState,
    useEffect,
    useLayoutEffect,
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
// Polls are 30 s apart, so a save that keeps failing is tried again at most every 8th check (about four minutes).
const MAX_CHECKS_TO_SKIP = 7;

/**
 * One save of the playback state: the run of the save effect that made it, its playbackKey, and what is sent.
 * `force` sends it even where the server is believed to hold it already (it was found to hold something else).
 */
type PlaybackSave = { run: number; key: string; state: Parameters<typeof api.savePlaybackState>[0]; force?: true };

/** The id of what plays, whichever kind it is. */
function mediaIdOf(
    track: { id: string } | null,
    audiobook: { id: string } | null,
    podcast: { id: string } | null,
): string | null {
    return track?.id ?? audiobook?.id ?? podcast?.id ?? null;
}

function isGone(err: unknown): boolean {
    return (err as { status?: number } | null)?.status === 404;
}

/** The server refused a save that named the time it saw, because its state has been saved since. */
function isConflict(err: unknown): boolean {
    return (err as { status?: number } | null)?.status === 409;
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

/** Where a queue is saved as coming from: the page it started from, while every entry in it (cut to the limit) did. */
function savedSource(limitedQueue: Track[], origin: QueueOrigin | null): string | null {
    return origin && limitedQueue.length > 0 && limitedQueue.every((entry) => entry.queueKey && origin.keys.has(entry.queueKey))
        ? origin.source
        : null;
}

/**
 * Whether the queue and its source that the server holds are what this device would save: both cut to the server's
 * limit first, since the server only ever holds the cut queue, and the source compared with it.
 */
function holdsSameQueue(
    server: { queue?: Track[] | null; queueSource?: string | null },
    local: Track[],
    origin: QueueOrigin | null,
    queueLimit: number,
): boolean {
    const limited = local.slice(0, queueLimit);
    return (
        JSON.stringify([withoutQueueKeys((server.queue ?? []).slice(0, queueLimit)), server.queueSource ?? null]) ===
        JSON.stringify([withoutQueueKeys(limited), savedSource(limited, origin)])
    );
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
    const queueOriginRef = useRef(queueOrigin);
    useEffect(() => { queueOriginRef.current = queueOrigin; }, [queueOrigin]);
    // True from a change made on THIS device until its save has settled. The cross-device poller needs it to tell
    // "another device changed the state" from "my own change has not been uploaded yet" without comparing a server time
    // with this device's clock, which can be off by any amount.
    const savePendingRef = useRef(false);
    // Numbers each run of the save effect, so a save that settles late does not clear the flag of a newer change.
    const saveRunRef = useRef(0);
    // Saves go out one at a time, so an older one can never land after a newer one and leave the server (or
    // `serverKnownRef`) with the older state. `latest` is the newest run's save, kept until the next run replaces it;
    // `queued` is the newest one waiting for the one on its way (older waiting ones are replaced, not sent), and its
    // dedupe check runs when it is taken up, not when it was queued. A save that failed is sent again by the poll,
    // counted in checks, not time: after the nth failed try in a row the poll lets `checksToSkip` =
    // min(2^(n-1)-1, MAX_CHECKS_TO_SKIP) checks pass first, so a server that is down is not hit every check; a save
    // that goes through starts the count over. Only the newest run's outcome counts, an older one's does not.
    const saveRef = useRef<{
        latest: PlaybackSave | null;
        queued: PlaybackSave | null;
        draining: boolean;
        drained: Promise<void>;
        failures: number;
        checksToSkip: number;
        // The wait before `latest` goes out; cleared when something else sends it first, so it is not tried twice.
        timer: ReturnType<typeof setTimeout> | null;
        // Set when the server refused a save for naming a time that was no longer its own (409); read by the check that sent it.
        conflicted: boolean;
    }>({ latest: null, queued: null, draining: false, drained: Promise.resolve(), failures: 0, checksToSkip: 0, timer: null, conflicted: false });
    // What the poll needs to know of the page as it is now, since the poll runs on from one render to the next.
    const mediaId = mediaIdOf(currentTrack, currentAudiobook, currentPodcast);
    const liveRef = useRef({ playbackType, mediaId });
    useLayoutEffect(() => {
        liveRef.current = { playbackType, mediaId };
    }, [playbackType, mediaId]);
    // The time the server last answered with, kept in step at once (the effect that mirrors the state lags a render).
    const markSynced = useCallback((at: Date) => {
        lastServerSyncRef.current = at;
        setLastServerSync(at);
    }, []);
    const submitSave = useCallback((job: PlaybackSave): Promise<void> => {
        const s = saveRef.current;
        s.queued = job;
        if (!s.draining) {
            s.draining = true;
            s.drained = (async () => {
                try {
                    while (s.queued) {
                        const next = s.queued;
                        s.queued = null;
                        if (next.key === serverKnownRef.current && !next.force) {
                            if (saveRunRef.current === next.run) savePendingRef.current = false;
                            continue;
                        }
                        // What the server holds is not this: a newer run that undid an older one on its way finds
                        // it so here, and its change is owed again until this save lands.
                        if (saveRunRef.current === next.run) savePendingRef.current = true;
                        try {
                            const result = await api.savePlaybackState(next.state);
                            serverKnownRef.current = next.key;
                            markSynced(new Date(result.updatedAt));
                            if (saveRunRef.current === next.run) {
                                savePendingRef.current = false;
                                s.failures = 0;
                                s.checksToSkip = 0;
                            }
                        } catch (err: unknown) {
                            // Another device saved after the state this one was decided on: its word is the newer, so
                            // nothing here is owed, and the check that sent this takes the other state up.
                            if (isConflict(err)) {
                                if (saveRunRef.current === next.run) savePendingRef.current = false;
                                s.conflicted = true;
                                continue;
                            }
                            // The flag stays set: the change is still only here, and another device's state must not
                            // replace it. The poll sends it again, later each time it fails.
                            if (saveRunRef.current === next.run) {
                                s.failures += 1;
                                s.checksToSkip = Math.min(2 ** (s.failures - 1) - 1, MAX_CHECKS_TO_SKIP);
                            }
                            if (err instanceof Error && err.message !== "Not authenticated") {
                                console.error("[AudioState] Failed to save to server:", err);
                            }
                        }
                    }
                } finally {
                    s.draining = false;
                }
            })();
        }
        return s.drained;
    }, [markSynced]);
    useEffect(() => {
        queueRef.current = queue;
    }, [queue]);
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
                // What the server holds was not applied here, so the next check applies it instead of finding it already seen.
                setLastServerSync(null);
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
        const run = ++saveRunRef.current;
        savePendingRef.current = false;
        // This run replaces the older ones: a save of theirs still waiting its turn is not sent.
        saveRef.current.latest = null;
        saveRef.current.queued = null;
        if (saveRef.current.timer) clearTimeout(saveRef.current.timer);
        saveRef.current.timer = null;
        if (!restoreSettled) return;
        const failedRestore = restoreFailedRef.current;
        restoreFailedRef.current = false;
        if (!playbackType) return;
        const listenerChose = mediaId !== storedMediaRef.current;

        // Sliced to the server's queue limit, fetched once and remembered.
        const limitedQueue = queue.slice(0, queueLimitRef.current);
        const adjustedIndex = Math.min(currentIndex, (limitedQueue.length || 1) - 1);
        // Where the queue came from is saved only while every entry in it did.
        const queueSource = savedSource(limitedQueue, queueOrigin);
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
        savePendingRef.current = key !== serverKnownRef.current;

        const job: PlaybackSave = { run, key, state };
        saveRef.current.latest = job;

        const timeoutId = setTimeout(() => {
            saveRef.current.timer = null;
            void submitSave(job);
        }, 1000);
        saveRef.current.timer = timeoutId;
        return () => clearTimeout(timeoutId);
        // Keyed on the ids of what plays, not the objects.
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
        submitSave,
    ]);

    // A page that is closing, or going to the background (where the browser may end it without notice), sends a change
    // whose wait has not run out, at once. Saves are sent kept alive (see the api), so the browser finishes one that is
    // on its way as the page goes. One that failed is sent again too, the poll being unlikely to get another turn.
    useEffect(() => {
        const flush = () => {
            const s = saveRef.current;
            if (!s.latest) return;
            if (s.timer) {
                clearTimeout(s.timer);
                s.timer = null;
                void submitSave(s.latest);
            } else if (savePendingRef.current && s.failures > 0 && !s.draining) {
                void submitSave(s.latest);
            }
        };
        const flushIfHidden = () => {
            if (document.hidden) flush();
        };
        window.addEventListener("pagehide", flush);
        document.addEventListener("visibilitychange", flushIfHidden);
        return () => {
            window.removeEventListener("pagehide", flush);
            document.removeEventListener("visibilitychange", flushIfHidden);
        };
    }, [submitSave]);

    // Poll server for changes from other devices (pauses when tab is hidden)
    useEffect(() => {
        let isAuthenticated = true;
        let mounted = true;
        let isVisible = !document.hidden;
        // One check at a time: a check started by the tab being shown must not run over one the interval started.
        let checking = false;
        // A check for a tab just shown that found one already running: it is made when that one is done.
        let nowOwed = false;

        // `now` is a check made because the tab was just shown: the save owed is sent whatever it is waiting for.
        const check = async (now: boolean): Promise<void> => {
            // Skip polling when tab is hidden, unmounted, or not authenticated
            if (!isAuthenticated || !mounted || !isVisible) return;
            if (checking) {
                if (now) nowOwed = true;
                return;
            }
            checking = true;
            try {
                await poll(now);
            } finally {
                checking = false;
            }
            if (nowOwed) {
                nowOwed = false;
                await check(true);
            }
        };

        // Hidden tabs do not look (battery, resources); shown again, the tab looks at once, for whatever it missed.
        const handleVisibilityChange = () => {
            isVisible = !document.hidden;
            if (isVisible) void check(true);
        };
        document.addEventListener("visibilitychange", handleVisibilityChange);

        const poll = async (now: boolean) => {
            // A change made here is owed to the server still when its save failed (sent again here, later each time it
            // fails) or, for a tab just shown, when its save is still waiting out its delay. It goes before anything of
            // the server's is looked at, since another device's state may not replace a change that never reached it.
            const owed = saveRef.current;
            if (savePendingRef.current && owed.latest && !owed.draining && (owed.failures > 0 || now)) {
                if (now) owed.checksToSkip = 0;
                if (owed.checksToSkip > 0) owed.checksToSkip -= 1;
                else {
                    // Sent now, so the wait it still had is over: it is not sent a second time when it ends.
                    if (owed.timer) clearTimeout(owed.timer);
                    owed.timer = null;
                    await submitSave(owed.latest);
                }
                if (!mounted) return;
            }

            // What this page plays when the check starts. A check that finds it changed (a song started here while
            // the server was being asked) is dropped: what it learned is stale, and the next one starts afresh.
            const here = liveRef.current;
            const changedHere = () =>
                liveRef.current.playbackType !== here.playbackType || liveRef.current.mediaId !== here.mediaId;
            const playbackType = here.playbackType;
            const currentMediaId = here.mediaId ?? undefined;

            // The server remembers an item it no longer has. A change made here, or another device's newer word, is
            // never overwritten for it; what plays here replaces it (saved, never cleared first, since a device that
            // looked in between would see an empty player and stop); with nothing playing here it is cleared.
            const forgetGone = async (polledAt: Date) => {
                const settledElsewhere = () =>
                    !mounted ||
                    changedHere() ||
                    savePendingRef.current ||
                    (lastServerSyncRef.current !== null && lastServerSyncRef.current > polledAt);
                if (settledElsewhere()) return;
                const held = await api.getPlaybackState().catch(() => null);
                // Cleared, or saved again by another device (a newer time than the one that was polled).
                if (!held || new Date(held.updatedAt) > polledAt || settledElsewhere()) return;
                if (liveRef.current.mediaId) {
                    // Something plays here: it replaces the gone item. Its save is not made yet only while the page
                    // is still settling, and the save that follows will replace the item.
                    const mine = saveRef.current.latest;
                    if (!mine) return;
                    if (saveRef.current.timer) clearTimeout(saveRef.current.timer);
                    saveRef.current.timer = null;
                    if (saveRunRef.current === mine.run) savePendingRef.current = true;
                    // Written only while the server's state is still the one just read: a device that saved in the
                    // meantime is refused the overwrite, and its state is taken up by the check made next.
                    saveRef.current.conflicted = false;
                    await submitSave({ ...mine, force: true, state: { ...mine.state, expectedUpdatedAt: String(held.updatedAt) } });
                    if (saveRef.current.conflicted) {
                        saveRef.current.conflicted = false;
                        nowOwed = true;
                    }
                } else {
                    serverKnownRef.current = null;
                    await api.clearPlaybackState().catch(() => {});
                }
            };

            // What a fetch made after the poll began must not act on: the page moved on, or a change made here is
            // still unsaved (a song or book playing here is not replaced by the server's word then).
            const staleAfterFetch = () =>
                !mounted || changedHere() || (currentMediaId !== undefined && savePendingRef.current);

            try {
                const serverState = await api.getPlaybackState();
                if (!serverState || !mounted || changedHere()) return;

                const serverUpdatedAt = new Date(serverState.updatedAt);

                if (lastServerSyncRef.current && serverUpdatedAt <= lastServerSyncRef.current) {
                    return;
                }

                // Past the check above the server's state is newer than the last one this device saw (both are the
                // server's own times). It is newer than what this device holds unless a change made here is still
                // on its way: saves are debounced, so right after a play the server holds the previous state.
                const noSaveOwed = !savePendingRef.current;

                const serverMediaId =
                    serverState.trackId ||
                    serverState.audiobookId ||
                    serverState.podcastId;

                // Cleared on another device: the newest word wins here as it does for a song change. Playing on would
                // write the cleared song straight back.
                if (!serverMediaId && !serverState.queue?.length && currentMediaId && noSaveOwed) {
                    setCurrentTrack(null);
                    setCurrentAudiobook(null);
                    setCurrentPodcast(null);
                    setPlaybackType(null);
                    setQueue([]);
                    setCurrentIndex(0);
                    controller?.pause();
                    serverKnownRef.current = playbackKey(serverState, queueLimitRef.current);
                    markSynced(serverUpdatedAt);
                    return;
                }

                // Whether the queue here is not the one the server holds (the same queue, source and cut to the limit).
                const queueDiffers = () =>
                    !holdsSameQueue(serverState, queueRef.current, queueOriginRef.current, queueLimitRef.current);
                let adopted = false;
                // Set only where the server's state was actually applied here: anything else is tried again on the
                // next check, not marked as seen.
                let applied = false;

                const mediaDiffers =
                    serverMediaId !== currentMediaId ||
                    serverState.playbackType !== playbackType;
                // A song or book playing here is replaced only by a newer word; with nothing playing (a restore that
                // failed) the server's state is taken whatever its age.
                if (mediaDiffers && (noSaveOwed || !currentMediaId)) {
                    if (
                        serverState.playbackType === "track" &&
                        serverState.trackId
                    ) {
                        try {
                            const track = await api.getTrack(
                                serverState.trackId
                            );
                            // A change made here while the song was fetched (the queue edited, say) is still unsaved.
                            if (staleAfterFetch()) return;
                            setCurrentTrack(track);
                            setPlaybackType("track");
                            setCurrentAudiobook(null);
                            setCurrentPodcast(null);
                            applied = true;
                            if (
                                serverState.queue &&
                                serverState.queue.length > 0
                            ) {
                                // The place and shuffle always follow the song; the queue is replaced only when it differs.
                                if (queueDiffers()) adoptQueue(serverState.queue, serverState.queueSource);
                                adopted = true;
                                setCurrentIndex(serverState.currentIndex || 0);
                                setIsShuffle(serverState.isShuffle || false);
                            }
                        } catch (err) {
                            if (mounted && isGone(err)) await forgetGone(serverUpdatedAt);
                            return;
                        }
                    } else if (
                        serverState.playbackType === "audiobook" &&
                        serverState.audiobookId
                    ) {
                        let audiobook: Awaited<ReturnType<typeof api.getAudiobook>>;
                        try {
                            audiobook = await api.getAudiobook(serverState.audiobookId);
                        } catch (err) {
                            if (mounted && isGone(err)) await forgetGone(serverUpdatedAt);
                            return;
                        }
                        if (staleAfterFetch()) return;
                        if (audiobook) {
                            setCurrentAudiobook(audiobook);
                            setPlaybackType("audiobook");
                            setCurrentTrack(null);
                            setCurrentPodcast(null);
                            applied = true;
                        }
                    } else if (
                        serverState.playbackType === "podcast" &&
                        serverState.podcastId
                    ) {
                        const [podcastId, episodeId] =
                            serverState.podcastId.split(":");
                        let podcast: ShowWithEpisodes;
                        try {
                            podcast = await api.getPodcast(podcastId);
                        } catch (err) {
                            if (mounted && isGone(err)) await forgetGone(serverUpdatedAt);
                            return;
                        }
                        if (staleAfterFetch()) return;
                        const episode = podcast.episodes?.find((ep) => ep.id === episodeId);
                        if (episode) {
                            setCurrentPodcast(episodeForPlayer(podcastId, podcast, episode));
                            setPlaybackType("podcast");
                            setCurrentTrack(null);
                            setCurrentAudiobook(null);
                            applied = true;
                        }
                    } else if (!serverMediaId) {
                        // A state that names no item has nothing to play here: seen, so it is not looked at again. Its
                        // queue, if it has one, is taken below where this page holds a song's queue (or none).
                        applied = true;
                    }
                }

                if (!mounted) return;
                // Another device changed the queue, or the page it came from, while the same song plays here too.
                // Audiobooks and podcasts keep no queue, so only a song's queue is compared; a page with nothing playing
                // holds none of its own, so it takes a queue that names no song.
                if (!adopted && noSaveOwed && serverState.playbackType === "track" && (playbackType === "track" || playbackType === null) && queueDiffers()) {
                    adoptQueue(serverState.queue || [], serverState.queueSource);
                    setCurrentIndex(serverState.currentIndex || 0);
                    setIsShuffle(serverState.isShuffle || false);
                    adopted = true;
                }

                if (applied || adopted) {
                    serverKnownRef.current = playbackKey(serverState, queueLimitRef.current);
                    markSynced(serverUpdatedAt);
                }
            } catch (err: unknown) {
                if (err instanceof Error && err.message === "Not authenticated") {
                    isAuthenticated = false;
                    clearInterval(pollInterval);
                }
            }
        };

        // Not restarted when the song changes: it runs on, reading the page as it is (liveRef) each time.
        const pollInterval = setInterval(() => check(false), 30000);

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
        setQueue,
        adoptQueue,
        submitSave,
        markSynced,
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
