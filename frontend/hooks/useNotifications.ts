"use client";

import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export interface Notification {
    id: string;
    userId: string;
    type: string;
    title: string;
    message?: string;
    metadata?: Record<string, unknown>;
    read: boolean;
    cleared: boolean;
    createdAt: string;
}

export interface DownloadHistoryItem {
    id: string;
    subject: string;
    type: string;
    targetMbid: string;
    status: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    metadata?: {
        statusText?: string;
        currentSource?: "lidarr" | "soulseek";
        lidarrAttempts?: number;
        soulseekAttempts?: number;
        [key: string]: unknown;
    };
}

const EMPTY_DOWNLOADS: DownloadHistoryItem[] = [];

/**
 * Hook for managing notifications using React Query as single source of truth.
 * All components using this hook share the same cache and update together.
 */
export function useNotifications() {
    const queryClient = useQueryClient();

    // Single source of truth - React Query cache
    const {
        data: notifications = [],
        isLoading,
        error,
        refetch,
    } = useQuery<Notification[]>({
        queryKey: ["notifications"],
        queryFn: () => api.get<Notification[]>("/notifications"),
    });

    // Derive unread count from data (computed, not stored)
    const unreadCount = notifications.filter((n) => !n.read).length;

    // Mark as read mutation with optimistic update
    const markAsReadMutation = useMutation({
        mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
        onMutate: async (id: string) => {
            await queryClient.cancelQueries({ queryKey: ["notifications"] });
            const previous = queryClient.getQueryData<Notification[]>(["notifications"]);

            queryClient.setQueryData<Notification[]>(["notifications"], (old) =>
                old?.map((n) => (n.id === id ? { ...n, read: true } : n)) || []
            );

            return { previous };
        },
        onError: (_err, _id, context) => {
            if (context?.previous) {
                queryClient.setQueryData(["notifications"], context.previous);
            }
        },
    });

    // Mark all as read mutation with optimistic update
    const markAllAsReadMutation = useMutation({
        mutationFn: () => api.post("/notifications/read-all"),
        onMutate: async () => {
            await queryClient.cancelQueries({ queryKey: ["notifications"] });
            const previous = queryClient.getQueryData<Notification[]>(["notifications"]);

            queryClient.setQueryData<Notification[]>(["notifications"], (old) =>
                old?.map((n) => ({ ...n, read: true })) || []
            );

            return { previous };
        },
        onError: (_err, _vars, context) => {
            if (context?.previous) {
                queryClient.setQueryData(["notifications"], context.previous);
            }
        },
    });

    // Clear notification mutation with optimistic update
    const clearMutation = useMutation({
        mutationFn: (id: string) => api.post(`/notifications/${id}/clear`),
        onMutate: async (id: string) => {
            await queryClient.cancelQueries({ queryKey: ["notifications"] });
            const previous = queryClient.getQueryData<Notification[]>(["notifications"]);

            queryClient.setQueryData<Notification[]>(["notifications"], (old) =>
                old?.filter((n) => n.id !== id) || []
            );

            return { previous };
        },
        onError: (_err, _id, context) => {
            if (context?.previous) {
                queryClient.setQueryData(["notifications"], context.previous);
            }
        },
    });

    // Clear all mutation with optimistic update
    const clearAllMutation = useMutation({
        mutationFn: () => api.post("/notifications/clear-all"),
        onMutate: async () => {
            await queryClient.cancelQueries({ queryKey: ["notifications"] });
            const previous = queryClient.getQueryData<Notification[]>(["notifications"]);

            queryClient.setQueryData<Notification[]>(["notifications"], []);

            return { previous };
        },
        onError: (_err, _vars, context) => {
            if (context?.previous) {
                queryClient.setQueryData(["notifications"], context.previous);
            }
        },
    });

    return {
        notifications,
        unreadCount,
        isLoading,
        error: error instanceof Error ? error.message : null,
        refetch,
        markAsRead: (id: string) => markAsReadMutation.mutate(id),
        markAllAsRead: () => markAllAsReadMutation.mutate(),
        clearNotification: (id: string) => clearMutation.mutate(id),
        clearAll: () => clearAllMutation.mutate(),
    };
}

/**
 * Hook for download history - unchanged from original
 */
export function useDownloadHistory() {
    const fetchHistory = useCallback(async () => {
        return api.get<DownloadHistoryItem[]>("/notifications/downloads/history");
    }, []);

    const {
        data: history = [],
        isLoading,
        error,
        refetch,
    } = useQuery<DownloadHistoryItem[]>({
        queryKey: ["download-history"],
        queryFn: fetchHistory,
    });

    const queryClient = useQueryClient();

    const clearDownload = useCallback(async (id: string) => {
        try {
            await api.post(`/notifications/downloads/${id}/clear`);
            queryClient.setQueryData<DownloadHistoryItem[]>(
                ["download-history"],
                (old) => old?.filter((d) => d.id !== id) || []
            );
        } catch (err: unknown) {
            console.error("Failed to clear download:", err);
        }
    }, [queryClient]);

    const clearAll = useCallback(async () => {
        try {
            await api.post("/notifications/downloads/clear-all");
            queryClient.setQueryData<DownloadHistoryItem[]>(["download-history"], []);
        } catch (err: unknown) {
            console.error("Failed to clear all:", err);
        }
    }, [queryClient]);

    const retryDownload = useCallback(async (id: string) => {
        try {
            await api.post(`/notifications/downloads/${id}/retry`);
            queryClient.setQueryData<DownloadHistoryItem[]>(
                ["download-history"],
                (old) => old?.filter((d) => d.id !== id) || []
            );
        } catch (err: unknown) {
            console.error("Failed to retry download:", err);
        }
    }, [queryClient]);

    return {
        history,
        isLoading,
        error: error instanceof Error ? error.message : null,
        refetch,
        clearDownload,
        clearAll,
        retryDownload,
    };
}

/**
 * Hook for active downloads. Updates are driven by SSE events
 * (download:complete, download:failed) invalidating the query cache.
 */
export function useActiveDownloads() {
    const { isAuthenticated } = useAuth();
    const fetchDownloads = useCallback(async () => {
        return api.get<DownloadHistoryItem[]>("/notifications/downloads/active");
    }, []);

    const {
        data: downloads = EMPTY_DOWNLOADS,
        isLoading,
        error,
        refetch,
    } = useQuery<DownloadHistoryItem[]>({
        queryKey: ["active-downloads"],
        queryFn: fetchDownloads,
        enabled: isAuthenticated,
    });

    return {
        downloads,
        isLoading,
        error: error instanceof Error ? error.message : null,
        refetch,
    };
}
