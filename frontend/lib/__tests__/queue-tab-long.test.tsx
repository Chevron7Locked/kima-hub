/**
 * The queue list draws the rows in view, not the whole queue: a queue may hold 10,000 songs (the default limit), and
 * drawing every row put about 230,000 elements on every page while the panel was open. The audio contexts are stubbed;
 * the list is the real one.
 */
import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";

const { queue } = vi.hoisted(() => ({
    queue: Array.from({ length: 10_000 }, (_, i) => ({ id: `t${i}`, title: `Track ${i}`, duration: 180 })),
}));
vi.mock("@/lib/audio-state-context", () => ({
    useAudioState: () => ({
        currentTrack: queue[0],
        queue,
        currentIndex: 0,
        activeOperation: { type: "none" },
        setQueue: () => {},
    }),
}));
vi.mock("@/lib/audio-controls-context", () => ({
    useAudioControls: () => ({
        playTracks: () => {},
        pause: () => {},
        resumeWithGesture: () => {},
        removeFromQueue: () => {},
        clearQueue: () => {},
    }),
}));
vi.mock("@/lib/audio-playback-context", () => ({ useAudioPlayback: () => ({ isPlaying: false }) }));

import { QueueTab } from "@/features/vibe/tabs/QueueTab";
import { mountHost } from "./helpers/dom";

globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

// happy-dom lays nothing out, so the list's scroll area is given the height a panel has.
HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 800, width: 320, height: 800, toJSON() {} } as DOMRect;
};
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 320 });

const dom = mountHost();

describe("a long queue", () => {
    it("draws only the rows in view, starting with the next song", () => {
        act(() => dom.root.render(<QueueTab />));
        const rows = dom.host.querySelectorAll("[data-queue-row]");
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.length).toBeLessThan(100);
        expect(rows[0].querySelector("button")?.getAttribute("aria-label")).toBe("play Track 1");
        expect(dom.host.querySelector("[data-queue-count]")?.textContent).toBe("10000 tracks in the queue");
    });
});
