"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";

const ACTIVITY_PANEL_KEY = "kima_activity_panel_open";

export type ActivityPanelTab = "all" | "notifications" | "active" | "imports" | "history" | "settings";

export function setActivityPanelTab(tab: ActivityPanelTab) {
    window.dispatchEvent(new CustomEvent("set-activity-panel-tab", { detail: { tab } }));
}

/**
 * Leaves the settings a page put in the panel (Discover's, the lyrics'), back to what the panel showed before them.
 * Not a tab: "active" means "show the downloads", which is right after starting one and wrong after "back".
 */
export function leaveActivityPanelSettings() {
    window.dispatchEvent(new CustomEvent("leave-activity-panel-settings"));
}

/** Opens the activity panel, on `tab` when one is given. */
export function openActivityPanel(tab?: ActivityPanelTab) {
    if (tab) setActivityPanelTab(tab);
    window.dispatchEvent(new CustomEvent("open-activity-panel"));
}

/** Follows the panel's open state from the window events, for controls that only show it. */
export function useActivityPanelOpen(): boolean {
    const [isOpen, setIsOpen] = useState(() => {
        if (typeof window === "undefined") return false;
        return localStorage.getItem(ACTIVITY_PANEL_KEY) === "true";
    });

    useEffect(() => {
        const handleToggle = () => setIsOpen((prev) => !prev);
        const handleOpen = () => setIsOpen(true);
        const handleClose = () => setIsOpen(false);
        window.addEventListener("toggle-activity-panel", handleToggle);
        window.addEventListener("open-activity-panel", handleOpen);
        window.addEventListener("close-activity-panel", handleClose);
        return () => {
            window.removeEventListener("toggle-activity-panel", handleToggle);
            window.removeEventListener("open-activity-panel", handleOpen);
            window.removeEventListener("close-activity-panel", handleClose);
        };
    }, []);

    return isOpen;
}

export function useActivityPanel() {
    const [isOpen, setIsOpen] = useState(() => {
        if (typeof window === "undefined") return false;
        return localStorage.getItem(ACTIVITY_PANEL_KEY) === "true";
    });
    const [activeTab, setActiveTabState] = useState<ActivityPanelTab>("all");
    // The tab shown before settings took the panel, for leaving them. Kept beside the state so a quick open and
    // close in one render still reads the tab the panel was really on.
    const activeTabRef = useRef<ActivityPanelTab>("all");
    const beforeSettings = useRef<ActivityPanelTab>("all");
    const setActiveTab = useCallback((tab: ActivityPanelTab) => {
        if (tab === "settings" && activeTabRef.current !== "settings") beforeSettings.current = activeTabRef.current;
        activeTabRef.current = tab;
        setActiveTabState(tab);
    }, []);
    const leaveSettings = useCallback(() => {
        if (activeTabRef.current === "settings") setActiveTab(beforeSettings.current);
    }, [setActiveTab]);

    useEffect(() => {
        if (typeof window !== "undefined") {
            localStorage.setItem(ACTIVITY_PANEL_KEY, isOpen ? "true" : "false");
        }
    }, [isOpen]);

    // The actions announce themselves on the window so TopBar and ActivityPanel
    // keep aria-expanded in step, and AuthenticatedLayout reacts to that event.
    // The announcement must stay outside any state updater; reading the current
    // value from this ref, plus the early return in open()/close(), prevents re-entry.
    const isOpenRef = useRef(isOpen);
    useEffect(() => {
        isOpenRef.current = isOpen;
    }, [isOpen]);

    const announce = (next: boolean) => {
        window.dispatchEvent(
            new CustomEvent(next ? "open-activity-panel" : "close-activity-panel")
        );
    };

    const toggle = useCallback(() => {
        const next = !isOpenRef.current;
        isOpenRef.current = next;
        setIsOpen(next);
        announce(next);
    }, []);

    const open = useCallback(() => {
        if (isOpenRef.current) return;
        isOpenRef.current = true;
        setIsOpen(true);
        announce(true);
    }, []);

    const close = useCallback(() => {
        if (!isOpenRef.current) return;
        isOpenRef.current = false;
        setIsOpen(false);
        announce(false);
    }, []);

    return useMemo(() => ({
        isOpen,
        activeTab,
        setActiveTab,
        leaveSettings,
        toggle,
        open,
        close,
    }), [isOpen, activeTab, setActiveTab, leaveSettings, toggle, open, close]);
}
