"use client";

import {
    createContext,
    useContext,
    useState,
    useRef,
    useCallback,
    useEffect,
    ReactNode,
    useMemo,
} from "react";
import { useAudioState } from "./audio-state-context";
import { useAudioController } from "./audio-controller-context";

interface AudioPlaybackContextType {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    isBuffering: boolean;
    canSeek: boolean;
    downloadProgress: number | null;
    audioError: string | null;
    setIsPlaying: (playing: boolean) => void;
    setCurrentTime: (time: number) => void;
    setCurrentTimeFromEngine: (time: number) => void;
    setDuration: (duration: number) => void;
    setIsBuffering: (buffering: boolean) => void;
    setCanSeek: (canSeek: boolean) => void;
    setDownloadProgress: (progress: number | null) => void;
    setAudioError: (error: string | null) => void;
    clearAudioError: () => void;
}

const AudioPlaybackContext = createContext<AudioPlaybackContextType | undefined>(undefined);

export function AudioPlaybackProvider({ children }: { children: ReactNode }) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isBuffering, setIsBuffering] = useState(false);
    const [canSeek, setCanSeek] = useState(true);
    const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
    const [audioError, setAudioError] = useState<string | null>(null);
    const [isHydrated] = useState(() => typeof window !== "undefined");

    const lastSeekTimeRef = useRef(0);

    const clearAudioError = useCallback(() => {
        setAudioError(null);
    }, []);

    const setCurrentTimeFromEngine = useCallback((time: number) => {
        if (Date.now() - lastSeekTimeRef.current < 300) return;
        setCurrentTime(time);
    }, []);

    const setCurrentTimeWithSeekMark = useCallback((time: number) => {
        lastSeekTimeRef.current = Date.now();
        setCurrentTime(time);
    }, []);

    const state = useAudioState();

    // Ref for trackOffset so the timeupdate handler always uses the latest value
    const trackOffsetRef = useRef(0);
    useEffect(() => {
        trackOffsetRef.current = state.playbackType === "audiobook"
            ? (state.currentAudiobook?.trackOffset ?? 0) : 0;
    }, [state.playbackType, state.currentAudiobook?.trackOffset]);

    // Sync currentTime from audiobook/podcast progress when not playing
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

    const controller = useAudioController();

    useEffect(() => {
        if (!controller) return;

        const onPlay = () => {
            setIsPlaying(true);
            setIsBuffering(false);
            setAudioError(null);
        };

        const onPause = () => {
            setIsPlaying(false);
        };

        const onTimeUpdate = (data: unknown) => {
            const { time } = data as { time: number };
            setCurrentTimeFromEngine(time + trackOffsetRef.current);
        };

        const onCanPlay = (data: unknown) => {
            const { duration: dur } = data as { duration: number };
            setDuration(dur || 0);
            setIsBuffering(false);
            setAudioError(null);
        };

        const onWaiting = () => {
            setIsBuffering(true);
        };

        const onError = (data: unknown) => {
            const { error, code } = data as { error: string; code?: number };
            setIsPlaying(false);
            setIsBuffering(false);
            const errorMessage =
                code === 2
                    ? "Playback interrupted -- stream may have been taken by another session"
                    : typeof error === "string"
                      ? error
                      : "Audio playback error";
            setAudioError(errorMessage);
        };

        const onNeedsResume = () => {
            setAudioError("Tap play to resume");
        };

        controller.on("play", onPlay);
        controller.on("pause", onPause);
        controller.on("timeupdate", onTimeUpdate);
        controller.on("canplay", onCanPlay);
        controller.on("waiting", onWaiting);
        controller.on("error", onError);
        controller.on("needs-resume", onNeedsResume);

        return () => {
            controller.off("play", onPlay);
            controller.off("pause", onPause);
            controller.off("timeupdate", onTimeUpdate);
            controller.off("canplay", onCanPlay);
            controller.off("waiting", onWaiting);
            controller.off("error", onError);
            controller.off("needs-resume", onNeedsResume);
        };
    }, [controller, setCurrentTimeFromEngine]);

    useEffect(() => {
        if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
        if (!controller) return;

        const tabId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const channel = new BroadcastChannel("kima-audio-playback");

        channel.onmessage = (event: MessageEvent) => {
            const msg = event.data;
            if (msg?.type === "playback-claimed" && msg.tabId !== tabId) {
                controller.pause();
            }
        };

        const onPlay = () => {
            try {
                channel.postMessage({ type: "playback-claimed", tabId });
            } catch {}
        };

        controller.on("play", onPlay);

        return () => {
            controller.off("play", onPlay);
            channel.close();
        };
    }, [controller]);

    const value = useMemo(
        () => ({
            isPlaying,
            currentTime,
            duration,
            isBuffering,
            canSeek,
            downloadProgress,
            audioError,
            setIsPlaying,
            setCurrentTime: setCurrentTimeWithSeekMark,
            setCurrentTimeFromEngine,
            setDuration,
            setIsBuffering,
            setCanSeek,
            setDownloadProgress,
            setAudioError,
            clearAudioError,
        }),
        [
            isPlaying,
            currentTime,
            duration,
            isBuffering,
            canSeek,
            downloadProgress,
            audioError,
            setCurrentTimeWithSeekMark,
            setCurrentTimeFromEngine,
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
        throw new Error("useAudioPlayback must be used within AudioPlaybackProvider");
    }
    return context;
}
