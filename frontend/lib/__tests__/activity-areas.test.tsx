/**
 * Every activity area answers to the same names and shows the same options: the desktop panel and the phone overlay
 * open on "downloads" when the app asks for it, and the vibe page's phone sheet switches activity with the panels'
 * text options, not an icon row. The lists themselves are stubbed; the panels and option strips are the real ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("@/hooks/useNotifications", () => ({
    useNotifications: () => ({ unreadCount: 2 }),
    useActiveDownloads: () => ({ downloads: [{ id: "d1" }] }),
}));
vi.mock("@/lib/audio-state-context", () => ({ useAudioState: () => ({ queue: [], currentIndex: 0 }) }));
const { list } = vi.hoisted(() => ({
    list: (name: string) => () => <div data-testid="activity-content">{name}</div>,
}));
vi.mock("@/components/activity/NotificationsTab", () => ({ NotificationsTab: list("notifications") }));
vi.mock("@/components/activity/ActiveDownloadsTab", () => ({ ActiveDownloadsTab: list("downloads") }));
vi.mock("@/components/activity/ImportsTab", () => ({ ImportsTab: list("imports") }));
vi.mock("@/components/activity/HistoryTab", () => ({ HistoryTab: list("history") }));
vi.mock("@/components/activity/ActivityFeed", () => ({ ActivityFeed: list("all") }));
vi.mock("@/features/vibe/tabs/QueueTab", () => ({ QueueTab: () => <div>queue</div> }));
vi.mock("@/features/vibe/tabs/NowPlayingTab", () => ({
    ArtistAbout: () => null,
    NowPlayingStrip: () => null,
    NowPlayingTab: () => <div>now playing</div>,
}));
vi.mock("@/components/lyrics/LyricsView", () => ({ LyricsView: () => null }));
vi.mock("@/hooks/useMediaQuery", () => ({ useIsMobile: () => true, useIsTablet: () => false }));
vi.mock("@/hooks/usePlayerControls", () => ({
    usePlayerControls: () => ({ playbackType: null, isPlaying: false, pause: () => {}, resumeWithGesture: () => {}, setPlayerMode: () => {} }),
}));
vi.mock("@/hooks/useMediaInfo", () => ({ useMediaInfo: () => ({ title: "", subtitle: "", coverUrl: null }) }));

import { UnifiedPanel } from "@/components/layout/UnifiedPanel";
import { ActivityPanel } from "@/components/layout/ActivityPanel";
import { VibePanelSheet } from "@/features/vibe/VibePanelSheet";
import { ActivityPanelSettingsProvider } from "@/lib/activity-panel-settings-context";
import { setActivityPanelTab } from "@/hooks/useActivityPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

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

const shown = () => host.querySelector('[data-testid="activity-content"]')?.textContent;
const tabs = (list: string) =>
    [...host.querySelectorAll<HTMLElement>(`[role="tablist"][aria-label="${list}"] [role="tab"]`)].map((t) => t.textContent?.trim());
const tab = (list: string, name: string) =>
    [...host.querySelectorAll<HTMLElement>(`[role="tablist"][aria-label="${list}"] [role="tab"]`)].find((t) =>
        t.textContent?.trim().startsWith(name),
    )!;

describe("activity areas", () => {
    it("the desktop panel opens on the downloads list when the app asks for downloads", () => {
        act(() =>
            root.render(
                <ActivityPanelSettingsProvider>
                    <UnifiedPanel isOpen onToggle={() => {}} />
                </ActivityPanelSettingsProvider>,
            ),
        );
        act(() => setActivityPanelTab("downloads"));
        expect(tab("activity", "downloads").getAttribute("aria-selected")).toBe("true");
        expect(shown()).toBe("downloads");
    });

    it("the phone overlay shows the downloads list on the downloads tab", () => {
        act(() =>
            root.render(
                <ActivityPanelSettingsProvider>
                    <ActivityPanel isOpen onToggle={() => {}} activeTab="downloads" />
                </ActivityPanelSettingsProvider>,
            ),
        );
        expect(tab("activity", "downloads").getAttribute("aria-selected")).toBe("true");
        expect(shown()).toBe("downloads");
    });

    it("the vibe sheet switches activity with the panels' options, counts and all", () => {
        act(() =>
            root.render(
                <VibePanelSheet onSearch={() => {}} results={null} onPickResult={() => {}} clearSignal={0} />,
            ),
        );
        expect(host.querySelector("[aria-pressed]")).toBeNull();
        act(() => tab("vibe panel", "activity").click());
        expect(tabs("activity")).toEqual(["all", "alerts2", "downloads1", "imports", "history"]);
        act(() => tab("activity", "downloads").click());
        expect(shown()).toBe("downloads");
    });
});
