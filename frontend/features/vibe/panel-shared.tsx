"use client";

import { NowPlayingTab } from "./tabs/NowPlayingTab";
import { QueueTab } from "./tabs/QueueTab";
import { LyricsTab } from "./tabs/LyricsTab";
import { NotificationsTab } from "@/components/activity/NotificationsTab";
import { ActiveDownloadsTab } from "@/components/activity/ActiveDownloadsTab";
import { ImportsTab } from "@/components/activity/ImportsTab";
import { HistoryTab } from "@/components/activity/HistoryTab";
import type { ActivityType } from "./ActivityIconBar";
import { cn } from "@/utils/cn";
import { X } from "lucide-react";

export type VibeTab = "now-playing" | "queue" | "lyrics";

export const TABS: { key: VibeTab; label: string }[] = [
    { key: "now-playing", label: "Now Playing" },
    { key: "queue", label: "Queue" },
    { key: "lyrics", label: "Lyrics" },
];

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
    notifications: "Notifications",
    downloads: "Downloads",
    imports: "Imports",
    history: "History",
};

export function ActivityContent({ type }: { type: ActivityType }) {
    switch (type) {
        case "notifications": return <NotificationsTab />;
        case "downloads": return <ActiveDownloadsTab />;
        case "imports": return <ImportsTab />;
        case "history": return <HistoryTab />;
    }
}

export function ActivityHeader({
    type,
    onClose,
}: {
    type: ActivityType;
    onClose: () => void;
}) {
    return (
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 shrink-0">
            <span className="text-xs font-medium text-[var(--text-secondary)]">
                {ACTIVITY_LABELS[type]}
            </span>
            <button
                onClick={onClose}
                className="p-1 rounded hover:bg-white/10 transition-colors"
            >
                <X className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            </button>
        </div>
    );
}

export function TabBar({
    activeTab,
    onTabClick,
}: {
    activeTab: VibeTab;
    onTabClick: (tab: VibeTab) => void;
}) {
    return (
        <div className="flex border-b border-white/5 shrink-0">
            {TABS.map((tab) => (
                <button
                    key={tab.key}
                    onClick={() => onTabClick(tab.key)}
                    className={cn(
                        "flex-1 px-3 py-2.5 text-xs font-medium transition-colors",
                        activeTab === tab.key
                            ? "text-white border-b-2 border-[var(--color-brand)]"
                            : "text-[var(--text-secondary)] hover:text-white/70",
                    )}
                >
                    {tab.label}
                </button>
            ))}
        </div>
    );
}

export function TabContent({ activeTab }: { activeTab: VibeTab }) {
    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            {activeTab === "now-playing" && <NowPlayingTab />}
            {activeTab === "queue" && <QueueTab />}
            {activeTab === "lyrics" && <LyricsTab />}
        </div>
    );
}
