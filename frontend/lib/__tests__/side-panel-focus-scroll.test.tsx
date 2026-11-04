/**
 * Opening or closing the desktop side panel moves keyboard focus without scrolling anything. Closed, the panel sits
 * slid past the screen's edge inside a clipped row; a plain focus() on its hide button scrolled that row sideways to
 * reveal the button, which threw the whole page left for a frame as the panel opened.
 */
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useState } from "react";

vi.mock("@/hooks/useNotifications", () => ({
    useNotifications: () => ({ unreadCount: 0 }),
    useActiveDownloads: () => ({ downloads: [] }),
}));
vi.mock("@/lib/audio-state-context", () => ({ useAudioState: () => ({ queue: [], currentIndex: 0 }) }));
vi.mock("@/components/activity/ActivityBody", () => ({
    ActivityOptions: () => null,
    ActivityPane: () => null,
    isActivityView: () => false,
    useActivityCounts: () => ({ unread: 0, downloads: 0, any: false }),
}));
vi.mock("@/features/vibe/tabs/QueueTab", () => ({ QueueTab: () => null }));
vi.mock("@/features/vibe/tabs/NowPlayingTab", () => ({ ArtistAbout: () => null, NowPlayingHero: () => null }));
vi.mock("@/components/lyrics/LyricsView", () => ({ LyricsView: () => null }));

import { UnifiedPanel } from "@/components/layout/UnifiedPanel";
import { ActivityPanelSettingsProvider } from "@/lib/activity-panel-settings-context";

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
    vi.restoreAllMocks();
});

function App() {
    const [open, setOpen] = useState(false);
    return (
        <ActivityPanelSettingsProvider>
            <UnifiedPanel isOpen={open} onToggle={() => setOpen((o) => !o)} />
        </ActivityPanelSettingsProvider>
    );
}

it("moves focus on open and close without scrolling it into view", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    act(() => root.render(<App />));
    const handle = host.querySelector<HTMLButtonElement>('button[aria-label="open panel"]')!;
    act(() => handle.click());
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="hide panel"]')!.click());

    const moves = focus.mock.calls;
    expect(moves.length).toBeGreaterThanOrEqual(2);
    for (const [options] of moves) expect(options).toEqual({ preventScroll: true });
});
