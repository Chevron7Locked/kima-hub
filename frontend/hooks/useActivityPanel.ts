"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

const ACTIVITY_PANEL_KEY = "kima_activity_panel_open";

export function useActivityPanel() {
    const [isOpen, setIsOpen] = useState(() => {
        if (typeof window === "undefined") return false;
        return localStorage.getItem(ACTIVITY_PANEL_KEY) === "true";
    });
    const [activeTab, setActiveTab] = useState<"notifications" | "active" | "imports" | "history" | "settings">("notifications");

    // Persist state to localStorage
    useEffect(() => {
        if (typeof window !== "undefined") {
            localStorage.setItem(ACTIVITY_PANEL_KEY, isOpen ? "true" : "false");
        }
    }, [isOpen]);

    const toggle = useCallback(() => {
        setIsOpen((prev) => {
            const next = !prev;
            window.dispatchEvent(
                new CustomEvent(next ? "open-activity-panel" : "close-activity-panel")
            );
            return next;
        });
    }, []);

    const open = useCallback(() => {
        setIsOpen((prev) => {
            if (!prev) {
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
            }
            return true;
        });
    }, []);

    const close = useCallback(() => {
        setIsOpen((prev) => {
            if (prev) {
                window.dispatchEvent(new CustomEvent("close-activity-panel"));
            }
            return false;
        });
    }, []);

    return useMemo(() => ({
        isOpen,
        activeTab,
        setActiveTab,
        toggle,
        open,
        close,
    }), [isOpen, activeTab, setActiveTab, toggle, open, close]);
}
