"use client";

import { Bell, Download, ListMusic, History } from "lucide-react";
import { useNotifications, useActiveDownloads } from "@/hooks/useNotifications";
import { cn } from "@/utils/cn";

export type ActivityType = "notifications" | "downloads" | "imports" | "history";

interface ActivityIconBarProps {
    expandedActivity: ActivityType | null;
    onToggleActivity: (type: ActivityType) => void;
}

export function ActivityIconBar({ expandedActivity, onToggleActivity }: ActivityIconBarProps) {
    const { unreadCount } = useNotifications();
    const { downloads } = useActiveDownloads();
    const activeDownloadCount = downloads.length;

    const items: { type: ActivityType; icon: typeof Bell; badge: number }[] = [
        { type: "notifications", icon: Bell, badge: unreadCount },
        { type: "downloads", icon: Download, badge: activeDownloadCount },
        { type: "imports", icon: ListMusic, badge: 0 },
        { type: "history", icon: History, badge: 0 },
    ];

    return (
        <div className="flex items-center justify-center gap-1 px-3 py-2 border-b border-white/5">
            {items.map(({ type, icon: Icon, badge }) => (
                <button
                    key={type}
                    onClick={() => onToggleActivity(type)}
                    className={cn(
                        "relative p-2 rounded-md transition-colors",
                        expandedActivity === type
                            ? "bg-white/10 text-white"
                            : "text-white/40 hover:text-white/70 hover:bg-white/5",
                    )}
                    title={type.charAt(0).toUpperCase() + type.slice(1)}
                >
                    <Icon className="w-4 h-4" />
                    {badge > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center bg-[#e35656] text-white text-micro font-bold rounded-full">
                            {badge > 99 ? "99+" : badge}
                        </span>
                    )}
                </button>
            ))}
        </div>
    );
}
