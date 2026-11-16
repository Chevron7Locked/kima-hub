/**
 * Playing another row of the queue panel jumps within the queue as it is: same entries, same shuffle order, and so the
 * same page the queue came from (the album's big play button still says pause or resume, it does not start over). The
 * audio contexts are stubbed.
 */
import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";

const { queue, playTracks, playQueueIndex } = vi.hoisted(() => ({
    queue: Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, title: `Track ${i}`, duration: 180 })),
    playTracks: vi.fn(),
    playQueueIndex: vi.fn(),
}));
vi.mock("@/lib/audio-state-context", () => ({
    useCurrentMedia: () => ({ currentTrack: queue[0] }),
    useQueueState: () => ({ queue, currentIndex: 0 }),
    useActiveOperation: () => ({ type: "none" }),
    useAudioSetters: () => ({ setQueue: () => {} }),
}));
vi.mock("@/lib/audio-controls-context", () => ({
    useAudioControls: () => ({
        playTracks,
        playQueueIndex,
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
HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 800, width: 320, height: 800, toJSON() {} } as DOMRect;
};
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 320 });

const dom = mountHost();

const pressRow = async () => {
    await act(async () => dom.root.render(<QueueTab />));
    const button = dom.host.querySelector<HTMLButtonElement>('[data-queue-row] button[aria-label="play Track 2"]')!;
    await act(async () => button.click());
};

describe("playing a row of the queue panel", () => {
    it("jumps to that place in the queue, without replacing the queue", async () => {
        playTracks.mockClear();
        playQueueIndex.mockClear();
        await pressRow();
        expect(playQueueIndex).toHaveBeenCalledWith(2);
        expect(playTracks).not.toHaveBeenCalled();
    });
});
