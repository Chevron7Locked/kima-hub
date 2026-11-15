/**
 * Playing another row of the queue panel replays the same queue, so it keeps the page the queue came from: the album's
 * big play button must still say pause or resume afterwards, not start the album over. The audio contexts are stubbed.
 */
import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";

const { queue, playTracks, source } = vi.hoisted(() => ({
    queue: Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, title: `Track ${i}`, duration: 180 })),
    playTracks: vi.fn(),
    source: { current: "album:a-1" as string | null },
}));
vi.mock("@/lib/audio-state-context", () => ({
    useAudioState: () => ({
        currentTrack: queue[0],
        queue,
        currentIndex: 0,
        currentQueueSource: source.current,
        activeOperation: { type: "none" },
        setQueue: () => {},
    }),
}));
vi.mock("@/lib/audio-controls-context", () => ({
    useAudioControls: () => ({
        playTracks,
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
    it("keeps the source the queue came from", async () => {
        playTracks.mockClear();
        source.current = "album:a-1";
        await pressRow();
        expect(playTracks).toHaveBeenCalledWith(queue, 2, { source: "album:a-1" });
    });

    it("passes no source for a queue that came from nowhere", async () => {
        playTracks.mockClear();
        source.current = null;
        await pressRow();
        expect(playTracks).toHaveBeenCalledWith(queue, 2, undefined);
    });
});
