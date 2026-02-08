"use client";

import { createContext, useContext, useCallback, useRef, useSyncExternalStore, ReactNode } from "react";

export interface DownloadProgressData {
    bytesReceived?: number;
    totalBytes?: number;
    queuePosition?: number;
    username?: string;
    filename?: string;
}

interface DownloadProgressContextType {
    getProgress: (jobId: string) => DownloadProgressData | undefined;
    updateProgress: (jobId: string, data: DownloadProgressData) => void;
    clearProgress: (jobId: string) => void;
    subscribe: (callback: () => void) => () => void;
}

const DownloadProgressContext = createContext<DownloadProgressContextType | undefined>(undefined);

export function DownloadProgressProvider({ children }: { children: ReactNode }) {
    const progressRef = useRef<Map<string, DownloadProgressData>>(new Map());
    const listenersRef = useRef<Set<() => void>>(new Set());

    const notify = useCallback(() => {
        for (const listener of listenersRef.current) {
            listener();
        }
    }, []);

    const subscribe = useCallback((callback: () => void) => {
        listenersRef.current.add(callback);
        return () => { listenersRef.current.delete(callback); };
    }, []);

    const getProgress = useCallback((jobId: string) => {
        return progressRef.current.get(jobId);
    }, []);

    const updateProgress = useCallback((jobId: string, data: DownloadProgressData) => {
        const existing = progressRef.current.get(jobId);
        progressRef.current.set(jobId, { ...existing, ...data });
        notify();
    }, [notify]);

    const clearProgress = useCallback((jobId: string) => {
        progressRef.current.delete(jobId);
        notify();
    }, [notify]);

    return (
        <DownloadProgressContext.Provider value={{ getProgress, updateProgress, clearProgress, subscribe }}>
            {children}
        </DownloadProgressContext.Provider>
    );
}

export function useDownloadProgress() {
    const context = useContext(DownloadProgressContext);
    if (!context) {
        throw new Error("useDownloadProgress must be used within DownloadProgressProvider");
    }
    return context;
}

export function useJobProgress(jobId: string): DownloadProgressData | undefined {
    const { getProgress, subscribe } = useDownloadProgress();
    return useSyncExternalStore(
        subscribe,
        () => getProgress(jobId),
        () => undefined
    );
}
