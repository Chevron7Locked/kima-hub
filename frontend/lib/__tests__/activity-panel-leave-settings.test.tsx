/**
 * Leaving a page's settings in the activity panel (the lyrics' or Discover's "back") returns to the tab the panel was
 * on before them, never to the downloads list.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";
import {
    leaveActivityPanelSettings,
    setActivityPanelTab,
    useActivityPanel,
    type ActivityPanelTab,
} from "@/hooks/useActivityPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

/** The layout's wiring, as AuthenticatedLayout does it. */
function Layout() {
    const panel = useActivityPanel();
    const { setActiveTab, leaveSettings } = panel;
    useEffect(() => {
        const onTab = (e: Event) => setActiveTab((e as CustomEvent<{ tab: ActivityPanelTab }>).detail.tab);
        window.addEventListener("set-activity-panel-tab", onTab);
        window.addEventListener("leave-activity-panel-settings", leaveSettings);
        return () => {
            window.removeEventListener("set-activity-panel-tab", onTab);
            window.removeEventListener("leave-activity-panel-settings", leaveSettings);
        };
    }, [setActiveTab, leaveSettings]);
    return <output>{panel.activeTab}</output>;
}

const shown = () => host.querySelector("output")?.textContent;

describe("leaving the panel's settings", () => {
    it("returns to the tab the panel was on before them", () => {
        act(() => root.render(<Layout />));
        act(() => setActivityPanelTab("history"));
        act(() => setActivityPanelTab("settings"));
        expect(shown()).toBe("settings");

        act(() => leaveActivityPanelSettings());
        expect(shown()).toBe("history");
    });

    it("does nothing when settings are not showing", () => {
        act(() => root.render(<Layout />));
        act(() => setActivityPanelTab("imports"));
        act(() => leaveActivityPanelSettings());
        expect(shown()).toBe("imports");
    });

    it("keeps the downloads when they were showing before the settings", () => {
        act(() => root.render(<Layout />));
        act(() => setActivityPanelTab("active"));
        act(() => setActivityPanelTab("settings"));
        act(() => leaveActivityPanelSettings());
        expect(shown()).toBe("active");
    });
});
