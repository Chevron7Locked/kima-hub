/**
 * The right-hand panel's two top tabs, through the real panel and real key and click events: listening is chosen on
 * every opening and has the whole panel, activity swaps it out, and the arrow keys switch. The song, queue, lyrics and
 * notification lists are stand-ins; the tabs, the shared tab row and the panel are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const audio = vi.hoisted(() => ({ queue: [], currentIndex: 0, currentTrack: { id: "t1" } as { id: string } | null }));

vi.mock("@/lib/activity-panel-settings-context", () => ({ useActivityPanelSettings: () => ({ settingsContent: null }) }));
vi.mock("@/lib/audio-state-context", () => ({ useAudioState: () => audio }));
vi.mock("@/features/vibe/tabs/QueueTab", () => ({ QueueTab: () => <div data-testid="queue">queue</div> }));
vi.mock("@/features/vibe/tabs/NowPlayingTab", () => ({
    NowPlayingHero: () => <div data-testid="strip" />,
    ArtistAbout: () => <div>about</div>,
}));
vi.mock("@/components/lyrics/LyricsView", () => ({ LyricsView: () => <div>lyrics</div> }));
vi.mock("@/components/activity/ActivityBody", () => ({
    isActivityView: (v: unknown) => v === "all" || v === "notifications",
    useActivityCounts: () => ({ unread: 3, downloads: 1, any: true }),
    ActivityOptions: () => <div data-testid="activity-options" />,
    ActivityPane: () => <div data-testid="notifications">notifications</div>,
}));

import { UnifiedPanel } from "@/components/layout/UnifiedPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

const show = async (isOpen = true) => {
    await act(async () => {
        root.render(<UnifiedPanel isOpen={isOpen} onToggle={() => {}} />);
    });
};
const startSong = async () => {
    audio.currentTrack = { id: "t1" };
    await show();
};
const tab = (name: string) => host.querySelector<HTMLElement>(`[role="tab"][data-tab-key="${name}"]`)!;
const has = (id: string) => !!host.querySelector(`[data-testid="${id}"]`);
const key = async (el: HTMLElement, k: string) => {
    await act(async () => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });
};

beforeEach(() => {
    audio.currentTrack = { id: "t1" };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});

describe("UnifiedPanel tabs", () => {
    it("starts on listening, which shows its content and not the notifications", async () => {
        await show();
        expect(tab("listening").getAttribute("aria-selected")).toBe("true");
        expect(tab("activity").getAttribute("aria-selected")).toBe("false");
        expect(has("queue")).toBe(true);
        expect(host.querySelector('[data-testid="notifications"]')!.closest("[inert]")).not.toBeNull();
    });

    it("opens on activity when nothing is playing, and follows the song when one starts", async () => {
        audio.currentTrack = null;
        await show();
        expect(tab("activity").getAttribute("aria-selected")).toBe("true");
        await startSong();
        expect(tab("listening").getAttribute("aria-selected")).toBe("true");
    });

    it("stays on listening when the song stops", async () => {
        await show();
        audio.currentTrack = null;
        await show();
        expect(tab("listening").getAttribute("aria-selected")).toBe("true");
    });

    it("keeps a choice when a song starts", async () => {
        audio.currentTrack = null;
        await show();
        await act(async () => tab("listening").click());
        await act(async () => tab("activity").click());
        await startSong();
        expect(tab("activity").getAttribute("aria-selected")).toBe("true");
    });

    it("shows unread alerts and downloads as a count on the activity tab", async () => {
        await show();
        expect(tab("activity").textContent).toBe("activity4");
        expect(tab("activity").querySelector("span:last-child")!.textContent).toBe("4");
    });

    it("switching to activity shows the notifications and sets listening aside, mounted and out of the tab order", async () => {
        await show();
        await act(async () => tab("activity").click());
        expect(host.querySelector('[data-testid="notifications"]')!.closest("[inert]")).toBeNull();
        expect(host.querySelector('[data-testid="queue"]')!.closest("[inert]")).not.toBeNull();
        expect(tab("listening").tabIndex).toBe(-1);
        expect(tab("activity").tabIndex).toBe(0);
    });

    it("names the tab panel after the chosen tab", async () => {
        await show();
        const panel = host.querySelector("#panel-main")!;
        expect(panel.getAttribute("aria-labelledby")).toBe(tab("listening").id);
        await act(async () => tab("activity").click());
        expect(panel.getAttribute("aria-labelledby")).toBe(tab("activity").id);
    });

    it("switches with the arrow keys", async () => {
        await show();
        await key(tab("listening"), "ArrowRight");
        expect(tab("activity").getAttribute("aria-selected")).toBe("true");
        await key(tab("activity"), "ArrowLeft");
        expect(tab("listening").getAttribute("aria-selected")).toBe("true");
    });

    const ask = (view: string) =>
        act(async () => {
            window.dispatchEvent(new CustomEvent("set-activity-panel-tab", { detail: { tab: view } }));
        });
    const selected = () => (tab("activity").getAttribute("aria-selected") === "true" ? "activity" : "listening");

    it("a plain reopen starts on listening", async () => {
        await show();
        await act(async () => tab("activity").click());
        await show(false);
        await show(true);
        expect(selected()).toBe("listening");
    });

    it("a request made while closed opens the panel on activity, once", async () => {
        await show(false);
        await ask("all");
        await show(true);
        expect(selected()).toBe("activity");
        await show(false);
        await show(true);
        expect(selected()).toBe("listening");
    });

    it("a request made while open is dropped when it closes, so the next plain open is listening", async () => {
        await show();
        await ask("notifications");
        expect(selected()).toBe("activity");
        await show(false);
        await show(true);
        expect(selected()).toBe("listening");
    });
});
