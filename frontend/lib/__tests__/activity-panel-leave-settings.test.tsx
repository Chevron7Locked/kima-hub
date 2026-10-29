/**
 * Leaving a page's settings in the activity panel (the lyrics' or Discover's "back") returns to the tab the panel was
 * on before them, never to the downloads list.
 */
import { describe, it, expect } from "vitest";
import React, { act, useEffect } from "react";
import {
    leaveActivityPanelSettings,
    setActivityPanelTab,
    useActivityPanel,
    type ActivityPanelTab,
} from "@/hooks/useActivityPanel";
import { mountHost } from "./helpers/dom";

const dom = mountHost();

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

const shown = () => dom.host.querySelector("output")?.textContent;

describe("leaving the panel's settings", () => {
    it("returns to the tab the panel was on before them", () => {
        act(() => dom.root.render(<Layout />));
        act(() => setActivityPanelTab("history"));
        act(() => setActivityPanelTab("settings"));
        expect(shown()).toBe("settings");

        act(() => leaveActivityPanelSettings());
        expect(shown()).toBe("history");
    });

    it("does nothing when settings are not showing", () => {
        act(() => dom.root.render(<Layout />));
        act(() => setActivityPanelTab("imports"));
        act(() => leaveActivityPanelSettings());
        expect(shown()).toBe("imports");
    });

    it("keeps the downloads when they were showing before the settings", () => {
        act(() => dom.root.render(<Layout />));
        act(() => setActivityPanelTab("downloads"));
        act(() => setActivityPanelTab("settings"));
        act(() => leaveActivityPanelSettings());
        expect(shown()).toBe("downloads");
    });
});
