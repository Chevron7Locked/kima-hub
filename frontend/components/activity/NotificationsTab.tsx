"use client";

import {
    Bell,
    Check,
    Trash2,
    ListMusic,
    AlertCircle,
    CheckCircle,
    Clock,
    ExternalLink,
} from "lucide-react";
import { GradientSpinner } from "../ui/GradientSpinner";
import { cn } from "@/lib/cn";
import Link from "next/link";
import { useNotifications, type Notification } from "@/hooks/useNotifications";
import { timeAgo } from "@/lib/relative-time";
import { ListHeader } from "./ListHeader";

export function NotificationsTab() {
    const {
        notifications,
        isLoading: loading,
        markAsRead: handleMarkAsRead,
        clearNotification: handleClear,
        clearAll: handleClearAll,
    } = useNotifications();

    const getIcon = (type: string) => {
        switch (type) {
            case "download_complete":
                return <CheckCircle className="h-3.5 w-3.5 text-success" />;
            case "download_failed":
            case "error":
                return <AlertCircle className="h-3.5 w-3.5 text-danger-light" />;
            case "download_waiting":
                return <Clock className="h-3.5 w-3.5 text-warning" />;
            case "playlist_ready":
            case "import_complete":
                return <ListMusic className="h-3.5 w-3.5 text-brand" />;
            case "system":
            default:
                return <Bell className="h-3.5 w-3.5 text-[var(--text-muted)]" />;
        }
    };

    const getLink = (notification: Notification): string | null => {
        if (notification.metadata?.href) {
            return notification.metadata.href;
        }
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

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <GradientSpinner size="sm" />
            </div>
        );
    }

    if (notifications.length === 0) {
        return <p className="px-3 py-4 text-xs text-[var(--text-muted)]">no alerts: you&apos;re all caught up</p>;
    }

    const unread = notifications.filter((n) => !n.read).length;

    return (
        <div className="flex flex-col h-full">
            <ListHeader action={{ label: "clear all", onClick: handleClearAll }}>
                <span>
                    {notifications.length} {notifications.length === 1 ? "alert" : "alerts"}
                    {unread > 0 && <span className="text-brand"> · {unread} new</span>}
                </span>
            </ListHeader>

            <ul className="flex-1 overflow-y-auto pb-1">
                {notifications.map((notification) => {
                    const link = getLink(notification);

                    return (
                        <li
                            key={notification.id}
                            className="group relative flex items-start gap-2.5 px-3 py-2 transition-colors duration-150 hover:bg-white/[0.04] focus-within:bg-white/[0.04]"
                        >
                            <span className="relative mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/[0.04]">
                                {getIcon(notification.type)}
                                {!notification.read && (
                                    <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-brand" />
                                )}
                            </span>

                            <div className="min-w-0 flex-1">
                                <p
                                    className={cn(
                                        "truncate text-[13px] leading-5",
                                        notification.read ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]",
                                    )}
                                >
                                    {/* The dot is for the eye; a screen reader hears the word. */}
                                    {!notification.read && <span className="sr-only">new: </span>}
                                    {notification.title}
                                </p>
                                {notification.message && (
                                    <p className="line-clamp-2 text-xs leading-4 text-[var(--text-muted)]">
                                        {notification.message}
                                    </p>
                                )}
                                <p className="mt-1 flex items-center gap-2 text-[11px] tabular-nums text-[var(--text-muted)]">
                                    {timeAgo(notification.createdAt)}
                                    {link && (
                                        <Link
                                            href={link}
                                            className="inline-flex items-center gap-1 rounded-sm text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/60"
                                        >
                                            view
                                            <ExternalLink aria-hidden="true" className="h-2.5 w-2.5" />
                                        </Link>
                                    )}
                                </p>
                            </div>

                            {/* Shown on hover or focus where there is a pointer; always on a touch screen. */}
                            <div className="flex shrink-0 items-center can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:group-focus-within:opacity-100 transition-opacity">
                                {!notification.read && (
                                    <button
                                        type="button"
                                        onClick={() => handleMarkAsRead(notification.id)}
                                        title="mark as read"
                                        aria-label={`mark ${notification.title} as read`}
                                        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] outline-none transition-colors hover:bg-white/[0.08] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-brand/60"
                                    >
                                        <Check aria-hidden="true" className="h-3.5 w-3.5" />
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={() => handleClear(notification.id)}
                                    title="dismiss"
                                    aria-label={`dismiss ${notification.title}`}
                                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] outline-none transition-colors hover:bg-danger/10 hover:text-danger-light focus-visible:ring-2 focus-visible:ring-brand/60"
                                >
                                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
