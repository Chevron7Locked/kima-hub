/**
 * Opening a page restores what was playing from the server. That restore is not a change, so the page does not write
 * it straight back; it saves again only when the listener changes something. A save never goes out half-restored
 * (the song still on its way), which would leave the server without it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";

const server = vi.hoisted(() => ({
    state: null as Record<string, unknown> | null,
    trackDelay: 0,
    trackFails: false,
    podcastGone: false,
    audiobook: null as Record<string, unknown> | null,
    saves: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/api", () => {
    const named: Record<string, unknown> = {
        getQueueLimit: async () => ({ maxQueueLength: 1000 }),
        getPlaybackState: async () => server.state,
        getTrack: async (id: string) => {
            await new Promise((r) => setTimeout(r, server.trackDelay));
            if (server.trackFails) throw Object.assign(new Error("server error"), { status: 500 });
            return { id, title: id, duration: 200, artist: { name: "Artist" }, album: { title: "Album" } };
        },
        savePlaybackState: async (state: Record<string, unknown>) => {
            server.saves.push(state);
            return { updatedAt: new Date().toISOString() };
        },
        clearPlaybackState: async () => ({}),
        getAudiobook: async () => server.audiobook,
        getPodcast: async () => {
            if (server.podcastGone) throw Object.assign(new Error("gone"), { status: 404 });
            return { episodes: [] };
        },
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

const pause = vi.fn();

function fakeController(): AudioController {
    const engine = {
        on: () => undefined,
        off: () => undefined,
        subscribe: () => () => undefined,
        load: vi.fn(),
        play: vi.fn(),
        pause,
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

beforeEach(() => {
    localStorage.clear();
    server.saves = [];
    server.trackDelay = 0;
    server.trackFails = false;
    server.podcastGone = false;
    pause.mockClear();
    server.state = {
        playbackType: "track",
        trackId: "a",
        queue: [t("a"), t("b")],
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

/** Runs the 30-second check for another device's changes once, now. */
async function pollNow(tick: () => unknown) {
    await act(async () => {
        await tick();
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

describe("restoring what was playing", () => {
    it("does not write the restored state back to the server", async () => {
        await open();
        await wait(1500);
        expect(probe.state.currentTrack?.id).toBe("a");
        expect(server.saves).toEqual([]);
    });

    it("never saves while the song is still on its way, even when a local choice comes in first", async () => {
        server.trackDelay = 2500;
        await open();
        await wait(50);
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.saves).toEqual([]);
        await wait(1500);
        expect(probe.state.currentTrack?.id).toBe("a");
        expect(server.saves).toEqual([]);
        await wait(2000);
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).toMatchObject({ playbackType: "track", trackId: "a", isShuffle: true });
    }, 15_000);

    it("saves once the listener changes something", async () => {
        await open();
        await wait(1500);
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).toMatchObject({ playbackType: "track", trackId: "a", isShuffle: true });
    });

    it("says outright that nothing is loaded once the queue is cleared, so the server forgets the song", async () => {
        await open();
        await wait(1500);
        await act(async () => probe.controls.clearQueue());
        await wait(1500);
        expect(server.saves).toHaveLength(1);
        // Over the wire a missing field means "leave it alone", so the empty value has to survive JSON.
        expect(JSON.parse(JSON.stringify(server.saves[0]))).toMatchObject({ trackId: null, audiobookId: null, podcastId: null, queue: [] });
    });
});

describe("another device clears the queue", () => {
    const cleared = (msAgo: number) => ({
        playbackType: "track", trackId: null, audiobookId: null, podcastId: null, queue: null, currentIndex: 0,
        isShuffle: false, updatedAt: new Date(Date.now() - msAgo).toISOString(),
    });

    it("stops here too and writes nothing back, so the cleared song cannot return", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = cleared(0);
        await wait(5);
        await pollNow(tick());
        await wait(1500);
        expect(probe.state.currentTrack).toBeNull();
        expect(probe.state.queue).toEqual([]);
        expect(pause).toHaveBeenCalled();
        expect(server.saves).toEqual([]);
    });

    it("leaves a song started here since then alone", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = cleared(0);
        await wait(5);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("c");
    });

    it("leaves an audiobook started here since then alone, though it never touches the queue", async () => {
        server.state = { ...cleared(120_000) };
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = cleared(0);
        await wait(5);
        await act(async () => {
            probe.state.setCurrentAudiobook({ id: "book", title: "Book" } as never);
            probe.state.setPlaybackType("audiobook");
        });
        await pollNow(tick());
        expect(probe.state.currentAudiobook?.id).toBe("book");
        expect(pause).not.toHaveBeenCalled();
    });

    it("keeps playing when the other device saved a queue with no current song", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = { ...cleared(0), queue: [t("a"), t("b")] };
        await wait(5);
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("a");
    });
});

describe("a restore that fails", () => {
    it("writes nothing back, so another device's song survives a server hiccup", async () => {
        localStorage.setItem("kima_current_audiobook", JSON.stringify({ id: "book", title: "Book" }));
        localStorage.setItem("kima_playback_type", "audiobook");
        server.trackFails = true;
        await open();
        await wait(1500);
        expect(server.saves).toEqual([]);
    });

    it("still saves a song the listener started while the restore was failing", async () => {
        server.trackFails = true;
        server.trackDelay = 500;
        await open();
        await act(async () => probe.controls.playTracks([t("c") as never], 0));
        await wait(1000);
        await wait(1500);
        expect(server.saves.at(-1)).toMatchObject({ trackId: "c" });
    });

    it("saves again once the listener changes something", async () => {
        server.trackFails = true;
        await open();
        await wait(1500);
        server.trackFails = false;
        await act(async () => probe.controls.playTracks([t("c") as never], 0));
        await wait(1500);
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).toMatchObject({ trackId: "c" });
    });
});

describe("a stored podcast that is gone", () => {
    it("leaves nothing loaded rather than a podcast with no episode", async () => {
        server.state = null;
        server.podcastGone = true;
        localStorage.setItem("kima_current_podcast", JSON.stringify({ id: "show:ep", title: "Ep" }));
        localStorage.setItem("kima_playback_type", "podcast");
        await open();
        await wait(1500);
        expect(probe.state.currentPodcast).toBeNull();
        expect(probe.state.playbackType).toBeNull();
        expect(server.saves).toEqual([]);
    });
});

describe("an audiobook taken out of the player", () => {
    it("tells the server, and playing it again saves again", async () => {
        server.state = { playbackType: "audiobook", audiobookId: "book", queue: null, currentIndex: 0, isShuffle: false, updatedAt: new Date(Date.now() - 60_000).toISOString() };
        const book = { id: "book", title: "Book" };
        server.audiobook = book;
        await open();
        await wait(1500);
        await act(async () => probe.state.setCurrentAudiobook(null));
        await wait(1500);
        expect(server.saves.at(-1)).toMatchObject({ playbackType: "audiobook", audiobookId: null });
        await act(async () => probe.state.setCurrentAudiobook(book as never));
        await wait(1500);
        expect(server.saves.at(-1)).toMatchObject({ audiobookId: "book" });
    });
});
