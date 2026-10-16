/**
 * Back on a TV remote (Escape), through the real TV layout and real key events: from the page it returns the focus to
 * the tab row, but a key something on the page used first (an open sleep timer, a window or menu marking it handled)
 * is left to it, wherever that thing's listener sits relative to the layout's own, including one added after it.
 * The router, player and API are stand-ins; nothing is playing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({
    default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock("@/lib/tv-utils", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tv-utils")>()), useIsTV: () => true }));
vi.mock("@/lib/audio-context", () => ({
    useAudio: () => ({
        currentTrack: null, currentAudiobook: null, currentPodcast: null, playbackType: null, isPlaying: false,
        pause: vi.fn(), resumeWithGesture: vi.fn(), currentTime: 0, duration: 0, next: vi.fn(), previous: vi.fn(),
        isShuffle: false, toggleShuffle: vi.fn(), repeatMode: "off", toggleRepeat: vi.fn(), seek: vi.fn(),
    }),
}));
vi.mock("@/lib/api", () => ({ api: { getCoverArtUrl: () => "", scanLibrary: vi.fn() } }));
vi.mock("@/hooks/useSleepTimer", () => ({
    useSleepTimer: () => ({ isActive: false, remainingSeconds: 0, displayRemaining: "", setTimer: vi.fn(), clearTimer: vi.fn() }),
}));

import { TVLayout } from "@/components/layout/TVLayout";
import { SleepTimer } from "@/components/player/SleepTimer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

/** A key as the remote sends it: dispatched on whatever has the focus, bubbling up to the window. */
const press = async (key: string) => {
    await act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    // Let every listener and anything they scheduled run.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
};
const onTabRow = () => document.activeElement?.hasAttribute("data-tv-tab") ?? false;

beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
        root.render(
            <TVLayout>
                <section data-tv-section="true">
                    <a href="#album" data-tv-card="true">album</a>
                </section>
                <SleepTimer />
            </TVLayout>,
        ),
    );
    // Down from the tab row into the page, as the remote does; then the focus falls off (a card opened a page).
    await press("ArrowDown");
    expect(onTabRow()).toBe(false);
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe("Back on the TV layout", () => {
    it("returns the focus to the tab row from a page with nothing focused", async () => {
        await press("Escape");
        expect(onTabRow()).toBe(true);
    });

    it("closes an open sleep timer and leaves the focus where it is", async () => {
        const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
        await act(async () => trigger.click());
        expect(trigger.getAttribute("aria-expanded")).toBe("true");

        await press("Escape");

        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(onTabRow(), "Back also moved the focus while closing the timer").toBe(false);
    });

    it("leaves a key alone that a window listener added after the layout's own used", async () => {
        const usedByWindow = (e: KeyboardEvent) => e.key === "Escape" && e.preventDefault();
        window.addEventListener("keydown", usedByWindow);
        try {
            await press("Escape");
        } finally {
            window.removeEventListener("keydown", usedByWindow);
        }
        expect(onTabRow(), "Back acted on a key something else had used").toBe(false);
    });
});
