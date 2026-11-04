/**
 * The desktop side panel itself: a page's settings take it whole, the settings' "back" brings the panel's tabs back on
 * the activity tab that was showing, and closing or opening the panel moves keyboard focus to the control that undoes
 * it. The panel's data hooks and its content views are stubbed; the panel, its option strips and the settings context
 * are the real ones.
 */
import { describe, it, expect, vi } from "vitest";
import React, { act, useState } from "react";

vi.mock("@/hooks/useNotifications", () => ({
    useNotifications: () => ({ unreadCount: 0 }),
    useActiveDownloads: () => ({ downloads: [] }),
}));
vi.mock("@/lib/audio-state-context", () => ({ useAudioState: () => ({ queue: [], currentIndex: 0 }) }));
const { list } = vi.hoisted(() => ({
    list: (name: string) => () => <div data-testid="activity-content">{name}</div>,
}));
vi.mock("@/components/activity/NotificationsTab", () => ({ NotificationsTab: list("notifications") }));
vi.mock("@/components/activity/ActiveDownloadsTab", () => ({ ActiveDownloadsTab: list("downloads") }));
vi.mock("@/components/activity/ImportsTab", () => ({ ImportsTab: list("imports") }));
vi.mock("@/components/activity/HistoryTab", () => ({ HistoryTab: list("history") }));
vi.mock("@/features/vibe/tabs/QueueTab", () => ({ QueueTab: () => <div>queue</div> }));
vi.mock("@/features/vibe/tabs/NowPlayingTab", () => ({ ArtistAbout: () => null, NowPlayingHero: () => null }));
vi.mock("@/components/lyrics/LyricsView", () => ({ LyricsView: () => null }));
vi.mock("@/components/activity/ActivityFeed", () => ({ ActivityFeed: () => <div>feed</div> }));

import { UnifiedPanel } from "@/components/layout/UnifiedPanel";
import { ActivityPanelSettingsProvider, useActivityPanelSettings } from "@/lib/activity-panel-settings-context";
import { leaveActivityPanelSettings, setActivityPanelTab } from "@/hooks/useActivityPanel";
import { mountHost } from "./helpers/dom";

const dom = mountHost();

/** A page that puts its settings in the panel, as the lyrics toggle does. */
function PageWithSettings() {
    const { setSettingsContent } = useActivityPanelSettings();
    return (
        <button
            type="button"
            data-testid="open-settings"
            onClick={() => {
                setSettingsContent(<p data-testid="page-settings">settings</p>, "lyrics");
                setActivityPanelTab("settings");
            }}
        />
    );
}

function App() {
    const [open, setOpen] = useState(true);
    return (
        <ActivityPanelSettingsProvider>
            <PageWithSettings />
            <UnifiedPanel isOpen={open} onToggle={() => setOpen((o) => !o)} />
        </ActivityPanelSettingsProvider>
    );
}

const q = (selector: string) => dom.host.querySelector<HTMLElement>(selector);
const activityTab = (name: string) =>
    [...dom.host.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="activity"] [role="tab"]')].find(
        (t) => t.textContent?.trim().startsWith(name),
    )!;

describe("the desktop side panel", () => {
    it("comes back from a page's settings on the activity tab that was showing", () => {
        act(() => dom.root.render(<App />));
        act(() => q('[role="tablist"][aria-label="panel"] [data-tab-key="activity"]')!.click());
        act(() => activityTab("history").click());
        expect(q('[data-testid="activity-content"]')?.textContent).toBe("history");

        act(() => q('[data-testid="open-settings"]')!.click());
        expect(q('[data-testid="page-settings"]')).not.toBeNull();
        expect(q('[role="tablist"][aria-label="activity"]')).toBeNull();

        act(() => leaveActivityPanelSettings());
        expect(q('[data-testid="page-settings"]')).toBeNull();
        expect(activityTab("history").getAttribute("aria-selected")).toBe("true");
        expect(q('[data-testid="activity-content"]')?.textContent).toBe("history");
    });

    it("moves focus to the handle when it closes and to the hide button when it opens", () => {
        act(() => dom.root.render(<App />));
        const hide = q('button[aria-label="hide panel"]')!;
        act(() => hide.focus());
        act(() => hide.click());
        expect(document.activeElement?.getAttribute("aria-label")).toBe("open panel");

        act(() => (document.activeElement as HTMLElement).click());
        expect(document.activeElement?.getAttribute("aria-label")).toBe("hide panel");
    });
});
