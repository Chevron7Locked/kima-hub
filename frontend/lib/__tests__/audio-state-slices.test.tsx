/**
 * The player's state is read through hooks that each answer one question, so a change to one answer re-renders only the
 * components that asked it: a queue edit leaves the now-playing readers, the volume readers and every play button
 * alone. The hooks run inside the real audio providers; the audio engine is a stand-in that plays nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";

vi.mock("@/lib/api", () => {
    const named: Record<string, unknown> = {
        getQueueLimit: async () => ({ maxQueueLength: 1000 }),
        getPlaybackState: async () => null,
        savePlaybackState: async () => ({}),
        clearPlaybackState: async () => ({}),
        getStreamUrl: (id: string) => `/stream/${id}`,
        getAuthHeader: () => ({}),
        ensureFreshToken: async () => undefined,
        prewarmTrack: async () => undefined,
    };
    const api = new Proxy(named, { get: (target, key: string) => target[key] ?? (async () => null) });
    return { api, getApiBaseUrl: () => "" };
});
vi.mock("@/hooks/usePlayReporting", () => ({ usePlayReporting: () => undefined }));
vi.mock("@/hooks/useLiveReporting", () => ({ upNext: () => [], useLiveReporting: () => undefined }));
vi.mock("@/lib/features-context", () => ({ useFeatures: () => ({ liveReporting: false }) }));

import { AudioControllerContext } from "@/lib/audio-controller-context";
import type { AudioController } from "@/lib/audio-controller";
import {
    AudioStateProvider,
    useActiveOperation,
    useAudioSetters,
    useCurrentMedia,
    useLiveAudioState,
    useOverlayOpen,
    usePlayMode,
    useQueueState,
    useVolumeState,
    type Track,
} from "@/lib/audio-state-context";
import { AudioPlaybackProvider } from "@/lib/audio-playback-context";
import { AudioControlsProvider, useAudioControls } from "@/lib/audio-controls-context";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function fakeController(): AudioController {
    const engine = {
        on: () => undefined,
        off: () => undefined,
        subscribe: () => () => undefined,
        load: vi.fn(),
        play: vi.fn(),
        pause: vi.fn(),
        seek: vi.fn(),
        setVolume: vi.fn(),
        setMuted: vi.fn(),
        notifyForeground: vi.fn(),
        clearExpectedNext: vi.fn(),
        getState: () => ({ currentSrc: null, volume: 1, isMuted: false }),
        isPlaying: () => false,
        hasEnded: () => false,
        isTransitioning: () => false,
        getCurrentTime: () => 0,
        getDuration: () => 0,
    };
    return engine as unknown as AudioController;
}

const track = (id: string): Track =>
    ({ id, title: id, duration: 200, artist: { name: "Artist" }, album: { title: "Album" } }) as unknown as Track;

type Seen = {
    media: ReturnType<typeof useCurrentMedia>;
    queue: ReturnType<typeof useQueueState>;
    mode: ReturnType<typeof usePlayMode>;
    volume: ReturnType<typeof useVolumeState>;
    overlayOpen: boolean;
    operation: ReturnType<typeof useActiveOperation>;
    setters: ReturnType<typeof useAudioSetters>;
    live: ReturnType<typeof useLiveAudioState>;
    controls: ReturnType<typeof useAudioControls>;
};
const seen = {} as Seen;
const renders = { media: 0, queue: 0, mode: 0, volume: 0, overlay: 0, operation: 0, controls: 0 };

// Each reader notes what it was given and that it rendered, once the render is committed.
function MediaReader() {
    const value = useCurrentMedia();
    useEffect(() => {
        seen.media = value;
        renders.media++;
    });
    return null;
}
function QueueReader() {
    const value = useQueueState();
    useEffect(() => {
        seen.queue = value;
        renders.queue++;
    });
    return null;
}
function ModeReader() {
    const value = usePlayMode();
    useEffect(() => {
        seen.mode = value;
        renders.mode++;
    });
    return null;
}
function VolumeReader() {
    const value = useVolumeState();
    useEffect(() => {
        seen.volume = value;
        renders.volume++;
    });
    return null;
}
function OverlayReader() {
    const value = useOverlayOpen();
    useEffect(() => {
        seen.overlayOpen = value;
        renders.overlay++;
    });
    return null;
}
function OperationReader() {
    const value = useActiveOperation();
    useEffect(() => {
        seen.operation = value;
        renders.operation++;
    });
    return null;
}
function ControlsReader() {
    const value = useAudioControls();
    useEffect(() => {
        seen.controls = value;
        renders.controls++;
    });
    return null;
}
function SettersReader() {
    const setters = useAudioSetters();
    const live = useLiveAudioState();
    useEffect(() => {
        seen.setters = setters;
        seen.live = live;
    });
    return null;
}

let container: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(async () => {
    localStorage.clear();
    for (const key of Object.keys(renders)) renders[key as keyof typeof renders] = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(
            <AudioControllerContext.Provider value={fakeController()}>
                <AudioStateProvider>
                    <AudioPlaybackProvider>
                        <AudioControlsProvider>
                            <MediaReader />
                            <QueueReader />
                            <ModeReader />
                            <VolumeReader />
                            <OverlayReader />
                            <OperationReader />
                            <ControlsReader />
                            <SettersReader />
                        </AudioControlsProvider>
                    </AudioPlaybackProvider>
                </AudioStateProvider>
            </AudioControllerContext.Provider>,
        );
    });
    await settle();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

/** Runs a change and says which readers re-rendered because of it. */
async function rerendered(change: () => void) {
    const before = { ...renders };
    await act(async () => change());
    await settle();
    return (Object.keys(renders) as Array<keyof typeof renders>).filter((key) => renders[key] !== before[key]);
}

describe("the player state hooks", () => {
    it("starts with nothing playing and an empty queue", () => {
        expect(seen.media).toMatchObject({ currentTrack: null, currentAudiobook: null, currentPodcast: null, playbackType: null });
        expect(seen.queue).toMatchObject({ queue: [], currentIndex: 0, shuffleIndices: [] });
        expect(seen.mode).toMatchObject({ isShuffle: false, repeatMode: "off", repeatOneCount: 0 });
        expect(seen.volume).toEqual({ volume: 0.5, isMuted: false });
        expect(seen.overlayOpen).toBe(false);
        expect(seen.operation).toEqual({ type: "idle" });
    });

    it("adding to the queue (it plays next) re-renders the queue readers only, not the song, volume, mode or play-button readers", async () => {
        await act(async () => seen.controls.playTracks([track("a"), track("b")], 0));
        await settle();

        const changed = await rerendered(() => seen.controls.addToQueue(track("c")));

        expect(seen.queue.queue.map((t) => t.id)).toEqual(["a", "c", "b"]);
        expect(changed).toEqual(["queue"]);
    });

    it("a volume change re-renders the volume readers only", async () => {
        const changed = await rerendered(() => seen.controls.setVolume(0.8));

        expect(seen.volume.volume).toBe(0.8);
        expect(changed).toEqual(["volume"]);
    });

    it("opening the full-screen player re-renders the overlay readers only", async () => {
        const changed = await rerendered(() => seen.controls.openOverlay());

        expect(seen.overlayOpen).toBe(true);
        expect(changed).toEqual(["overlay"]);
    });

    it("a shuffle toggle re-renders the mode readers, and the queue readers too only when it makes a new order", async () => {
        const noQueue = await rerendered(() => seen.controls.toggleShuffle());
        expect(seen.mode.isShuffle).toBe(true);
        expect(noQueue).toEqual(["mode"]);

        await act(async () => seen.controls.playTracks([track("a"), track("b"), track("c")], 1));
        await settle();

        const off = await rerendered(() => seen.controls.toggleShuffle());
        expect(seen.mode.isShuffle).toBe(false);
        expect(off).toEqual(["mode"]);

        const on = await rerendered(() => seen.controls.toggleShuffle());
        expect(seen.mode.isShuffle).toBe(true);
        expect(on.sort()).toEqual(["mode", "queue"]);
    });

    it("moving to the next song re-renders the song and queue-position readers, not volume or the play buttons", async () => {
        await act(async () => seen.controls.playTracks([track("a"), track("b")], 0));
        await settle();

        const changed = await rerendered(() => seen.controls.next());

        expect(seen.media.currentTrack?.id).toBe("b");
        expect(seen.queue.currentIndex).toBe(1);
        expect(changed.sort()).toEqual(["media", "queue"]);
    });

    it("the play buttons keep one identity however the state changes", async () => {
        const controls = seen.controls;

        await act(async () => controls.playTracks([track("a"), track("b")], 0));
        await act(async () => controls.addToQueue(track("c")));
        await act(async () => controls.setVolume(0.2));
        await act(async () => controls.toggleRepeat());
        await act(async () => controls.next());
        await settle();

        expect(seen.controls).toBe(controls);
    });

    it("the setters keep one identity, and the live state is always the newest", async () => {
        const setters = seen.setters;
        const live = seen.live;

        await act(async () => seen.controls.playTracks([track("a"), track("b")], 0));
        await act(async () => seen.controls.addToQueue(track("c")));
        await settle();

        expect(seen.setters).toBe(setters);
        expect(seen.live).toBe(live);
        expect(live.current.queue.map((t) => t.id)).toEqual(["a", "c", "b"]);
        expect(live.current.currentTrack?.id).toBe("a");
    });

    it("a setter reaches the readers it concerns", async () => {
        const changed = await rerendered(() => seen.setters.setIsMuted(true));

        expect(seen.volume.isMuted).toBe(true);
        expect(changed).toEqual(["volume"]);
    });
});

describe("the player state hooks outside the provider", () => {
    it("refuse to be used there", () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const host = document.createElement("div");
        const alone = createRoot(host);
        function Lonely() {
            useEffect(() => undefined);
            useQueueState();
            return null;
        }
        expect(() => act(() => alone.render(<Lonely />))).toThrow(/AudioStateProvider/);
        errors.mockRestore();
    });
});
