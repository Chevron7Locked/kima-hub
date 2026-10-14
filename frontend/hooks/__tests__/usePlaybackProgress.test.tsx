/**
 * The player's clock against a podcast whose real audio outruns its feed's length (ads stitched in):
 * the engine's length wins when it has one, and without it the clock keeps running instead of
 * freezing at the feed's number.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const audio = {
    state: {
        playbackType: "podcast",
        currentTrack: null,
        currentAudiobook: null,
        currentPodcast: { duration: 4844, progress: null },
    },
    playback: { currentTime: 0, duration: 0 },
};
vi.mock("@/lib/audio-state-context", () => ({ useAudioState: () => audio.state }));
vi.mock("@/lib/audio-playback-context", () => ({ useAudioPlayback: () => audio.playback }));

import { usePlaybackProgress } from "../usePlaybackProgress";

function Probe() {
    const { duration, displayTime, progress } = usePlaybackProgress();
    return createElement("output", { "data-duration": duration, "data-time": displayTime, "data-progress": progress });
}
const container = document.createElement("div");
const root = createRoot(container);
function read(currentTime: number, engineDuration: number) {
    audio.playback = { currentTime, duration: engineDuration };
    act(() => root.render(createElement(Probe)));
    const out = container.querySelector("output")!;
    return {
        duration: Number(out.dataset.duration),
        displayTime: Number(out.dataset.time),
        progress: Number(out.dataset.progress),
    };
}

afterEach(() => {
    act(() => root.render(null));
});

describe("usePlaybackProgress with a feed length shorter than the audio", () => {
    it("uses the engine's length when it has one", () => {
        const r = read(5000, 5344.7);
        expect(r.duration).toBeCloseTo(5344.7);
        expect(r.displayTime).toBe(5000);
    });

    it("keeps the clock running past the feed's length when the engine has none", () => {
        const r = read(5147, 0);
        expect(r.displayTime).toBe(5147);
        expect(r.duration).toBe(5147);
        expect(r.progress).toBe(100);
    });

    it("uses the feed's length before playback passes it", () => {
        const r = read(2404, 0);
        expect(r.duration).toBe(4844);
        expect(r.displayTime).toBe(2404);
    });
});
