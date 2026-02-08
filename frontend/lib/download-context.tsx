"use client";

import {
    createContext,
    useContext,
    useState,
    ReactNode,
    useEffect,
    useMemo,
    useCallback,
} from "react";
import { useDownloadStatus, DownloadJob } from "@/hooks/useDownloadStatus";
import { useAuth } from "@/lib/auth-context";
import { useEventSource } from "@/hooks/useEventSource";

interface PendingDownload {
    id: string;
    type: "artist" | "album";
    subject: string;
    mbid: string; // Unique identifier for deduplication
    timestamp: number;
}

interface DownloadContextType {
    pendingDownloads: PendingDownload[];
    downloadStatus: {
        activeDownloads: DownloadJob[];
        recentDownloads: DownloadJob[];
        hasActiveDownloads: boolean;
        failedDownloads: DownloadJob[];
    };
    addPendingDownload: (
        type: "artist" | "album",
        subject: string,
        mbid: string
    ) => string | null;
    removePendingDownload: (id: string) => void;
    removePendingByMbid: (mbid: string) => void;
    isPending: (subject: string) => boolean;
    isPendingByMbid: (mbid: string) => boolean;
    isAnyPending: () => boolean;
}

const DownloadContext = createContext<DownloadContextType | undefined>(
    undefined
);

export function DownloadProvider({ children }: { children: ReactNode }) {
    const [pendingDownloads, setPendingDownloads] = useState<PendingDownload[]>(
        []
    );
    const { isAuthenticated } = useAuth();
    useEventSource();
    const downloadStatus = useDownloadStatus(15000, isAuthenticated);

    // Sync pending downloads with actual download status (render-time adjustment)
    const [prevActiveDownloads, setPrevActiveDownloads] = useState(downloadStatus.activeDownloads);
    const [prevRecentDownloads, setPrevRecentDownloads] = useState(downloadStatus.recentDownloads);
    const [prevFailedDownloads, setPrevFailedDownloads] = useState(downloadStatus.failedDownloads);

    if (
        prevActiveDownloads !== downloadStatus.activeDownloads ||
        prevRecentDownloads !== downloadStatus.recentDownloads ||
        prevFailedDownloads !== downloadStatus.failedDownloads
    ) {
        setPrevActiveDownloads(downloadStatus.activeDownloads);
        setPrevRecentDownloads(downloadStatus.recentDownloads);
        setPrevFailedDownloads(downloadStatus.failedDownloads);

        setPendingDownloads((prev) => {
            const next = prev.filter((pending) => {
                const hasActiveJob = downloadStatus.activeDownloads.some(
                    (job) => job.targetMbid === pending.mbid
                );
                if (hasActiveJob) return false;

                const matchingJob = [
                    ...downloadStatus.recentDownloads,
                    ...downloadStatus.failedDownloads,
                ].find((job) => job.targetMbid === pending.mbid);
                if (matchingJob) return false;

                return true;
            });
            return next.length === prev.length ? prev : next;
        });
    }

    // Cleanup pending downloads older than 2 minutes
    // This handles cases where jobs fail immediately and don't appear in any API response
    useEffect(() => {
        const STALE_THRESHOLD = 2 * 60 * 1000; // 2 minutes

        const cleanup = setInterval(() => {
            setPendingDownloads((prev) => {
                const now = Date.now();
                const filtered = prev.filter((pending) => {
                    const age = now - pending.timestamp;
                    if (age > STALE_THRESHOLD) {
                        return false;
                    }
                    return true;
                });
                return filtered;
            });
        }, 30000); // Check every 30 seconds

        return () => clearInterval(cleanup);
    }, []);

    const addPendingDownload = useCallback((
        type: "artist" | "album",
        subject: string,
        mbid: string
    ): string | null => {
        // Check synchronously first to avoid race conditions
        let result: string | null = null;

        setPendingDownloads((prev) => {
            // Check if already downloading this MBID
            if (prev.some((d) => d.mbid === mbid)) {
                return prev;
            }

            const id = `${Date.now()}-${Math.random()}`;
            const download: PendingDownload = {
                id,
                type,
                subject,
                mbid,
                timestamp: Date.now(),
            };

            result = id;
            return [...prev, download];
        });

        return result;
    }, []);

    const removePendingDownload = useCallback((id: string) => {
        setPendingDownloads((prev) => prev.filter((d) => d.id !== id));
    }, []);

    const removePendingByMbid = useCallback((mbid: string) => {
        setPendingDownloads((prev) => prev.filter((d) => d.mbid !== mbid));
    }, []);

    const isPending = useCallback((subject: string): boolean => {
        return pendingDownloads.some((d) => d.subject === subject);
    }, [pendingDownloads]);

    const isPendingByMbid = useCallback((mbid: string): boolean => {
        // Check both pending downloads AND active download jobs
        const isPendingLocal = pendingDownloads.some((d) => d.mbid === mbid);
        const hasActiveJob = downloadStatus.activeDownloads.some(
            (job) => job.targetMbid === mbid
        );

        return isPendingLocal || hasActiveJob;
    }, [pendingDownloads, downloadStatus.activeDownloads]);

    const isAnyPending = useCallback((): boolean => {
        return pendingDownloads.length > 0;
    }, [pendingDownloads]);

    // Memoize context value to prevent unnecessary re-renders
    const contextValue = useMemo(() => ({
        pendingDownloads,
        downloadStatus,
        addPendingDownload,
        removePendingDownload,
        removePendingByMbid,
        isPending,
        isPendingByMbid,
        isAnyPending,
    }), [
        pendingDownloads,
        downloadStatus,
        addPendingDownload,
        removePendingDownload,
        removePendingByMbid,
        isPending,
        isPendingByMbid,
        isAnyPending,
    ]);

    return (
        <DownloadContext.Provider value={contextValue}>
            {children}
        </DownloadContext.Provider>
    );
}

export function useDownloadContext() {
    const context = useContext(DownloadContext);
    if (!context) {
        throw new Error(
            "useDownloadContext must be used within DownloadProvider"
        );
    }
    return context;
}
