"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";

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

    // The current value, readable without going through a state updater.
    //
    // These three actions announce themselves on the window, because TopBar and
    // ActivityPanel both listen in order to keep their aria-expanded in step.
    // That announcement used to happen INSIDE the setIsOpen updater, and a
    // state updater has to be a pure function of its argument. React's Strict
    // Mode deliberately runs updaters twice to catch exactly that, so toggle()
    // computed !prev twice -- false to true, then straight back to false -- and
    // the panel could not be opened from its button at all. open() and close()
    // survived only because they ignore prev and return a constant.
    //
    // Reading from a ref instead keeps the updater pure and the announcement
    // outside it, where a side effect is allowed to live.
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
        toggle,
        open,
        close,
    }), [isOpen, activeTab, setActiveTab, toggle, open, close]);
}
