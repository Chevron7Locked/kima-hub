/**
 * The top bar's bell, through real clicks: a closed panel is asked for the activity tab and then opened; an open one is
 * simply toggled shut. The counts and the media-query hooks are stand-ins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("@/components/activity/ActivityBody", () => ({
    ActivityOptions: () => null,
    ActivityPane: () => null,
    useActivityCounts: () => ({ unread: 0, downloads: 0, any: false }),
}));
vi.mock("@/hooks/useMediaQuery", () => ({ useIsMobile: () => false, useIsTablet: () => false }));

import { ActivityPanelToggle } from "@/components/layout/ActivityPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const EVENTS = ["set-activity-panel-tab", "open-activity-panel", "toggle-activity-panel"];
let root: Root;
let host: HTMLDivElement;
let seen: string[];
const record = (e: Event) => seen.push(`${e.type}:${JSON.stringify((e as CustomEvent).detail ?? null)}`);

beforeEach(() => {
    localStorage.clear();
    seen = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    for (const n of EVENTS) window.addEventListener(n, record);
});
afterEach(async () => {
    for (const n of EVENTS) window.removeEventListener(n, record);
    await act(async () => root.unmount());
    host.remove();
});

describe("the bell", () => {
    it("asks a closed panel for the activity tab, then opens it", async () => {
        await act(async () => root.render(<ActivityPanelToggle />));
        await act(async () => host.querySelector("button")!.click());
        expect(seen).toEqual(['set-activity-panel-tab:{"tab":"all"}', "open-activity-panel:null"]);
    });

    it("toggles an open panel shut", async () => {
        localStorage.setItem("kima_activity_panel_open", "true");
        await act(async () => root.render(<ActivityPanelToggle />));
        await act(async () => host.querySelector("button")!.click());
        expect(seen).toEqual(["toggle-activity-panel:null"]);
    });
});
