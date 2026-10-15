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
import type { EngineSnapshot } from "./audio-engine-policy";
import { usePlayReporting } from "@/hooks/usePlayReporting";
import { upNext, useLiveReporting } from "@/hooks/useLiveReporting";

interface AudioPlaybackContextType {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    isBuffering: boolean;
    audioError: string | null;
    setCurrentTime: (time: number) => void;
    setCurrentTimeFromEngine: (time: number) => void;
    setDuration: (duration: number) => void;
}

const AudioPlaybackContext = createContext<AudioPlaybackContextType | undefined>(undefined);

export function AudioPlaybackProvider({ children }: { children: ReactNode }) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isBuffering, setIsBuffering] = useState(false);
    const [audioError, setAudioError] = useState<string | null>(null);
    const [isHydrated] = useState(() => typeof window !== "undefined");

    const lastSeekTimeRef = useRef(0);

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

    // The only source of plays: the stream endpoint does not log them, so if
    // this stops firing, play history silently stops growing.
    usePlayReporting(
        controller as Parameters<typeof usePlayReporting>[0],
        state.currentTrack?.id ?? null,
        state.currentTrack?.duration ?? duration ?? null,
    );

    const liveTrack = state.playbackType === "track" ? state.currentTrack : null;
    const liveQueue = useMemo(
        () => liveTrack
            ? upNext(state.queue, state.currentIndex, state.isShuffle, state.shuffleIndices, state.repeatMode)
            : [],
        [liveTrack, state.queue, state.currentIndex, state.isShuffle, state.shuffleIndices, state.repeatMode],
    );
    useLiveReporting(
        controller as Parameters<typeof useLiveReporting>[0],
        liveTrack ? { id: liveTrack.id, duration: liveTrack.duration } : null,
        liveQueue,
    );

    // Snapshot subscriber: derive isPlaying/isBuffering/audioError from engine state machine.
    useEffect(() => {
        if (!controller) return;

        const unsubscribe = controller.subscribe((snap: EngineSnapshot) => {
            const { status } = snap;

            setIsPlaying(status === "playing");
            setIsBuffering(
                status === "loading" || status === "buffering" || status === "recovering"
            );

            if (status === "error") {
                setAudioError(snap.error?.message ?? "Audio playback error");
            } else if (status === "blocked") {
                setAudioError("Tap play to resume");
            } else {
                setAudioError(null);
            }
        });

        return () => {
            if (typeof unsubscribe === "function") unsubscribe();
        };
    }, [controller]);

    // timeupdate and canplay remain event-driven: they carry data (time, duration)
    // that the snapshot does not replace for the offset-adjusted currentTime path.
    useEffect(() => {
        if (!controller) return;

        const onTimeUpdate = (data: unknown) => {
            const { time } = data as { time: number };
            setCurrentTimeFromEngine(time + trackOffsetRef.current);
        };

        const onCanPlay = (data: unknown) => {
            const { duration: dur } = data as { duration: number };
            setDuration(dur || 0);
        };

        controller.on("timeupdate", onTimeUpdate);
        controller.on("canplay", onCanPlay);

        return () => {
            controller.off("timeupdate", onTimeUpdate);
            controller.off("canplay", onCanPlay);
        };
    }, [controller, setCurrentTimeFromEngine]);

    // BroadcastChannel single-tab claim. Pause is "system" (another tab took over).
    // onPlay postMessage fires when status transitions INTO "playing".
    useEffect(() => {
        if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
        if (!controller) return;

        const tabId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const channel = new BroadcastChannel("kima-audio-playback");
        let prevStatusForBc: EngineSnapshot["status"] | null = null;

        channel.onmessage = (event: MessageEvent) => {
            const msg = event.data;
            if (msg?.type === "playback-claimed" && msg.tabId !== tabId) {
                 
                controller.pause("system");
            }
        };

         
        const unsubscribe = controller.subscribe((snap: EngineSnapshot) => {
            const { status } = snap;
            if (status === "playing" && prevStatusForBc !== "playing") {
                try {
                    channel.postMessage({ type: "playback-claimed", tabId });
                } catch {}
            }
            prevStatusForBc = status;
        });

        return () => {
            if (typeof unsubscribe === "function") unsubscribe();
            channel.close();
        };
    }, [controller]);

    const value = useMemo(
        () => ({
            isPlaying,
            currentTime,
            duration,
            isBuffering,
            audioError,
            setCurrentTime: setCurrentTimeWithSeekMark,
            setCurrentTimeFromEngine,
            setDuration,
        }),
        [
            isPlaying,
            currentTime,
            duration,
            isBuffering,
            audioError,
            setCurrentTimeWithSeekMark,
            setCurrentTimeFromEngine,
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
