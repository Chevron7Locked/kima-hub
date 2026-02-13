"use client";

import {
    createContext,
    useContext,
    useState,
    useEffect,
    useRef,
    useCallback,
    ReactNode,
    useMemo,
} from "react";
import { useAudioState } from "./audio-state-context";
import { playbackStateMachine, type PlaybackState } from "./audio";

interface AudioPlaybackContextType {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    isBuffering: boolean;
    canSeek: boolean;
    downloadProgress: number | null; // 0-100 for downloading, null for not downloading
    isSeekLocked: boolean; // True when a seek operation is in progress
    audioError: string | null; // Error message from state machine
    playbackState: PlaybackState; // Raw state machine state for advanced use
    setIsPlaying: (playing: boolean) => void;
    setCurrentTime: (time: number) => void;
    setCurrentTimeFromEngine: (time: number) => void; // For timeupdate events - respects seek lock
    setDuration: (duration: number) => void;
    setIsBuffering: (buffering: boolean) => void;
    setTargetSeekPosition: (position: number | null) => void;
    setCanSeek: (canSeek: boolean) => void;
    setDownloadProgress: (progress: number | null) => void;
    lockSeek: (targetTime: number, timeoutMs?: number) => void; // Lock updates during seek
    clearAudioError: () => void; // Clear the audio error state
}

const AudioPlaybackContext = createContext<
    AudioPlaybackContextType | undefined
>(undefined);

// currentTime is no longer persisted to localStorage.
// Audiobook/podcast positions sync from server-side progress.
// Music tracks always start at 0.

export function AudioPlaybackProvider({ children }: { children: ReactNode }) {
    const [isPlaying, setIsPlaying] = useState(false);
    // Always start at 0. Audiobook/podcast positions are synced from server-side
    // progress via the progressKey mechanism below. Music tracks always start at 0.
    // Previously this restored from localStorage, which showed stale positions (e.g. 0:10)
    // for tracks that hadn't been played yet in the current session.
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isBuffering, setIsBuffering] = useState(false);
    const setTargetSeekPosition = useCallback((_position: number | null) => {
        // No-op: target seek position is managed by the seek lock mechanism
    }, []);
    const [canSeek, setCanSeek] = useState(true); // Default true for music, false for uncached podcasts
    const [downloadProgress, setDownloadProgress] = useState<number | null>(
        null
    );
    const [audioError, setAudioError] = useState<string | null>(null);
    const audioErrorRef = useRef<string | null>(null);
    const [playbackState, setPlaybackState] = useState<PlaybackState>("IDLE");
    const [isHydrated] = useState(() => typeof window !== "undefined");

    // Clear audio error
    const clearAudioError = useCallback(() => {
        setAudioError(null);
        // Also reset state machine if in error state
        if (playbackStateMachine.hasError) {
            playbackStateMachine.forceTransition("IDLE");
        }
    }, []);

    // Sync audioError to ref so the subscription callback reads the latest value
    useEffect(() => {
        audioErrorRef.current = audioError;
    }, [audioError]);

    // Subscribe to state machine changes
    useEffect(() => {
        const unsubscribe = playbackStateMachine.subscribe((ctx) => {
            setPlaybackState(ctx.state);

            const machineIsPlaying = ctx.state === "PLAYING";
            const machineIsBuffering = ctx.state === "BUFFERING" || ctx.state === "LOADING";

            setIsPlaying((prev) => prev !== machineIsPlaying ? machineIsPlaying : prev);
            setIsBuffering((prev) => prev !== machineIsBuffering ? machineIsBuffering : prev);

            if (ctx.state === "ERROR" && ctx.error) {
                setAudioError(ctx.error);
            } else if (ctx.state !== "ERROR" && audioErrorRef.current) {
                setAudioError(null);
            }
        });

        return unsubscribe;
    }, []); // Stable -- never re-subscribes

    // Seek lock state - prevents stale timeupdate events from overwriting optimistic UI updates
    const [isSeekLocked, setIsSeekLocked] = useState(false);
    const isSeekLockedRef = useRef(false);
    const seekTargetRef = useRef<number | null>(null);
    const seekLockTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Keep ref in sync for use in stable callbacks
    useEffect(() => {
        isSeekLockedRef.current = isSeekLocked;
    }, [isSeekLocked]);

    // Lock the seek state - ignores timeupdate events until audio catches up or timeout
    const lockSeek = useCallback((targetTime: number, timeoutMs: number = 500) => {
        setIsSeekLocked(true);
        isSeekLockedRef.current = true;
        seekTargetRef.current = targetTime;

        // Clear any existing timeout
        if (seekLockTimeoutRef.current) {
            clearTimeout(seekLockTimeoutRef.current);
        }

        // Auto-unlock after timeout as a safety measure
        seekLockTimeoutRef.current = setTimeout(() => {
            setIsSeekLocked(false);
            isSeekLockedRef.current = false;
            seekTargetRef.current = null;
            seekLockTimeoutRef.current = null;
        }, timeoutMs);
    }, []);

    // setCurrentTimeFromEngine - for timeupdate events from Howler
    // Respects seek lock to prevent stale updates causing flicker.
    // Uses refs instead of state to keep callback identity stable -- this
    // prevents the events effect in HowlerAudioElement from re-registering
    // all Howler listeners on every seek lock change.
    const setCurrentTimeFromEngine = useCallback(
        (time: number) => {
            if (isSeekLockedRef.current && seekTargetRef.current !== null) {
                const isNearTarget = Math.abs(time - seekTargetRef.current) < 2;
                if (!isNearTarget) {
                    return; // Ignore stale position update
                }
                // Position is near target - seek completed, unlock
                setIsSeekLocked(false);
                isSeekLockedRef.current = false;
                seekTargetRef.current = null;
                if (seekLockTimeoutRef.current) {
                    clearTimeout(seekLockTimeoutRef.current);
                    seekLockTimeoutRef.current = null;
                }
            }
            setCurrentTime(time);
        },
        [] // Stable -- reads refs, never re-creates
    );

    // currentTime and isHydrated are initialized via lazy useState from localStorage

    // Get state from AudioStateContext for position sync
    const state = useAudioState();

    // Sync currentTime from audiobook/podcast progress when not playing (render-time adjustment)
    const progressKey = isHydrated && !isPlaying
        ? `${state.playbackType}-${state.currentAudiobook?.progress?.currentTime}-${state.currentPodcast?.progress?.currentTime}`
        : null;
    const [prevProgressKey, setPrevProgressKey] = useState<string | null>(progressKey);

    if (progressKey !== prevProgressKey) {
        setPrevProgressKey(progressKey);
        if (progressKey !== null) {
            if (state.playbackType === "audiobook" && state.currentAudiobook?.progress?.currentTime) {
                setCurrentTime(state.currentAudiobook.progress.currentTime);
            } else if (state.playbackType === "podcast" && state.currentPodcast?.progress?.currentTime) {
                setCurrentTime(state.currentPodcast.progress.currentTime);
            }
        }
    }

    // Cleanup seek lock timeout on unmount
    useEffect(() => {
        return () => {
            if (seekLockTimeoutRef.current) {
                clearTimeout(seekLockTimeoutRef.current);
            }
        };
    }, []);

    // Memoize to prevent re-renders when values haven't changed
    const value = useMemo(
        () => ({
            isPlaying,
            currentTime,
            duration,
            isBuffering,
            canSeek,
            downloadProgress,
            isSeekLocked,
            audioError,
            playbackState,
            setIsPlaying,
            setCurrentTime,
            setCurrentTimeFromEngine,
            setDuration,
            setIsBuffering,
            setTargetSeekPosition,
            setCanSeek,
            setDownloadProgress,
            lockSeek,
            clearAudioError,
        }),
        [
            isPlaying,
            currentTime,
            duration,
            isBuffering,
            canSeek,
            downloadProgress,
            isSeekLocked,
            audioError,
            playbackState,
            setCurrentTimeFromEngine,
            setTargetSeekPosition,
            lockSeek,
            clearAudioError,
        ]
    );

    return (
        <AudioPlaybackContext.Provider value={value}>
            {children}
        </AudioPlaybackContext.Provider>
    );
}

export function useAudioPlayback() {
    const context = useContext(AudioPlaybackContext);
    if (!context) {
        throw new Error(
            "useAudioPlayback must be used within AudioPlaybackProvider"
        );
    }
    return context;
}
