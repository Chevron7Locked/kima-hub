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

interface AudioPlaybackContextType {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    isBuffering: boolean;
    targetSeekPosition: number | null;
    canSeek: boolean;
    downloadProgress: number | null; // 0-100 for downloading, null for not downloading
    isSeekLocked: boolean; // True when a seek operation is in progress
    setIsPlaying: (playing: boolean) => void;
    setCurrentTime: (time: number) => void;
    setCurrentTimeFromEngine: (time: number) => void; // For timeupdate events - respects seek lock
    setDuration: (duration: number) => void;
    setIsBuffering: (buffering: boolean) => void;
    setTargetSeekPosition: (position: number | null) => void;
    setCanSeek: (canSeek: boolean) => void;
    setDownloadProgress: (progress: number | null) => void;
    lockSeek: (targetTime: number) => void; // Lock updates during seek
    unlockSeek: () => void; // Unlock after seek completes
}

const AudioPlaybackContext = createContext<
    AudioPlaybackContextType | undefined
>(undefined);

// LocalStorage keys
const STORAGE_KEYS = {
    IS_PLAYING: "lidify_is_playing",
    CURRENT_TIME: "lidify_current_time",
};

export function AudioPlaybackProvider({ children }: { children: ReactNode }) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isBuffering, setIsBuffering] = useState(false);
    const [targetSeekPosition, setTargetSeekPosition] = useState<number | null>(
        null
    );
    const [canSeek, setCanSeek] = useState(true); // Default true for music, false for uncached podcasts
    const [downloadProgress, setDownloadProgress] = useState<number | null>(
        null
    );
    const [isHydrated, setIsHydrated] = useState(false);
    const lastSaveTimeRef = useRef<number>(0);

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

    // Unlock the seek state
    const unlockSeek = useCallback(() => {
        setIsSeekLocked(false);
        seekTargetRef.current = null;
        if (seekLockTimeoutRef.current) {
            clearTimeout(seekLockTimeoutRef.current);
            seekLockTimeoutRef.current = null;
        }
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

    // Restore currentTime from localStorage on mount
    // NOTE: Do NOT touch isPlaying here - let user actions control it
    useEffect(() => {
        if (typeof window === "undefined") return;

        try {
            const savedTime = localStorage.getItem(STORAGE_KEYS.CURRENT_TIME);
            if (savedTime) setCurrentTime(parseFloat(savedTime));
            // Don't force pause - this was causing immediate pause after play!
        } catch (error) {
            console.error("[AudioPlayback] Failed to restore state:", error);
        }
        setIsHydrated(true);
    }, []);

    // Get state from AudioStateContext for position sync
    const state = useAudioState();

    // Sync currentTime from audiobook/podcast progress when not playing
    // This ensures the UI shows the correct saved position on page load
    useEffect(() => {
        if (!isHydrated) return;
        if (isPlaying) return; // Don't override during active playback

        const { currentAudiobook, currentPodcast, playbackType } = state;

        if (playbackType === "audiobook" && currentAudiobook?.progress?.currentTime) {
            setCurrentTime(currentAudiobook.progress.currentTime);
        } else if (playbackType === "podcast" && currentPodcast?.progress?.currentTime) {
            setCurrentTime(currentPodcast.progress.currentTime);
        }
    }, [
        isHydrated,
        isPlaying,
        state.currentAudiobook?.progress?.currentTime,
        state.currentPodcast?.progress?.currentTime,
        state.playbackType,
    ]);

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
            targetSeekPosition,
            canSeek,
            downloadProgress,
            isSeekLocked,
            setIsPlaying,
            setCurrentTime,
            setCurrentTimeFromEngine,
            setDuration,
            setIsBuffering,
            setTargetSeekPosition,
            setCanSeek,
            setDownloadProgress,
            lockSeek,
            unlockSeek,
        }),
        [
            isPlaying,
            currentTime,
            duration,
            isBuffering,
            targetSeekPosition,
            canSeek,
            downloadProgress,
            isSeekLocked,
            setCurrentTimeFromEngine,
            lockSeek,
            unlockSeek,
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
