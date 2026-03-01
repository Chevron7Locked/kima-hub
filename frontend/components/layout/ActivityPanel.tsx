"use client";

import { useState, useEffect, useCallback } from "react";
import { useNotifications } from "@/hooks/useNotifications";
import { useActiveDownloads } from "@/hooks/useNotifications";
import { NotificationsTab } from "@/components/activity/NotificationsTab";
import { ActiveDownloadsTab } from "@/components/activity/ActiveDownloadsTab";
import { HistoryTab } from "@/components/activity/HistoryTab";
import {
    Bell,
    Download,
    History,
    ChevronLeft,
    ChevronRight,
    X,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";

type ActivityTab = "notifications" | "active" | "history" | "settings";

const TABS: { id: ActivityTab; label: string; icon: React.ElementType }[] = [
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "active", label: "Active", icon: Download },
    { id: "history", label: "History", icon: History },
];

interface ActivityPanelProps {
    isOpen: boolean;
    onToggle: () => void;
    activeTab?: ActivityTab;
    onTabChange?: (tab: ActivityTab) => void;
    settingsContent?: React.ReactNode;
    onSettingsDismissed?: () => void;
}

export function ActivityPanel({
    isOpen,
    onToggle,
    activeTab,
    onTabChange,
    settingsContent,
    onSettingsDismissed,
}: ActivityPanelProps) {
    const [internalActiveTab, setInternalActiveTab] =
        useState<ActivityTab>("notifications");
    const resolvedActiveTab = activeTab ?? internalActiveTab;
    const setResolvedActiveTab = onTabChange ?? setInternalActiveTab;
    const { unreadCount } = useNotifications();
    const { downloads: activeDownloads } = useActiveDownloads();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const handleTabClick = useCallback((tab: ActivityTab) => {
        if (tab !== "settings" && resolvedActiveTab === "settings" && settingsContent) {
            onSettingsDismissed?.();
        }
        setResolvedActiveTab(tab);
    }, [resolvedActiveTab, settingsContent, onSettingsDismissed, setResolvedActiveTab]);

    // If settings tab is active but no settings content provided, default to notifications
    useEffect(() => {
        if (resolvedActiveTab === "settings" && !settingsContent) {
            setResolvedActiveTab("notifications");
        }
    }, [resolvedActiveTab, settingsContent, setResolvedActiveTab]);

    // Badge counts
    const notificationBadge = unreadCount > 0 ? unreadCount : null;
    const activeBadge =
        activeDownloads.length > 0 ? activeDownloads.length : null;
    const hasActivity = unreadCount > 0 || activeDownloads.length > 0;

    // Mobile/Tablet: Full-screen overlay
    if (isMobileOrTablet) {
        if (!isOpen) return null;

        return (
            <>
                {/* Backdrop */}
                <div
                    className="fixed inset-0 bg-black/60 z-[100]"
                    onClick={onToggle}
                />

                {/* Panel - slides in from right */}
                <div
                    className="fixed inset-y-0 right-0 w-full max-w-md bg-[#0a0a0a] z-[101] flex flex-col"
                    style={{ paddingTop: "var(--standalone-safe-area-top, 0px)" }}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-4 border-b border-white/10">
                        <h2 className="text-lg font-semibold text-white">
                            Activity
                        </h2>
                        <button
                            onClick={onToggle}
                            className="p-2 hover:bg-white/10 rounded-full transition-colors"
                            title="Close"
                        >
                            <X className="w-5 h-5 text-white/60" />
                        </button>
                    </div>

                    {/* Tabs */}
                    <div className="flex border-b border-white/10">
                        {TABS.map((tab) => {
                            const Icon = tab.icon;
                            const badge =
                                tab.id === "notifications"
                                    ? notificationBadge
                                    : tab.id === "active"
                                    ? activeBadge
                                    : null;

                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => handleTabClick(tab.id)}
                                    className={cn(
                                        "flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors relative",
                                        resolvedActiveTab === tab.id
                                            ? "text-white border-b-2 border-[#f5c518]"
                                            : "text-white/50 hover:text-white/70"
                                    )}
                                >
                                    <Icon className="w-4 h-4" />
                                    <span>{tab.label}</span>
                                    {badge && (
                                        <span
                                            className={cn(
                                                "min-w-[18px] h-[18px] px-1 rounded-full text-xs font-bold flex items-center justify-center ml-1",
                                                tab.id === "active"
                                                    ? "bg-blue-500 text-white"
                                                    : "bg-[#f5c518] text-black"
                                            )}
                                        >
                                            {badge > 99 ? "99+" : badge}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    {/* Tab Content */}
                    <div className="flex-1 overflow-hidden">
                        {resolvedActiveTab === "notifications" && (
                            <NotificationsTab />
                        )}
                        {resolvedActiveTab === "active" && (
                            <ActiveDownloadsTab />
                        )}
                        {resolvedActiveTab === "history" && <HistoryTab />}
                        {resolvedActiveTab === "settings" && settingsContent}
                    </div>
                </div>
            </>
        );
    }

    // Desktop: Side panel - uses transform instead of width for GPU-accelerated animation
    return (
        <div
            className="shrink-0 h-full relative z-10"
            style={{ width: isOpen ? 450 : 48 }}
        >
            {/* Panel container - slides via transform (GPU-accelerated, no layout recalc) */}
            <div
                className="absolute inset-y-0 right-0 w-[450px] bg-[#0a0a0a] flex flex-col overflow-hidden transition-transform duration-200 ease-out"
                style={{
                    transform: isOpen ? 'translateX(0)' : 'translateX(402px)',
                    willChange: 'transform',
                }}
            >
                {/* Collapsed state overlay - clickable strip on left */}
                <div
                    onClick={onToggle}
                    className={cn(
                        "absolute left-0 top-0 bottom-0 w-12 flex items-center justify-center cursor-pointer hover:bg-[#141414] transition-colors z-10",
                        isOpen && "pointer-events-none opacity-0"
                    )}
                    title="Open activity panel"
                >
                    <ChevronLeft className="w-5 h-5 text-white/40" />

                    {/* Activity badge - status indicator */}
                    {hasActivity && (
                        <span className="absolute top-4 right-3 w-1.5 h-1.5 rounded-full bg-[#22c55e]" />
                    )}
                </div>

                {/* Expanded content */}
                <div
                    className={cn(
                        "flex flex-col h-full transition-opacity duration-150",
                        isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
                    )}
                >
                {/* Header - Command Index style */}
                <div className="flex items-center justify-between px-4 py-4 border-b-2 border-white/10">
                    <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 bg-[#22c55e] rounded-full" />
                        <h2 className="text-xs font-mono font-black text-gray-600 uppercase tracking-wider whitespace-nowrap">
                            Activity Feed
                        </h2>
                    </div>
                    <button
                        onClick={onToggle}
                        className="p-1 hover:bg-white/10 transition-colors"
                        title="Close panel"
                    >
                        <ChevronRight className="w-4 h-4 text-gray-600" />
                    </button>
                </div>

                {/* Tabs - Terminal style */}
                <div className="flex border-b-2 border-white/10 px-2 pt-2">
                    {TABS.map((tab) => {
                        const Icon = tab.icon;
                        const badge =
                            tab.id === "notifications"
                                ? notificationBadge
                                : tab.id === "active"
                                ? activeBadge
                                : null;

                        return (
                            <button
                                key={tab.id}
                                onClick={() => handleTabClick(tab.id)}
                                className={cn(
                                    "flex-1 flex items-center justify-center gap-2 py-2.5 px-2 text-xs font-mono font-bold uppercase tracking-wider transition-all relative whitespace-nowrap border-l-2",
                                    resolvedActiveTab === tab.id
                                        ? "bg-[#0f0f0f] border-[#eab308] text-white"
                                        : "border-transparent text-gray-600 hover:text-white hover:bg-white/5"
                                )}
                            >
                                <Icon className="w-3.5 h-3.5" />
                                <span className="hidden lg:inline">{tab.label}</span>
                                {badge && (
                                    <span className="text-[10px] font-mono text-[#eab308]">
                                        {badge > 99 ? "99" : badge}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-hidden">
                    {resolvedActiveTab === "notifications" && (
                        <NotificationsTab />
                    )}
                    {resolvedActiveTab === "active" && <ActiveDownloadsTab />}
                    {resolvedActiveTab === "history" && <HistoryTab />}
                    {resolvedActiveTab === "settings" && settingsContent}
                </div>
                </div>
            </div>
        </div>
    );
}

// Toggle button for TopBar
export function ActivityPanelToggle() {
    const { unreadCount } = useNotifications();
    const { downloads: activeDownloads } = useActiveDownloads();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    if (isMobile || isTablet) {
        return null;
    }

    const hasActivity = unreadCount > 0 || activeDownloads.length > 0;

    return (
        <button
            onClick={() =>
                window.dispatchEvent(new CustomEvent("toggle-activity-panel"))
            }
            className={cn(
                "relative p-2 rounded-full transition-all",
                "text-white/60 hover:text-white"
            )}
            title="Toggle activity panel"
        >
            <Bell className="w-5 h-5" />
            {hasActivity && (
                <span className="absolute top-1.5 right-2 w-1 h-1 rounded-full bg-[#ecb200]" />
            )}
        </button>
    );
}
