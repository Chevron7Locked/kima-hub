/**
 * Two entries of one song stay apart in the player's queue. A playlist can list a song twice; the row you started, or
 * the one the queue reached, is the one that shows as playing, and the queue moves on from that row. The real playlist
 * page in the real audio providers; the server and the audio engine are stand-ins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/link", () => ({
    default: ({ children, href, ...rest }: { children?: React.ReactNode; href: string; [k: string]: unknown }) =>
        React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
    useParams: () => ({ id: "p-1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    usePathname: () => "/playlist/p-1",
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ isAuthenticated: true, user: { id: "u-1" } }) }));
vi.mock("@/hooks/usePreview", () => ({ usePreview: () => ({ toggle: vi.fn(), previewId: null }) }));
vi.mock("@/hooks/usePlayReporting", () => ({ usePlayReporting: () => undefined }));
vi.mock("@/hooks/useLiveReporting", () => ({ upNext: () => [], useLiveReporting: () => undefined }));
vi.mock("@/lib/features-context", () => ({ useFeatures: () => ({ liveReporting: false }) }));
// A list of a few rows has no scroll box to measure in a test; the virtualizer shows every row.
vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: ({ count }: { count: number }) => ({
        getTotalSize: () => count * 64,
        getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 64 })),
        measureElement: () => undefined,
        options: { scrollMargin: 0 },
        scrollToIndex: () => undefined,
        scrollToOffset: () => undefined,
        measure: () => undefined,
    }),
}));

const song = (id: string) => ({
    id,
    title: id,
    duration: 200,
    album: { id: `al-${id}`, title: "Album", artist: { id: "ar", name: "Artist" } },
});
// Items [A, B, A]: the playlist lists song A twice, each with its own item id.
const A_B_A = [
    { id: "item-1", track: song("A") },
    { id: "item-2", track: song("B") },
    { id: "item-3", track: song("A") },
];
let listed = A_B_A;
const preload = vi.fn();

vi.mock("@/lib/api", () => {
    const named: Record<string, unknown> = {
        getPlaylist: async () => ({ id: "p-1", name: "Mine", isOwner: true, isPublic: false, isHidden: false, items: listed, pendingTracks: [] }),
        getPublicConfig: async () => ({ publicUrl: "", canAcquire: false }),
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

import PlaylistPage from "@/app/playlist/[id]/page";
import { AudioControllerContext } from "@/lib/audio-controller-context";
import type { AudioController } from "@/lib/audio-controller";
import { AudioStateProvider, useAudioState, type Track } from "@/lib/audio-state-context";
import { AudioPlaybackProvider } from "@/lib/audio-playback-context";
import { AudioControlsProvider, useAudioControls } from "@/lib/audio-controls-context";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** An engine that plays nothing; the test sends it the events a real one would (time passing, a gapless swap). */
function fakeController() {
    const handlers = new Map<string, Set<(data?: unknown) => void>>();
    const watchers = new Set<(snap: { status: string }) => void>();
    let src: string | null = null;
    const engine = {
        /** Tells the audio providers what the engine is doing now, as a real one does. */
        setStatus: (status: string) => watchers.forEach((watch) => watch({ status })),
        on: (event: string, fn: (data?: unknown) => void) => {
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event)!.add(fn);
        },
        off: (event: string, fn: (data?: unknown) => void) => void handlers.get(event)?.delete(fn),
        emit: (event: string, data?: unknown) => handlers.get(event)?.forEach((fn) => fn(data)),
        subscribe: (watch: (snap: { status: string }) => void) => {
            watchers.add(watch);
            return () => void watchers.delete(watch);
        },
        load: vi.fn((url: string) => {
            src = url;
        }),
        play: vi.fn(),
        pause: vi.fn(),
        seek: vi.fn(),
        setVolume: vi.fn(),
        setMuted: vi.fn(),
        notifyForeground: vi.fn(),
        setExpectedNext: vi.fn(),
        preloadNext: preload,
        clearExpectedNext: vi.fn(),
        getState: () => ({ currentSrc: src, volume: 1, isMuted: false }),
        isPlaying: () => false,
        hasEnded: () => false,
        isTransitioning: () => false,
        getCurrentTime: () => 0,
        getDuration: () => 0,
    };
    return engine;
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

let container: HTMLDivElement;
let root: Root;
let engine: ReturnType<typeof fakeController>;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const rows = () => [...container.querySelectorAll<HTMLElement>("[data-track-index]")];
/** The places (0-based) of the playlist rows shown as playing. */
const playingRows = () => rows().filter((r) => r.getAttribute("aria-current") === "true").map((r) => Number(r.dataset.trackIndex));
const startRow = (place: number) =>
    act(async () => rows()[place].querySelector<HTMLButtonElement>('button[aria-label="Play"]')!.click());

async function mountPage(list = A_B_A) {
    listed = list;
    engine = fakeController();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    await act(async () =>
        root.render(
            <QueryClientProvider client={client}>
                <AudioControllerContext.Provider value={engine as unknown as AudioController}>
                    <AudioStateProvider>
                        <AudioPlaybackProvider>
                            <AudioControlsProvider>
                                <Probe />
                                <PlaylistPage />
                            </AudioControlsProvider>
                        </AudioPlaybackProvider>
                    </AudioStateProvider>
                </AudioControllerContext.Provider>
            </QueryClientProvider>,
        ),
    );
    await settle();
    await settle();
}

beforeEach(() => preload.mockClear());
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe("a playlist that lists a song twice, [A, B, A]", () => {
    it("shows only the third row as playing when the third row was started", async () => {
        await mountPage();
        expect(rows()).toHaveLength(3);

        await startRow(2);

        expect(playingRows()).toEqual([2]);
    });

    it("goes from the first A to B, and from B to the second A, one row at a time", async () => {
        await mountPage();
        await startRow(0);
        expect(playingRows()).toEqual([0]);

        await act(async () => probe.controls.next());
        expect(playingRows()).toEqual([1]);

        await act(async () => probe.controls.next());
        expect(playingRows()).toEqual([2]);
        expect(probe.state.currentIndex).toBe(2);
    });

    it("keeps the first A playing when the second A is removed from the queue", async () => {
        await mountPage();
        await startRow(0);

        await act(async () => probe.controls.removeFromQueue(2));

        expect(playingRows()).toEqual([0]);
        expect(probe.state.currentIndex).toBe(0);
    });

    it("preloads and lands on the second A after the first A, not on the first", async () => {
        await mountPage([A_B_A[1], A_B_A[0], A_B_A[2]]); // [B, A, A]
        await startRow(0);
        await act(async () => engine.emit("timeupdate", { time: 195 })); // the first A is preloaded
        await act(async () => engine.emit("gapless-advance", { trackId: "A", durationS: 200 }));
        expect(playingRows()).toEqual([1]);

        // The second A is next, though A was already preloaded once: it is another entry.
        await act(async () => engine.emit("timeupdate", { time: 195 }));
        expect(engine.setExpectedNext).toHaveBeenCalledTimes(2);
        await act(async () => engine.emit("gapless-advance", { trackId: "A", durationS: 200 }));

        expect(probe.state.currentIndex).toBe(2);
        expect(playingRows()).toEqual([2]);
    });

    it("gives an entry added twice two keys, so each is its own entry", async () => {
        await mountPage();
        const add = song("Z") as unknown as Track;
        await act(async () => probe.controls.playTracks([add], 0));
        await act(async () => probe.controls.addToQueue(add));
        await act(async () => probe.controls.addToQueue(add));

        const keys = probe.state.queue.map((t) => t.queueKey);
        expect(new Set(keys).size).toBe(3);
        expect(keys.every(Boolean)).toBe(true);
    });
});

describe("the button on a playlist row", () => {
    const rowButton = (place: number) => rows()[place].querySelector<HTMLButtonElement>("button")!;
    const press = (place: number) => act(async () => rowButton(place).click());
    const status = (value: string) => act(async () => engine.setStatus(value));

    it("says pause on the row that is playing, and pauses without restarting the queue", async () => {
        await mountPage();
        await startRow(1);
        await status("playing");
        expect(rowButton(1).getAttribute("aria-label")).toBe("Pause");
        engine.load.mockClear();

        await press(1);

        expect(engine.pause).toHaveBeenCalledTimes(1);
        expect(engine.load).not.toHaveBeenCalled();
        expect(probe.state.currentIndex).toBe(1);
    });

    it("resumes the paused row from where it stopped, not from the start", async () => {
        await mountPage();
        await startRow(1);
        await status("playing");
        await press(1);
        await status("paused");
        expect(rowButton(1).getAttribute("aria-label")).toBe("Play");
        engine.load.mockClear();

        await press(1);

        expect(engine.play).toHaveBeenCalledTimes(1);
        expect(engine.load).not.toHaveBeenCalled();
        expect(probe.state.currentIndex).toBe(1);
    });

    it("shows the pause icon on the row that sounds and the play icon on the others", async () => {
        const icon = (place: number, name: string) => rowButton(place).querySelector(`.lucide-${name}`) !== null;
        await mountPage();
        await startRow(1);
        await status("playing");
        expect(icon(1, "pause")).toBe(true);
        expect(icon(1, "play")).toBe(false);
        expect(icon(0, "play")).toBe(true);
        expect(icon(0, "pause")).toBe(false);

        await status("paused");
        expect(icon(1, "play")).toBe(true);
        expect(icon(1, "pause")).toBe(false);
    });

    it("starts the queue from another row, as before", async () => {
        await mountPage();
        await startRow(1);
        await status("playing");
        engine.load.mockClear();

        await press(0);

        expect(engine.pause).not.toHaveBeenCalled();
        expect(engine.load).toHaveBeenCalledTimes(1);
        expect(probe.state.currentIndex).toBe(0);
    });

    it("pauses only the row that is playing when a song is listed twice", async () => {
        await mountPage();
        await startRow(2); // the second A
        await status("playing");
        engine.load.mockClear();

        await press(0); // the first A is another row: it starts, it does not pause

        expect(engine.pause).not.toHaveBeenCalled();
        expect(engine.load).toHaveBeenCalledTimes(1);
        expect(probe.state.currentIndex).toBe(0);
    });
});

const other = (id: string) => ({ ...song(id), artist: { name: "x" } }) as unknown as Track;
const preloadedUrls = () => engine.setExpectedNext.mock.calls.map((c) => c[0]);

describe("the gapless preload follows the queue", () => {
    /** Plays [A, B, A] from its first row, with B preloaded as the last 30 seconds begin. */
    async function preloadB() {
        await mountPage();
        await startRow(0);
        await act(async () => engine.emit("timeupdate", { time: 195 }));
        expect(preloadedUrls()).toEqual(["/stream/B"]);
        engine.clearExpectedNext.mockClear();
        engine.setExpectedNext.mockClear();
        preload.mockClear();
    }

    it("drops the preload when the preloaded entry is removed, and preloads the real next entry", async () => {
        await preloadB();

        await act(async () => probe.controls.removeFromQueue(1)); // B goes; the second A is next now
        expect(engine.clearExpectedNext).toHaveBeenCalledTimes(1);

        await act(async () => engine.emit("timeupdate", { time: 196 }));
        expect(preloadedUrls()).toEqual(["/stream/A"]);
        expect(preload).toHaveBeenCalledTimes(1);

        await act(async () => engine.emit("gapless-advance", { trackId: "A", durationS: 200 }));
        expect(probe.state.currentIndex).toBe(1);
        expect(playingRows()).toEqual([2]); // the playlist still lists the second A as its third row
    });

    it("drops the preload when a song queued to play next takes B's place as next", async () => {
        await preloadB();

        await act(async () => probe.controls.addToQueue(other("C")));
        expect(probe.state.queue.map((t) => t.id)).toEqual(["A", "C", "B", "A"]);
        expect(engine.clearExpectedNext).toHaveBeenCalledTimes(1);

        await act(async () => engine.emit("timeupdate", { time: 196 }));
        expect(preloadedUrls()).toEqual(["/stream/C"]);
        await act(async () => engine.emit("gapless-advance", { trackId: "C", durationS: 100 }));
        expect(probe.state.currentTrack?.id).toBe("C");
        expect(probe.state.currentIndex).toBe(1);
    });

    it("drops the preload when the queue is replaced under the playing song", async () => {
        await preloadB();

        await act(async () => probe.controls.setUpcoming([other("D"), other("E")], true));
        expect(engine.clearExpectedNext).toHaveBeenCalledTimes(1);

        await act(async () => engine.emit("timeupdate", { time: 196 }));
        expect(preloadedUrls()).toEqual(["/stream/D"]);
    });

    it("keeps the preload through an edit that leaves the preloaded entry next", async () => {
        await preloadB();

        await act(async () => probe.controls.removeFromQueue(2)); // the last entry goes; B is still next
        expect(engine.clearExpectedNext).not.toHaveBeenCalled();

        await act(async () => engine.emit("gapless-advance", { trackId: "B", durationS: 200 }));
        expect(probe.state.currentTrack?.id).toBe("B");
        expect(probe.state.currentIndex).toBe(1);
    });

    it("preloads again on every pass of a one-song queue that repeats", async () => {
        await mountPage([A_B_A[0]]);
        await act(async () => probe.controls.toggleRepeat()); // all
        await startRow(0);
        await act(async () => engine.emit("timeupdate", { time: 195 }));
        expect(preloadedUrls()).toEqual(["/stream/A"]);
        await act(async () => engine.emit("gapless-advance", { trackId: "A", durationS: 200 }));

        await act(async () => engine.emit("timeupdate", { time: 195 })); // the second pass
        expect(preloadedUrls()).toEqual(["/stream/A", "/stream/A"]);
    });

    it("preloads the same entry again after the repeat mode dropped its preload", async () => {
        await preloadB();

        await act(async () => probe.controls.toggleRepeat()); // all
        await act(async () => probe.controls.toggleRepeat()); // one: no next song, the preload goes
        expect(engine.clearExpectedNext).toHaveBeenCalled();
        await act(async () => probe.controls.toggleRepeat()); // off again

        await act(async () => engine.emit("timeupdate", { time: 196 }));
        expect(preloadedUrls()).toEqual(["/stream/B"]);
        expect(preload).toHaveBeenCalledTimes(1);
    });
});
