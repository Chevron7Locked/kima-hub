"use client";

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import { useAudioControls } from "@/lib/audio-controls-context";

// Module-level shared state so timer persists across player mode switches
let sharedEndTime: number | null = null;
const listeners = new Set<() => void>();

function getEndTime() {
    return sharedEndTime;
}

function getServerEndTime() {
    return null;
}

function subscribe(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

function setSharedEndTime(t: number | null) {
    sharedEndTime = t;
    listeners.forEach((cb) => cb());
}

interface SleepTimerState {
    /** Seconds remaining (null = inactive) */
    remainingSeconds: number | null;
    isActive: boolean;
    setTimer: (minutes: number) => void;
    clearTimer: () => void;
    /** Formatted remaining time (e.g. "1h 23m", "14m", "0:45") */
    displayRemaining: string;
}

export function useSleepTimer(): SleepTimerState {
    const { pause } = useAudioControls();
    const endTime = useSyncExternalStore(subscribe, getEndTime, getServerEndTime);
    const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
    const pauseRef = useRef(pause);
    pauseRef.current = pause;

    const setTimer = useCallback((minutes: number) => {
        setSharedEndTime(Date.now() + minutes * 60 * 1000);
    }, []);

    const clearTimer = useCallback(() => {
        setSharedEndTime(null);
        setRemainingSeconds(null);
    }, []);

    useEffect(() => {
        if (endTime === null) {
            setRemainingSeconds(null);
            return;
        }

        const tick = () => {
            const leftMs = Math.max(0, endTime - Date.now());
            const secs = Math.ceil(leftMs / 1000);

            if (leftMs <= 0) {
                pauseRef.current();
                setSharedEndTime(null);
                setRemainingSeconds(null);
                return;
            }

            setRemainingSeconds(secs);
        };

        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [endTime]);

    let displayRemaining = "";
    if (remainingSeconds !== null) {
        if (remainingSeconds >= 3600) {
            const h = Math.floor(remainingSeconds / 3600);
            const m = Math.ceil((remainingSeconds % 3600) / 60);
            displayRemaining = `${h}h ${m}m`;
        } else if (remainingSeconds >= 60) {
            displayRemaining = `${Math.ceil(remainingSeconds / 60)}m`;
        } else {
            displayRemaining = `0:${String(remainingSeconds).padStart(2, "0")}`;
        }
    }

    return {
        remainingSeconds,
        isActive: endTime !== null,
        setTimer,
        clearTimer,
        displayRemaining,
    };
}
