"use client";

import {
    createContext,
    useContext,
    useState,
    ReactNode,
    useEffect,
} from "react";
import { useDownloadStatus } from "@/hooks/useDownloadStatus";
import { useAuth } from "@/lib/auth-context";

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
        activeDownloads: any[];
        recentDownloads: any[];
        hasActiveDownloads: boolean;
        failedDownloads: any[];
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
    const downloadStatus = useDownloadStatus(15000, isAuthenticated);

    // Sync pending downloads with actual download status
    useEffect(() => {
        // Remove pending downloads that have completed or failed
        setPendingDownloads((prev) => {
            return prev.filter((pending) => {
                // Check if this MBID has an active job being tracked by API
                const hasActiveJob = downloadStatus.activeDownloads.some(
                    (job) => job.targetMbid === pending.mbid
                );

                // If job is now being tracked by the API, remove from local pending
                if (hasActiveJob) {
                    return false;
                }

                // Check if this MBID has completed or failed
                const matchingJob = [
                    ...downloadStatus.recentDownloads,
                    ...downloadStatus.failedDownloads,
                ].find((job) => job.targetMbid === pending.mbid);

                // If job is completed or failed, remove from pending
                if (matchingJob) {
                    return false;
                }

                // Keep if no job found yet
                return true;
            });
        });
    }, [
        downloadStatus.activeDownloads,
        downloadStatus.recentDownloads,
        downloadStatus.failedDownloads,
    ]);

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

    const addPendingDownload = (
        type: "artist" | "album",
        subject: string,
        mbid: string
    ): string | null => {
        // Check if already downloading this MBID
        if (pendingDownloads.some((d) => d.mbid === mbid)) {
            return null;
        }

        const id = `${Date.now()}-${Math.random()}`;
        const download: PendingDownload = {
            id,
            type,
            subject,
            mbid,
            timestamp: Date.now(),
        };

        setPendingDownloads((prev) => [...prev, download]);

        return id;
    };

    const removePendingDownload = (id: string) => {
        setPendingDownloads((prev) => prev.filter((d) => d.id !== id));
    };

    const removePendingByMbid = (mbid: string) => {
        setPendingDownloads((prev) => prev.filter((d) => d.mbid !== mbid));
    };

    const isPending = (subject: string): boolean => {
        return pendingDownloads.some((d) => d.subject === subject);
    };

    const isPendingByMbid = (mbid: string): boolean => {
        // Check both pending downloads AND active download jobs
        const isPendingLocal = pendingDownloads.some((d) => d.mbid === mbid);
        const hasActiveJob = downloadStatus.activeDownloads.some(
            (job) => job.targetMbid === mbid
        );

        return isPendingLocal || hasActiveJob;
    };

    const isAnyPending = (): boolean => {
        return pendingDownloads.length > 0;
    };

    return (
        <DownloadContext.Provider
            value={{
                pendingDownloads,
                downloadStatus,
                addPendingDownload,
                removePendingDownload,
                removePendingByMbid,
                isPending,
                isPendingByMbid,
                isAnyPending,
            }}
        >
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
