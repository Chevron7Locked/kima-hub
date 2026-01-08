import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface DownloadJob {
    id: string;
    type: "artist" | "album";
    subject: string;
    targetMbid: string;
    status: "pending" | "processing" | "completed" | "failed";
    createdAt: string;
    completedAt?: string;
    error?: string;
    metadata?: {
        statusText?: string;
        currentSource?: "lidarr" | "soulseek";
        lidarrAttempts?: number;
        soulseekAttempts?: number;
    };
}

export interface DownloadStatus {
    activeDownloads: DownloadJob[];
    recentDownloads: DownloadJob[];
    hasActiveDownloads: boolean;
    failedDownloads: DownloadJob[];
}

/**
 * Hook to monitor download job status
 * Polls for active downloads and keeps track of recent completions/failures
 * @param pollingInterval - How often to poll in milliseconds (default: 15000)
 * @param isAuthenticated - Whether the user is authenticated (required to prevent polling when logged out)
 */
export function useDownloadStatus(
    pollingInterval: number = 15000,
    isAuthenticated: boolean = false
) {
    const [status, setStatus] = useState<DownloadStatus>({
        activeDownloads: [],
        recentDownloads: [],
        hasActiveDownloads: false,
        failedDownloads: [],
    });

    useEffect(() => {
        // Don't poll if user is not authenticated
        if (!isAuthenticated) {
            return;
        }

        let mounted = true;
        let pollTimeout: NodeJS.Timeout | null = null;
        let errorCount = 0;

        const pollDownloads = async () => {
            try {
                // Fetch recent download jobs (last 50)
                const response = await api.getDownloads(50);

                if (!mounted) return;

                // Reset error count on successful request
                errorCount = 0;

                const now = new Date();
                const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

                const activeDownloads = response.filter(
                    (job) =>
                        job.status === "pending" || job.status === "processing"
                );

                const recentDownloads = response.filter(
                    (job) =>
                        (job.status === "completed" ||
                            job.status === "failed") &&
                        new Date(job.completedAt || job.createdAt) >
                            fiveMinutesAgo
                );

                const failedDownloads = response.filter(
                    (job) =>
                        job.status === "failed" &&
                        new Date(job.completedAt || job.createdAt) >
                            fiveMinutesAgo
                );

                setStatus({
                    activeDownloads,
                    recentDownloads,
                    hasActiveDownloads: activeDownloads.length > 0,
                    failedDownloads,
                });

                // Continue polling if there are active downloads
                if (activeDownloads.length > 0) {
                    // Poll faster when downloads are active (5 seconds)
                    pollTimeout = setTimeout(pollDownloads, 5000);
                } else if (
                    activeDownloads.length === 0 &&
                    response.length > 0
                ) {
                    // Some jobs exist but none active - check again in 10 seconds
                    // to catch newly created jobs
                    pollTimeout = setTimeout(pollDownloads, 10000);
                } else {
                    // No downloads at all - check again in 30 seconds
                    pollTimeout = setTimeout(pollDownloads, 30000);
                }
            } catch (error: any) {
                console.error("Failed to poll download status:", error);

                // Increment error count
                errorCount++;

                // Exponential backoff on errors (max 2 minutes)
                const backoffDelay = Math.min(
                    pollingInterval * Math.pow(2, errorCount),
                    120000
                );

                // Silently continue on rate limit errors - don't spam console
                if (error.message !== "Too Many Requests") {
                    console.error("Download polling error:", error);
                }

                // Retry with backoff
                if (mounted) {
                    pollTimeout = setTimeout(pollDownloads, backoffDelay);
                }
            }
        };

        // Start polling
        pollDownloads();

        // Listen for download status changes (e.g., when user clears history)
        const handleDownloadStatusChanged = () => {
            pollDownloads();
        };
        window.addEventListener(
            "download-status-changed",
            handleDownloadStatusChanged
        );

        return () => {
            mounted = false;
            if (pollTimeout) {
                clearTimeout(pollTimeout);
            }
            window.removeEventListener(
                "download-status-changed",
                handleDownloadStatusChanged
            );
        };
    }, [pollingInterval, isAuthenticated]);

    return status;
}
