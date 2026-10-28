"use client";

import { useState, useEffect, useCallback } from "react";
import { useNotifications } from "@/hooks/useNotifications";
import { useActiveDownloads } from "@/hooks/useNotifications";
import { NotificationsTab } from "@/components/activity/NotificationsTab";
import { ActiveDownloadsTab } from "@/components/activity/ActiveDownloadsTab";
import { HistoryTab } from "@/components/activity/HistoryTab";
import { ImportsTab } from "@/components/activity/ImportsTab";
import { Bell, X } from "lucide-react";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import type { ActivityType } from "@/features/vibe/ActivityIconBar";
import { PanelOptions, panelTabId } from "./panelChrome";
import { cn } from "@/lib/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { useActivityPanelSettings } from "@/lib/activity-panel-settings-context";
import { useActivityPanelOpen } from "@/hooks/useActivityPanel";

type ActivityTab = "all" | "notifications" | "active" | "imports" | "history" | "settings";

/** The merged list's rows name the panel's activity kinds; the sheet's tab for each. */
const SHEET_TAB: Record<ActivityType, ActivityTab> = {
    notifications: "notifications",
    downloads: "active",
    imports: "imports",
    history: "history",
};

interface ActivityPanelProps {
    isOpen: boolean;
    onToggle: () => void;
    activeTab?: ActivityTab;
    onTabChange?: (tab: ActivityTab) => void;
}

export function ActivityPanel({
    isOpen,
    onToggle,
    activeTab,
    onTabChange,
}: ActivityPanelProps) {
    const { settingsContent, setSettingsContent } = useActivityPanelSettings();
    const [internalActiveTab, setInternalActiveTab] =
        useState<ActivityTab>("notifications");
    const resolvedActiveTab = activeTab ?? internalActiveTab;
    const setResolvedActiveTab = onTabChange ?? setInternalActiveTab;
    const { unreadCount } = useNotifications();
    const { downloads: activeDownloads } = useActiveDownloads();

    const handleTabClick = useCallback((tab: ActivityTab) => {
        if (tab !== "settings" && resolvedActiveTab === "settings" && settingsContent) {
            setSettingsContent(null);
        }
        setResolvedActiveTab(tab);
    }, [resolvedActiveTab, settingsContent, setSettingsContent, setResolvedActiveTab]);

    // If settings tab is active but no settings content provided, default to notifications
    useEffect(() => {
        if (resolvedActiveTab === "settings" && !settingsContent) {
            setResolvedActiveTab("notifications");
        }
    }, [resolvedActiveTab, settingsContent, setResolvedActiveTab]);

    const notificationBadge = unreadCount > 0 ? unreadCount : null;
    const activeBadge =
        activeDownloads.length > 0 ? activeDownloads.length : null;

    // A phone or tablet overlay: the desktop layout shows the side panel (UnifiedPanel).
    if (!isOpen) return null;

    return (
        <>
            <div
                className="fixed inset-0 bg-black/60 z-(--z-panel-backdrop)"
                onClick={onToggle}
            />

            {/* Panel - slides in from right */}
            <div
                id="activity-panel-mobile"
                className="fixed inset-y-0 right-0 w-full max-w-md bg-[var(--bg-primary)] z-(--z-panel) flex flex-col"
                style={{ paddingTop: "var(--standalone-safe-area-top, 0px)" }}
            >
                <div className="flex items-center justify-between px-4 py-3">
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">activity</h2>
                    <button
                        type="button"
                        onClick={onToggle}
                        aria-label="close activity"
                        className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand/60"
                    >
                        <X aria-hidden="true" className="h-5 w-5" />
                    </button>
                </div>

                <PanelOptions<Exclude<ActivityTab, "settings">>
                    label="activity"
                    controls="activity-sheet-content"
                    value={resolvedActiveTab === "settings" ? null : resolvedActiveTab}
                    onChange={handleTabClick}
                    options={[
                        { key: "all", label: "all" },
                        { key: "notifications", label: "alerts", count: notificationBadge ?? 0, urgent: true },
                        { key: "active", label: "downloads", count: activeBadge ?? 0, urgent: true },
                        { key: "imports", label: "imports" },
                        { key: "history", label: "history" },
                    ]}
                />

                {/* A page's settings are not one of the tabs: while they show, no tab is chosen and the region is named for them. */}
                <div
                    id="activity-sheet-content"
                    {...(resolvedActiveTab === "settings"
                        ? { role: "region", "aria-label": "settings" }
                        : { role: "tabpanel", "aria-labelledby": panelTabId("activity-sheet-content", resolvedActiveTab) })}
                    className="flex-1 overflow-hidden"
                >
                    {resolvedActiveTab === "all" && (
                        <div className="h-full overflow-y-auto">
                            <ActivityFeed onOpen={(type) => handleTabClick(SHEET_TAB[type])} />
                        </div>
                    )}
                    {resolvedActiveTab === "notifications" && (
                        <NotificationsTab />
                    )}
                    {resolvedActiveTab === "active" && (
                        <ActiveDownloadsTab />
                    )}
                    {resolvedActiveTab === "imports" && <ImportsTab />}
                    {resolvedActiveTab === "history" && <HistoryTab />}
                    {resolvedActiveTab === "settings" && settingsContent}
                </div>
            </div>
        </>
    );
}

export function ActivityPanelToggle() {
    const { unreadCount } = useNotifications();
    const { downloads: activeDownloads } = useActiveDownloads();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isPanelOpen = useActivityPanelOpen();

    if (isMobile || isTablet) {
        return null;
    }

    const hasActivity = unreadCount > 0 || activeDownloads.length > 0;

    return (
        <button
            onClick={() =>
                window.dispatchEvent(new CustomEvent("toggle-activity-panel"))
            }
            aria-expanded={isPanelOpen}
            aria-controls="activity-panel"
            className={cn(
                "relative p-2 rounded-full transition-all",
                "text-[var(--text-secondary)] hover:text-white"
            )}
            title="toggle activity panel"
            aria-label="Toggle activity panel"
        >
            <Bell className="w-5 h-5" />
            {hasActivity && (
                <span className="absolute top-1.5 right-2 w-1 h-1 rounded-full bg-brand" />
            )}
        </button>
    );
}
