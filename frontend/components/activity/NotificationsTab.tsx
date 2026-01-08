"use client";

import { useEffect, useRef } from "react";
import {
    Bell,
    Check,
    Trash2,
    ListMusic,
    AlertCircle,
    CheckCircle,
    ExternalLink,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface Notification {
    id: string;
    type: string;
    title: string;
    message: string | null;
    metadata: any;
    read: boolean;
    createdAt: string;
}

export function NotificationsTab() {
    const queryClient = useQueryClient();
    const previousNotificationIds = useRef<Set<string>>(new Set());

    const {
        data: notifications = [],
        isLoading: loading,
        error,
    } = useQuery<Notification[]>({
        queryKey: ["notifications"],
        queryFn: async () => {
            const result = await api.getNotifications();
            return result;
        },
        refetchInterval: 30000, // Poll every 30 seconds
    });

    // Dispatch events when new playlist-related notifications arrive
    useEffect(() => {
        if (!notifications || notifications.length === 0) return;

        const currentIds = new Set(notifications.map((n) => n.id));

        // Check for new playlist-related notifications
        for (const notification of notifications) {
            if (!previousNotificationIds.current.has(notification.id)) {
                // This is a new notification
                if (
                    notification.type === "playlist_ready" ||
                    notification.type === "import_complete"
                ) {
                    window.dispatchEvent(new CustomEvent("playlist-created"));
                }
            }
        }

        previousNotificationIds.current = currentIds;
    }, [notifications]);

    // Log error if any
    if (error) {
        console.error(
            "[NotificationsTab] Error fetching notifications:",
            error
        );
    }

    // Mark as read - optimistic update
    const markAsReadMutation = useMutation({
        mutationFn: (id: string) => api.markNotificationAsRead(id),
        onMutate: async (id: string) => {
            await queryClient.cancelQueries({ queryKey: ["notifications"] });

            const previousNotifications = queryClient.getQueryData<
                Notification[]
            >(["notifications"]);

            // Optimistically update
            queryClient.setQueryData<Notification[]>(
                ["notifications"],
                (old) =>
                    old?.map((n) => (n.id === id ? { ...n, read: true } : n)) ||
                    []
            );

            return { previousNotifications };
        },
        onError: (_err, _id, context) => {
            // Rollback on error
            if (context?.previousNotifications) {
                queryClient.setQueryData(
                    ["notifications"],
                    context.previousNotifications
                );
            }
        },
    });

    // Clear single notification - optimistic update
    const clearMutation = useMutation({
        mutationFn: (id: string) => api.clearNotification(id),
        onMutate: async (id: string) => {
            await queryClient.cancelQueries({ queryKey: ["notifications"] });

            const previousNotifications = queryClient.getQueryData<
                Notification[]
            >(["notifications"]);

            // Optimistically remove
            queryClient.setQueryData<Notification[]>(
                ["notifications"],
                (old) => old?.filter((n) => n.id !== id) || []
            );

            return { previousNotifications };
        },
        onError: (_err, _id, context) => {
            if (context?.previousNotifications) {
                queryClient.setQueryData(
                    ["notifications"],
                    context.previousNotifications
                );
            }
        },
    });

    // Clear all notifications - optimistic update
    const clearAllMutation = useMutation({
        mutationFn: () => api.clearAllNotifications(),
        onMutate: async () => {
            await queryClient.cancelQueries({ queryKey: ["notifications"] });

            const previousNotifications = queryClient.getQueryData<
                Notification[]
            >(["notifications"]);

            // Optimistically clear all
            queryClient.setQueryData<Notification[]>(["notifications"], []);

            return { previousNotifications };
        },
        onError: (_err, _vars, context) => {
            if (context?.previousNotifications) {
                queryClient.setQueryData(
                    ["notifications"],
                    context.previousNotifications
                );
            }
        },
    });

    const handleMarkAsRead = (id: string) => markAsReadMutation.mutate(id);
    const handleClear = (id: string) => clearMutation.mutate(id);
    const handleClearAll = () => clearAllMutation.mutate();

    const getIcon = (type: string) => {
        switch (type) {
            case "download_complete":
                return <CheckCircle className="w-4 h-4 text-green-400" />;
            case "download_failed":
                return <AlertCircle className="w-4 h-4 text-red-400" />;
            case "playlist_ready":
            case "import_complete":
                return <ListMusic className="w-4 h-4 text-[#ecb200]" />;
            case "system":
            default:
                return <Bell className="w-4 h-4 text-white/60" />;
        }
    };

    const getLink = (notification: Notification): string | null => {
        if (notification.metadata?.playlistId) {
            return `/playlist/${notification.metadata.playlistId}`;
        }
        if (notification.metadata?.albumId) {
            return `/album/${notification.metadata.albumId}`;
        }
        if (notification.metadata?.artistId) {
            return `/artist/${notification.metadata.artistId}`;
        }
        return null;
    };

    const formatTime = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now.getTime() - date.getTime();

        if (diff < 60000) return "Just now";
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return date.toLocaleDateString();
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            </div>
        );
    }

    if (notifications.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <Bell className="w-8 h-8 text-white/20 mb-3" />
                <p className="text-sm text-white/40">No notifications</p>
                <p className="text-xs text-white/30 mt-1">
                    You&apos;re all caught up!
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header with clear all */}
            {notifications.length > 0 && (
                <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                    <span className="text-xs text-white/40">
                        {notifications.length} notification
                        {notifications.length !== 1 ? "s" : ""}
                    </span>
                    <button
                        onClick={handleClearAll}
                        className="text-xs text-white/40 hover:text-white transition-colors"
                    >
                        Clear all
                    </button>
                </div>
            )}

            {/* Notification list */}
            <div className="flex-1 overflow-y-auto">
                {notifications.map((notification) => {
                    const link = getLink(notification);

                    return (
                        <div
                            key={notification.id}
                            className={cn(
                                "px-3 py-3 border-b border-white/5 hover:bg-white/5 transition-colors group",
                                !notification.read && "bg-white/[0.02]"
                            )}
                        >
                            <div className="flex items-start gap-3">
                                <div className="mt-0.5 flex-shrink-0">
                                    {getIcon(notification.type)}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <p
                                            className={cn(
                                                "text-sm font-medium truncate",
                                                notification.read
                                                    ? "text-white/70"
                                                    : "text-white"
                                            )}
                                        >
                                            {notification.title}
                                        </p>
                                        {!notification.read && (
                                            <span className="w-1.5 h-1.5 rounded-full bg-[#ecb200] flex-shrink-0" />
                                        )}
                                    </div>
                                    {notification.message && (
                                        <p className="text-xs text-white/50 mt-0.5 line-clamp-2">
                                            {notification.message}
                                        </p>
                                    )}
                                    <div className="flex items-center gap-2 mt-1.5">
                                        <span className="text-[10px] text-white/30">
                                            {formatTime(notification.createdAt)}
                                        </span>
                                        {link && (
                                            <Link
                                                href={link}
                                                className="text-[10px] text-[#ecb200] hover:underline flex items-center gap-0.5"
                                            >
                                                View{" "}
                                                <ExternalLink className="w-2.5 h-2.5" />
                                            </Link>
                                        )}
                                    </div>
                                </div>
                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    {!notification.read && (
                                        <button
                                            onClick={() =>
                                                handleMarkAsRead(
                                                    notification.id
                                                )
                                            }
                                            className="p-1 hover:bg-white/10 rounded transition-colors"
                                            title="Mark as read"
                                        >
                                            <Check className="w-3.5 h-3.5 text-white/40 hover:text-white" />
                                        </button>
                                    )}
                                    <button
                                        onClick={() =>
                                            handleClear(notification.id)
                                        }
                                        className="p-1 hover:bg-white/10 rounded transition-colors"
                                        title="Dismiss"
                                    >
                                        <Trash2 className="w-3.5 h-3.5 text-white/40 hover:text-red-400" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
