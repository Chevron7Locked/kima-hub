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
    saves: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/api", () => {
    const named: Record<string, unknown> = {
        getQueueLimit: async () => ({ maxQueueLength: 1000 }),
        getPlaybackState: async () => server.state,
        getTrack: async (id: string) => {
            await new Promise((r) => setTimeout(r, server.trackDelay));
            return { id, title: id, duration: 200, artist: { name: "Artist" }, album: { title: "Album" } };
        },
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

beforeEach(() => {
    localStorage.clear();
    server.saves = [];
    server.trackDelay = 0;
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
});

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
