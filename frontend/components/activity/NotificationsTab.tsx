"use client";

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
import { useAuth } from "@/lib/auth-context";

interface Notification {
    id: string;
    type: string;
    title: string;
    message: string | null;
    metadata: Record<string, unknown> | null;
    read: boolean;
    createdAt: string;
}

export function NotificationsTab() {
    const queryClient = useQueryClient();
    const { isAuthenticated } = useAuth();

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
        enabled: isAuthenticated,
    });

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
                return <ListMusic className="w-4 h-4 text-brand" />;
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
            {/* Header with clear all - monospace terminal style */}
            {notifications.length > 0 && (
                <div className="flex items-center justify-between px-3 py-2 border-b-2 border-white/10">
                    <span className="text-[10px] font-mono font-bold text-gray-600 uppercase tracking-wider">
                        {String(notifications.length).padStart(2, "0")} ITEM
                        {notifications.length !== 1 ? "S" : ""}
                    </span>
                    <button
                        onClick={handleClearAll}
                        className="text-[10px] font-mono font-bold text-gray-600 hover:text-white uppercase tracking-wider transition-colors"
                    >
                        CLEAR
                    </button>
                </div>
            )}

            {/* Notification list - data stream style */}
            <div className="flex-1 overflow-y-auto">
                {notifications.map((notification, index) => {
                    const link = getLink(notification);

                    return (
                        <div
                            key={notification.id}
                            className={cn(
                                "px-3 py-3 border-b border-white/5 transition-colors group relative",
                                !notification.read && "bg-[var(--bg-secondary)] border-l-2 border-[#eab308]",
                                notification.read && "border-l-2 border-transparent hover:border-white/20 hover:bg-white/5"
                            )}
                        >
                            <div className="flex items-start gap-3">
                                {/* Index number */}
                                <div className="flex-shrink-0 w-6 mt-0.5">
                                    <span className="text-[10px] font-mono font-bold text-gray-700">
                                        {String(index + 1).padStart(2, "0")}
                                    </span>
                                </div>

                                {/* Icon + status */}
                                <div className="mt-0.5 flex-shrink-0">
                                    {getIcon(notification.type)}
                                </div>

                                {/* Content */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <p
                                            className={cn(
                                                "text-xs font-black tracking-tight truncate uppercase",
                                                notification.read
                                                    ? "text-gray-500"
                                                    : "text-white"
                                            )}
                                        >
                                            {notification.title}
                                        </p>
                                    </div>
                                    {notification.message && (
                                        <p className="text-[10px] text-gray-600 mt-0.5 line-clamp-2 font-mono">
                                            {notification.message}
                                        </p>
                                    )}
                                    <div className="flex items-center gap-2 mt-1.5">
                                        <span className="text-[9px] font-mono text-gray-700 uppercase tracking-wider">
                                            {formatTime(notification.createdAt)}
                                        </span>
                                        {link && (
                                            <Link
                                                href={link}
                                                className="text-[9px] font-mono font-bold text-[#eab308] hover:underline flex items-center gap-1 uppercase tracking-wider"
                                            >
                                                VIEW
                                                <ExternalLink className="w-2.5 h-2.5" />
                                            </Link>
                                        )}
                                    </div>
                                </div>

                                {/* Actions - always visible on desktop for angular look */}
                                <div className="flex items-center gap-1">
                                    {!notification.read && (
                                        <button
                                            onClick={() =>
                                                handleMarkAsRead(
                                                    notification.id
                                                )
                                            }
                                            className="p-1 hover:bg-white/10 transition-colors"
                                            title="Mark as read"
                                        >
                                            <Check className="w-3 h-3 text-gray-700 hover:text-white" />
                                        </button>
                                    )}
                                    <button
                                        onClick={() =>
                                            handleClear(notification.id)
                                        }
                                        className="p-1 hover:bg-white/10 transition-colors"
                                        title="Dismiss"
                                    >
                                        <Trash2 className="w-3 h-3 text-gray-700 hover:text-red-400" />
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
