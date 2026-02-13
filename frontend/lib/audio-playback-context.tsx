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
    lockSeek: (targetTime: number) => void; // Lock updates during seek
    clearAudioError: () => void; // Clear the audio error state
}

const AudioPlaybackContext = createContext<
    AudioPlaybackContextType | undefined
>(undefined);

// LocalStorage keys
const STORAGE_KEYS = {
    CURRENT_TIME: "lidify_current_time",
};

export function AudioPlaybackProvider({ children }: { children: ReactNode }) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(() => {
        if (typeof window === "undefined") return 0;
        try {
            const saved = localStorage.getItem(STORAGE_KEYS.CURRENT_TIME);
            return saved ? parseFloat(saved) : 0;
        } catch { return 0; }
    });
    const [duration, setDuration] = useState(0);
    const [isBuffering, setIsBuffering] = useState(false);
    const [_targetSeekPosition, setTargetSeekPosition] = useState<number | null>(
        null
    );
    const [canSeek, setCanSeek] = useState(true); // Default true for music, false for uncached podcasts
    const [downloadProgress, setDownloadProgress] = useState<number | null>(
        null
    );
    const [audioError, setAudioError] = useState<string | null>(null);
    const [playbackState, setPlaybackState] = useState<PlaybackState>("IDLE");
    const [isHydrated] = useState(() => typeof window !== "undefined");
    const lastSaveTimeRef = useRef<number>(0);

    // Clear audio error
    const clearAudioError = useCallback(() => {
        setAudioError(null);
        // Also reset state machine if in error state
        if (playbackStateMachine.hasError) {
            playbackStateMachine.forceTransition("IDLE");
        }
    }, []);

    // Subscribe to state machine changes
    useEffect(() => {
        const unsubscribe = playbackStateMachine.subscribe((ctx) => {
            setPlaybackState(ctx.state);

            // Derive isPlaying and isBuffering from state machine
            // This creates a single source of truth
            const machineIsPlaying = ctx.state === "PLAYING";
            const machineIsBuffering = ctx.state === "BUFFERING" || ctx.state === "LOADING";

            // Only update if different to prevent unnecessary renders
            setIsPlaying((prev) => prev !== machineIsPlaying ? machineIsPlaying : prev);
            setIsBuffering((prev) => prev !== machineIsBuffering ? machineIsBuffering : prev);

            // Update error state
            if (ctx.state === "ERROR" && ctx.error) {
                setAudioError(ctx.error);
            } else if (ctx.state !== "ERROR" && audioError) {
                // Clear error when leaving error state
                setAudioError(null);
            }
        });

        return unsubscribe;
    }, [audioError]);

    // Seek lock state - prevents stale timeupdate events from overwriting optimistic UI updates
    const [isSeekLocked, setIsSeekLocked] = useState(false);
    const seekTargetRef = useRef<number | null>(null);
    const seekLockTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Lock the seek state - ignores timeupdate events until audio catches up or timeout
    const lockSeek = useCallback((targetTime: number) => {
        setIsSeekLocked(true);
        seekTargetRef.current = targetTime;

        // Clear any existing timeout
        if (seekLockTimeoutRef.current) {
            clearTimeout(seekLockTimeoutRef.current);
        }

        // Auto-unlock after 500ms as a safety measure
        seekLockTimeoutRef.current = setTimeout(() => {
            setIsSeekLocked(false);
            seekTargetRef.current = null;
            seekLockTimeoutRef.current = null;
        }, 500);
    }, []);

    // setCurrentTimeFromEngine - for timeupdate events from Howler
    // Respects seek lock to prevent stale updates causing flicker
    const setCurrentTimeFromEngine = useCallback(
        (time: number) => {
            if (isSeekLocked && seekTargetRef.current !== null) {
                // During seek, only accept updates that are close to our target
                // This prevents old positions from briefly showing during seek
                const isNearTarget = Math.abs(time - seekTargetRef.current) < 2;
                if (!isNearTarget) {
                    return; // Ignore stale position update
                }
                // Position is near target - seek completed, unlock
                setIsSeekLocked(false);
                seekTargetRef.current = null;
                if (seekLockTimeoutRef.current) {
                    clearTimeout(seekLockTimeoutRef.current);
                    seekLockTimeoutRef.current = null;
                }
            }
            setCurrentTime(time);
        },
        [isSeekLocked]
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

    // Save currentTime to localStorage (throttled to avoid excessive writes)
    useEffect(() => {
        if (!isHydrated || typeof window === "undefined") return;

        // Throttle saves to every 5 seconds using timestamp comparison
        const now = Date.now();
        if (now - lastSaveTimeRef.current < 5000) return;

        lastSaveTimeRef.current = now;
        try {
            localStorage.setItem(
                STORAGE_KEYS.CURRENT_TIME,
                currentTime.toString()
            );
        } catch (error) {
            console.error("[AudioPlayback] Failed to save currentTime:", error);
        }
    }, [currentTime, isHydrated]);

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
