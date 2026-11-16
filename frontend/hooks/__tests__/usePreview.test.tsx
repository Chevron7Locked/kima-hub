/**
 * The one song preview: one at a time, the main player paused while it plays and resumed when it stops,
 * ends or fails, never when another preview takes its place.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controller = {
    isPlaying: vi.fn(() => true),
    pause: vi.fn(),
    play: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
};
vi.mock("@/lib/audio-controller-context", () => ({ useAudioController: () => controller }));
vi.mock("@/lib/audio-state-context", () => ({ useVolumeState: () => ({ volume: 0.5, isMuted: false }) }));
const info = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: { info: (...a: unknown[]) => info(...a), error: vi.fn() } }));

class FakeAudio {
    static made: FakeAudio[] = [];
    static refuse = false;
    volume = 1;
    src: string;
    paused = true;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(src: string) {
        this.src = src;
        FakeAudio.made.push(this);
    }
    play() {
        if (FakeAudio.refuse) return Promise.reject(new Error("NotAllowedError"));
        this.paused = false;
        return Promise.resolve();
    }
    pause() {
        this.paused = true;
    }
    load() {}
}

import { usePreview } from "../usePreview";

type Preview = ReturnType<typeof usePreview>;
let preview: Preview;
let root: ReturnType<typeof createRoot>;

function Probe({ onRender }: { onRender: (p: Preview) => void }) {
    onRender(usePreview());
    return null;
}

beforeEach(async () => {
    vi.clearAllMocks();
    FakeAudio.made = [];
    FakeAudio.refuse = false;
    vi.stubGlobal("Audio", FakeAudio);
    root = createRoot(document.createElement("div"));
    await act(async () =>
        root.render(
            createElement(Probe, {
                onRender: (p: Preview) => {
                    preview = p;
                },
            }),
        ),
    );
});

afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
});

describe("usePreview", () => {
    it("pauses the main player while a preview plays and resumes it when the preview ends", async () => {
        await act(async () => preview.toggle("a", "/a"));
        expect(controller.pause).toHaveBeenCalledTimes(1);
        expect(preview.previewId).toBe("a");
        expect(preview.playing).toBe(true);
        expect(FakeAudio.made[0].volume).toBe(0.5);

        await act(async () => FakeAudio.made[0].onended?.());
        expect(controller.play).toHaveBeenCalledTimes(1);
        expect(preview.previewId).toBeNull();
    });

    it("keeps the main player paused when another preview takes over, and resumes it on stop", async () => {
        await act(async () => preview.toggle("a", "/a"));
        await act(async () => preview.toggle("b", "/b"));
        expect(FakeAudio.made[0].paused).toBe(true);
        expect(controller.play).not.toHaveBeenCalled();
        expect(preview.previewId).toBe("b");

        await act(async () => preview.stop());
        expect(controller.play).toHaveBeenCalledTimes(1);
    });

    it("a second click on the playing preview stops it and resumes the main player", async () => {
        await act(async () => preview.toggle("a", "/a"));
        await act(async () => preview.toggle("a", "/a"));
        expect(preview.previewId).toBeNull();
        expect(controller.play).toHaveBeenCalledTimes(1);
    });

    it("a preview that cannot play resumes the main player and is not asked again", async () => {
        FakeAudio.refuse = true;
        await act(async () => preview.toggle("a", "/a"));
        expect(controller.play).toHaveBeenCalledTimes(1);
        expect(preview.previewId).toBeNull();
        expect(info).toHaveBeenCalledTimes(1);

        await act(async () => preview.toggle("a", "/a"));
        expect(FakeAudio.made).toHaveLength(1);
    });
});
