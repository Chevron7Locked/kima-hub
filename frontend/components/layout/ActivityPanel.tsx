"use client";

import { useState, useEffect, useCallback } from "react";
import { Bell, X } from "lucide-react";
import { ActivityOptions, ActivityPane, useActivityCounts } from "@/components/activity/ActivityBody";
import { panelTabId } from "./panelChrome";
import { cn } from "@/lib/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { useActivityPanelSettings } from "@/lib/activity-panel-settings-context";
import { useActivityPanelOpen, type ActivityPanelTab } from "@/hooks/useActivityPanel";

interface ActivityPanelProps {
    isOpen: boolean;
    onToggle: () => void;
    activeTab?: ActivityPanelTab;
    onTabChange?: (tab: ActivityPanelTab) => void;
}

/** The phone and tablet activity overlay; the desktop layout shows the side panel (UnifiedPanel) instead. */
export function ActivityPanel({
    isOpen,
    onToggle,
    activeTab,
    onTabChange,
}: ActivityPanelProps) {
    const { settingsContent, setSettingsContent } = useActivityPanelSettings();
    const [internalActiveTab, setInternalActiveTab] =
        useState<ActivityPanelTab>("notifications");
    const resolvedActiveTab = activeTab ?? internalActiveTab;
    const setResolvedActiveTab = onTabChange ?? setInternalActiveTab;

    const handleTabClick = useCallback((tab: ActivityPanelTab) => {
        if (tab !== "settings" && resolvedActiveTab === "settings" && settingsContent) {
            setSettingsContent(null);
        }
        setResolvedActiveTab(tab);
    }, [resolvedActiveTab, settingsContent, setSettingsContent, setResolvedActiveTab]);

    // The settings tab with no page settings to show falls back to the alerts.
    useEffect(() => {
        if (resolvedActiveTab === "settings" && !settingsContent) {
            setResolvedActiveTab("notifications");
        }
    }, [resolvedActiveTab, settingsContent, setResolvedActiveTab]);

    if (!isOpen) return null;

    return (
        <>
            <div
                className="fixed inset-0 bg-black/60 z-(--z-panel-backdrop)"
                onClick={onToggle}
            />

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

                <ActivityOptions
                    controls="activity-sheet-content"
                    value={resolvedActiveTab === "settings" ? null : resolvedActiveTab}
                    onChange={handleTabClick}
                />

                {/* A page's settings are not one of the tabs: while they show, no tab is chosen and the region is named for them. */}
                <div
                    id="activity-sheet-content"
                    {...(resolvedActiveTab === "settings"
                        ? { role: "region", "aria-label": "settings" }
                        : { role: "tabpanel", "aria-labelledby": panelTabId("activity-sheet-content", resolvedActiveTab) })}
                    className={cn("flex-1", resolvedActiveTab === "settings" ? "overflow-hidden" : "overflow-y-auto")}
                >
                    {resolvedActiveTab === "settings" ? (
                        settingsContent
                    ) : (
                        <ActivityPane view={resolvedActiveTab} onOpen={handleTabClick} />
                    )}
                </div>
            </div>
        </>
    );
}

/** The top bar's activity button, with a dot while there are unread alerts or running downloads. */
export function ActivityPanelToggle() {
    const { any: hasActivity } = useActivityCounts();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isPanelOpen = useActivityPanelOpen();
    const overlay = isMobile || isTablet;

    return (
        <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("toggle-activity-panel"))}
            aria-expanded={isPanelOpen}
            aria-controls={overlay ? "activity-panel-mobile" : "activity-panel"}
            className={cn(
                "relative flex shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors duration-200 hover:text-white",
                overlay ? "ml-2 h-11 w-11" : "p-2",
            )}
            title="activity"
            aria-label="Toggle activity panel"
        >
            <Bell className="w-5 h-5" />
            {hasActivity && (
                <span aria-hidden="true" className={cn("absolute w-1 h-1 rounded-full bg-brand", overlay ? "top-2.5 right-3" : "top-1.5 right-2")} />
            )}
        </button>
    );
}
