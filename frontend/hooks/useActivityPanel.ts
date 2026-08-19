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
    // That announcement used to happen INSIDE the setIsOpen updater, which is
    // the bug: a state updater must be a pure function of its argument, and
    // this one fired a synchronous window event. AuthenticatedLayout listens
    // for that very event and calls open() or close() in response, so toggle()
    // re-entered this hook while React was still mid-update.
    //
    // The observable symptom was that the panel could not be opened from its
    // button at all, while dispatching "open-activity-panel" directly did work
    // -- open() and close() ignore prev and return a constant, so re-entering
    // them is harmless. That asymmetry is what identified the updater as the
    // culprit. The precise interleaving that produced a net "stays closed" was
    // not pinned down, and this comment does not guess at one.
    //
    // Reading the current value from a ref keeps the updater pure and moves the
    // announcement outside it, where a side effect is allowed to live. The
    // early return in open()/close() is load-bearing, not tidiness: it is what
    // stops the listener feeding an event straight back into the hook.
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
