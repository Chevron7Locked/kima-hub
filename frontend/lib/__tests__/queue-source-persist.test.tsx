/**
 * Where a queue came from goes with the queue. The server keeps the page that started it, so a reload, or the same
 * account on another device, still shows that page's play button as playing. Songs added with "add to queue" or
 * "play next" join the queue without changing where it came from. The real audio providers; the server and the engine
 * are stand-ins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";

const server = vi.hoisted(() => ({
    state: null as Record<string, unknown> | null,
    saves: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/api", () => {
    const named: Record<string, unknown> = {
        getQueueLimit: async () => ({ maxQueueLength: 1000 }),
        getPlaybackState: async () => server.state,
        getTrack: async (id: string) => ({ id, title: id, duration: 200, artist: { name: "Artist" }, album: { title: "Album" } }),
        savePlaybackState: async (state: Record<string, unknown>) => {
            server.saves.push(state);
            return { updatedAt: new Date().toISOString() };
        },
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
import { AudioStateProvider, useAudioState } from "@/lib/audio-state-context";
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

const t = (id: string) => ({ id, title: id, duration: 200, artist: { name: "Artist" }, album: { title: "Album" } });
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

let container: HTMLDivElement;
let root: Root;

async function open() {
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
            </AudioControllerContext.Provider>,
        );
    });
}

function capturePoll() {
    const real = globalThis.setInterval;
    let tick: () => unknown = () => undefined;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => unknown, ms: number) => {
        if (ms === 30000) tick = fn;
        return real(() => undefined, 1_000_000);
    }) as typeof setInterval);
    return () => tick;
}

beforeEach(() => {
    localStorage.clear();
    server.saves = [];
    server.state = {
        playbackType: "track",
        trackId: "a",
        queue: [t("a"), t("b")],
        queueSource: "album:al-1",
        currentIndex: 0,
        isShuffle: false,
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
    };
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
});

describe("restoring a queue that came from a page", () => {
    it("shows the page as the source of the playing song", async () => {
        await open();
        await wait(50);
        expect(probe.state.currentTrack?.id).toBe("a");
        expect(probe.state.currentQueueSource).toBe("album:al-1");
    });

    it("does not write the restored source back to the server", async () => {
        await open();
        await wait(1500);
        expect(server.saves).toEqual([]);
    });

    it("has no source when the server saved the queue without one", async () => {
        server.state = { ...server.state, queueSource: null };
        await open();
        await wait(50);
        expect(probe.state.currentQueueSource).toBeNull();
    });

    it("keeps the page when the queue is moved on, to the next song of it", async () => {
        await open();
        await wait(50);
        await act(async () => probe.controls.next());
        expect(probe.state.currentTrack?.id).toBe("b");
        expect(probe.state.currentQueueSource).toBe("album:al-1");
    });

    it("does not give the page to a queue the listener built before the restore arrived", async () => {
        await open();
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(50);
        expect(probe.state.currentTrack?.id).toBe("c");
        expect(probe.state.currentQueueSource).toBeNull();
    });
});

describe("saving a queue that came from a page", () => {
    it("sends the page with the queue", async () => {
        await open();
        await wait(50);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0, { source: "playlist:p-1" }));
        await wait(1500);
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).toMatchObject({ trackId: "c", queueSource: "playlist:p-1" });
    });

    it("sends no page for a queue that was not started from one", async () => {
        await open();
        await wait(50);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0].queueSource ?? null).toBeNull();
    });

    it("sends no page once the queue is replaced by other songs", async () => {
        await open();
        await wait(50);
        await act(async () => probe.controls.playTracks([t("c") as never], 0, { source: "playlist:p-1" }));
        await act(async () => probe.state.setQueue([t("x") as never, t("y") as never]));
        await wait(1500);
        expect(server.saves.at(-1)?.queueSource ?? null).toBeNull();
    });
});

describe("songs added to a queue that came from a page", () => {
    it("keep the page's play button on while one of them plays", async () => {
        await open();
        await wait(50);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0, { source: "album:al-2" }));
        // "play next": the added song goes straight after the playing one.
        await act(async () => probe.controls.addToQueue(t("z") as never));
        await act(async () => probe.controls.next());
        expect(probe.state.currentTrack?.id).toBe("z");
        expect(probe.state.currentQueueSource).toBe("album:al-2");
    });

    it("are saved with the page", async () => {
        await open();
        await wait(50);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0, { source: "album:al-2" }));
        await act(async () => probe.controls.addToQueue(t("z") as never));
        await wait(1500);
        expect(server.saves.at(-1)?.queueSource).toBe("album:al-2");
        expect((server.saves.at(-1)?.queue as Array<{ id: string }>).map((q) => q.id)).toContain("z");
    });

    it("do not give a page to a queue that was not from one", async () => {
        await open();
        await wait(50);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await act(async () => probe.controls.addToQueue(t("z") as never));
        expect(probe.state.currentQueueSource).toBeNull();
    });
});

describe("a queue that was cleared", () => {
    it("takes nothing of the page it came from when songs are added to it afterwards", async () => {
        await open();
        await wait(50);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0, { source: "album:al-2" }));
        await act(async () => probe.controls.clearQueue());
        await act(async () => probe.controls.addToQueue(t("z") as never));
        await wait(1500);
        expect(probe.state.currentQueueSource).toBeNull();
        expect(server.saves.at(-1)?.queueSource ?? null).toBeNull();
    });
});

describe("jumping to another place in the queue", () => {
    it("keeps the queue, its shuffle order and the page it came from", async () => {
        await open();
        await wait(50);
        const songs = ["c", "d", "e", "f", "g"].map((id) => t(id) as never);
        await act(async () => probe.controls.playTracks(songs, 0, { source: "album:al-2" }));
        await act(async () => probe.controls.toggleShuffle());
        const queueBefore = probe.state.queue;
        const orderBefore = [...probe.state.shuffleIndices];

        await act(async () => probe.controls.playQueueIndex(3));

        expect(probe.state.currentTrack?.id).toBe("f");
        expect(probe.state.currentIndex).toBe(3);
        expect(probe.state.queue).toBe(queueBefore);
        expect(probe.state.shuffleIndices).toEqual(orderBefore);
        expect(probe.state.currentQueueSource).toBe("album:al-2");
    });

    it("leaves a place that is not in the queue alone", async () => {
        await open();
        await wait(50);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0, { source: "album:al-2" }));
        await act(async () => probe.controls.playQueueIndex(7));
        await act(async () => probe.controls.playQueueIndex(-1));
        expect(probe.state.currentTrack?.id).toBe("c");
        expect(probe.state.currentIndex).toBe(0);
    });
});

describe("starting a queue at a place that is not in it", () => {
    it.each([7, -1, 1.5, Number.NaN])("plays from the start for place %s, as the queue's own page", async (place) => {
        await open();
        await wait(50);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], place, { source: "album:al-2" }));
        expect(probe.state.currentTrack?.id).toBe("c");
        expect(probe.state.currentIndex).toBe(0);
        expect(probe.state.queue.map((q) => q.id)).toEqual(["c", "d"]);
        expect(probe.state.currentQueueSource).toBe("album:al-2");
    });
});

describe("a queue adopted from another device", () => {
    it("brings that device's page with it", async () => {
        const tick = capturePoll();
        server.state = { ...server.state, trackId: null, queue: null, queueSource: null };
        await open();
        await wait(50);
        await act(async () => probe.controls.playTracks([t("c") as never], 0));
        await wait(5);
        server.state = {
            playbackType: "track",
            trackId: "e",
            queue: [t("e"), t("f")],
            queueSource: "mix:m-1",
            currentIndex: 0,
            isShuffle: false,
            updatedAt: new Date(Date.now() + 5000).toISOString(),
        };
        await act(async () => {
            await tick()();
        });
        await wait(50);
        expect(probe.state.currentTrack?.id).toBe("e");
        expect(probe.state.currentQueueSource).toBe("mix:m-1");
    });
});
