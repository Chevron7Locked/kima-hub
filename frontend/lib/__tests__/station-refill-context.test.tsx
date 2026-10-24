/**
 * The station refill in the real audio providers: when the listener removes the tracks a refill added, the queue ends
 * on the same track again and the station fetches again; and however often the player state changes while a fetch is
 * out, only one fetch is in flight. The audio engine is a stand-in that plays nothing; the queue, its edits and the
 * refill effect are the app's own.
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
    // Anything else the providers reach for answers with nothing.
    const api = new Proxy(named, { get: (target, key: string) => target[key] ?? (async () => null) });
    return { api, getApiBaseUrl: () => "" };
});
vi.mock("@/hooks/usePlayReporting", () => ({ usePlayReporting: () => undefined }));
vi.mock("@/hooks/useLiveReporting", () => ({ upNext: () => [], useLiveReporting: () => undefined }));
vi.mock("@/lib/features-context", () => ({ useFeatures: () => ({ liveReporting: false }) }));

import { AudioControllerContext } from "@/lib/audio-controller-context";
import type { AudioController } from "@/lib/audio-controller";
import { AudioStateProvider, useAudioState, type Track } from "@/lib/audio-state-context";
import { AudioPlaybackProvider } from "@/lib/audio-playback-context";
import { AudioControlsProvider, useAudioControls } from "@/lib/audio-controls-context";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** An engine that plays nothing and never ends a track on its own. */
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

const probe = {} as { controls: ReturnType<typeof useAudioControls>; state: ReturnType<typeof useAudioState> };

function Probe() {
    const controls = useAudioControls();
    const state = useAudioState();
    useEffect(() => {
        probe.controls = controls;
        probe.state = state;
    });
    return null;
}

let container: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const queueIds = () => probe.state.queue.map((t) => t.id);

/** A fetch the test answers by hand, so the test decides what is in flight. */
function deferredFetches() {
    const pending: Array<(tracks: Track[]) => void> = [];
    const fetchBatch = vi.fn(() => new Promise<Track[]>((resolve) => pending.push(resolve)));
    const answer = async (tracks: Track[]) => {
        await act(async () => {
            pending.shift()!(tracks);
        });
        await settle();
    };
    return { fetchBatch, answer };
}

beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(
            <AudioControllerContext.Provider value={fakeController()}>
                <AudioStateProvider>
                    <AudioPlaybackProvider>
                        <AudioControlsProvider>
                            <Probe />
                        </AudioControlsProvider>
                    </AudioPlaybackProvider>
                </AudioStateProvider>
            </AudioControllerContext.Provider>
        );
    });
    await settle();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe("a station in the audio providers", () => {
    it("fetches again when the listener removes what a refill added, with one fetch in flight at a time", async () => {
        const { fetchBatch, answer } = deferredFetches();

        // A one-track station: its last track is playing, so it asks for more at once.
        await act(async () => probe.controls.playStation([track("a")], fetchBatch));
        await settle();
        expect(fetchBatch).toHaveBeenCalledTimes(1);

        // The player state changes while that fetch is out: no second fetch.
        await act(async () => probe.state.setRepeatOneCount(1));
        await act(async () => probe.state.setRepeatOneCount(2));
        await settle();
        expect(fetchBatch).toHaveBeenCalledTimes(1);

        await answer([track("b")]);
        expect(queueIds()).toEqual(["a", "b"]);
        // "a" is no longer last, so nothing more is asked for.
        expect(fetchBatch).toHaveBeenCalledTimes(1);

        // The listener removes the added track: the queue ends on "a" again, the same place as before.
        await act(async () => probe.controls.removeFromQueue(1));
        await settle();
        expect(queueIds()).toEqual(["a"]);
        expect(fetchBatch).toHaveBeenCalledTimes(2);

        await act(async () => probe.state.setRepeatOneCount(3));
        await settle();
        expect(fetchBatch).toHaveBeenCalledTimes(2);

        await answer([track("c")]);
        expect(queueIds()).toEqual(["a", "c"]);
    });

    it("keeps one fetch in flight when an edit moves the playing track while it is out", async () => {
        const { fetchBatch, answer } = deferredFetches();
        await act(async () => probe.controls.playStation([track("a"), track("b")], fetchBatch));
        await settle();
        expect(fetchBatch).toHaveBeenCalledTimes(0);

        // "b", the last track, starts: the station asks for more.
        await act(async () => probe.controls.next());
        await settle();
        expect(fetchBatch).toHaveBeenCalledTimes(1);

        // While that fetch is out the listener removes "a": "b" is still last, now at another position.
        await act(async () => probe.controls.removeFromQueue(0));
        await settle();
        expect(queueIds()).toEqual(["b"]);
        expect(fetchBatch).toHaveBeenCalledTimes(1);

        await answer([track("c")]);
        expect(queueIds()).toEqual(["b", "c"]);
        expect(fetchBatch).toHaveBeenCalledTimes(1);
    });

    it("stops asking once a fetch brings nothing new", async () => {
        const { fetchBatch, answer } = deferredFetches();
        await act(async () => probe.controls.playStation([track("a")], fetchBatch));
        await settle();
        await answer([track("a")]);
        expect(queueIds()).toEqual(["a"]);

        await act(async () => probe.state.setRepeatOneCount(1));
        await settle();
        expect(fetchBatch).toHaveBeenCalledTimes(1);
    });
});
