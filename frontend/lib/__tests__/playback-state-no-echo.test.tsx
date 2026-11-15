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
    saveFails: false,
    saveAttempts: 0,
    /** For each save sent, whether it asked to be kept alive past the page. */
    keptAlive: [] as boolean[],
    clears: 0,
    audiobookGone: false,
    audiobookDelay: 0,
    /** Runs while an audiobook is being asked for, before it answers: another device acting in the meantime. */
    whileAsking: null as (() => void) | null,
    trackGone: false,
    /** Holds every save until it is let go; counts the saves on their way at once. */
    saveGate: null as Promise<void> | null,
    savesInFlight: 0,
    mostSavesInFlight: 0,
    stateReads: 0,
    /** Holds a read (after the first `readsToPass`) until it is let go; it answers what the server held when asked. */
    readGate: null as Promise<void> | null,
    /** One entry per save that is written: its reply is held until that gate opens (null: answered at once). */
    replyGates: [] as Array<Promise<void> | null>,
    readsToPass: 0,
    /** Runs as a save reaches the server, before it is written: another device saving in the meantime. */
    beforeSave: null as (() => void) | null,
    /** The saves the server refused for naming a time that was no longer its own. */
    refused: [] as Array<Record<string, unknown>>,
    /** Answers every save 409, though it named no time (a 409 that is not a refused conditional save). */
    saveAnswers409: false,
    podcastGone: false,
    audiobook: null as Record<string, unknown> | null,
    audiobookFails: false,
    episodes: [] as Array<Record<string, unknown>>,
    saves: [] as Array<Record<string, unknown>>,
    /** The server's clock, which a test can keep apart from this device's. */
    now: () => Date.now(),
}));

vi.mock("@/lib/api", () => {
    const named: Record<string, unknown> = {
        getQueueLimit: async () => ({ maxQueueLength: 1000 }),
        getPlaybackState: async () => {
            server.stateReads++;
            const answer = server.state;
            if (server.readsToPass > 0) server.readsToPass--;
            else if (server.readGate) await server.readGate;
            return answer;
        },
        getTrack: async (id: string) => {
            await new Promise((r) => setTimeout(r, server.trackDelay));
            if (server.trackFails) throw Object.assign(new Error("server error"), { status: 500 });
            if (server.trackGone) throw Object.assign(new Error("gone"), { status: 404 });
            return { id, title: id, duration: 200, artist: { name: "Artist" }, album: { title: "Album" } };
        },
        savePlaybackState: async (state: Record<string, unknown>, options?: { keepalive?: boolean }) => {
            server.saveAttempts++;
            server.keptAlive.push(options?.keepalive === true);
            server.savesInFlight++;
            server.mostSavesInFlight = Math.max(server.mostSavesInFlight, server.savesInFlight);
            // Whether the server is failing is settled when the save is sent, not when the gate lets it through.
            const fails = server.saveFails;
            try {
                if (server.saveGate) await server.saveGate;
                if (fails) throw Object.assign(new Error("server error"), { status: 500 });
                if (server.saveAnswers409) throw Object.assign(new Error("conflict"), { status: 409 });
                server.beforeSave?.();
                const { expectedUpdatedAt, ...held } = state;
                // A save naming the time it saw is written only while that is still the server's time.
                if (expectedUpdatedAt !== undefined && server.state?.updatedAt !== expectedUpdatedAt) {
                    server.refused.push(state);
                    throw Object.assign(new Error("changed"), { status: 409, data: { state: server.state } });
                }
                server.saves.push(state);
                // The server holds what it was last sent, as of its own clock.
                const updatedAt = new Date(server.now()).toISOString();
                server.state = { ...held, updatedAt };
                const replyGate = server.replyGates.shift();
                if (replyGate) await replyGate;
                return { updatedAt };
            } finally {
                server.savesInFlight--;
            }
        },
        clearPlaybackState: async () => {
            server.clears++;
            server.state = null;
            return {};
        },
        getAudiobook: async () => {
            if (server.audiobookDelay) await new Promise((r) => setTimeout(r, server.audiobookDelay));
            server.whileAsking?.();
            if (server.audiobookGone) throw Object.assign(new Error("gone"), { status: 404 });
            if (server.audiobookFails) throw Object.assign(new Error("server error"), { status: 500 });
            return server.audiobook;
        },
        getPodcast: async () => {
            if (server.podcastGone) throw Object.assign(new Error("gone"), { status: 404 });
            return { title: "Show", coverUrl: null, episodes: server.episodes };
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
    server.saveFails = false;
    server.saveAttempts = 0;
    server.keptAlive = [];
    server.clears = 0;
    server.audiobookGone = false;
    server.audiobookDelay = 0;
    server.whileAsking = null;
    server.trackGone = false;
    server.saveGate = null;
    server.savesInFlight = 0;
    server.mostSavesInFlight = 0;
    server.stateReads = 0;
    server.readGate = null;
    server.readsToPass = 0;
    server.replyGates = [];
    server.beforeSave = null;
    server.refused = [];
    server.saveAnswers409 = false;
    server.trackFails = false;
    server.podcastGone = false;
    server.audiobook = null;
    server.audiobookFails = false;
    server.episodes = [];
    server.now = () => Date.now();
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
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/** Hides or shows the tab, as the browser does: the flag, then the event. */
function setHidden(hidden: boolean) {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
}

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
        await wait(5); // A clear in the same millisecond as the restore is not newer than it.
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
        await wait(5); // A clear in the same millisecond as the restore is not newer than it.
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
        await wait(5); // A clear in the same millisecond as the restore is not newer than it.
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
        await wait(5);
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

describe("another device's state that this page cannot apply yet", () => {
    const fromOtherDevice = (fields: Record<string, unknown>) => ({
        playbackType: "track", trackId: null, audiobookId: null, podcastId: null, queue: null, currentIndex: 0,
        isShuffle: false, updatedAt: new Date(Date.now() + 5000).toISOString(), ...fields,
    });

    it("tries an audiobook again on the next check when it was not found", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.audiobook = null;
        await pollNow(tick());
        expect(probe.state.currentAudiobook).toBeNull();
        expect(probe.state.playbackType).toBe("track");
        server.audiobook = { id: "book", title: "Book" };
        await pollNow(tick());
        expect(probe.state.currentAudiobook?.id).toBe("book");
        expect(probe.state.playbackType).toBe("audiobook");
    });

    it("tries an audiobook again on the next check when asking for it failed", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.audiobook = { id: "book", title: "Book" };
        server.audiobookFails = true;
        await pollNow(tick());
        expect(probe.state.currentAudiobook).toBeNull();
        server.audiobookFails = false;
        await pollNow(tick());
        expect(probe.state.currentAudiobook?.id).toBe("book");
    });

    it("tries an episode again on the next check when its show does not list it yet", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ playbackType: "podcast", podcastId: "show:ep-1" });
        await pollNow(tick());
        expect(probe.state.currentPodcast).toBeNull();
        expect(probe.state.playbackType).toBe("track");
        server.episodes = [{ id: "ep-1", title: "Episode", duration: 600, progress: null }];
        await pollNow(tick());
        expect(probe.state.currentPodcast?.id).toBe("show:ep-1");
        expect(probe.state.playbackType).toBe("podcast");
    });
});

describe("another device's song", () => {
    const fromOtherDevice = (fields: Record<string, unknown>) => ({
        playbackType: "track", trackId: "e", audiobookId: null, podcastId: null, queue: [t("e"), t("f")], currentIndex: 0,
        isShuffle: false, updatedAt: new Date(Date.now() + 5000).toISOString(), ...fields,
    });

    it("does not replace a song started here whose save has not gone out yet", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        server.state = fromOtherDevice({});
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("c");
        expect(probe.state.queue.map((q) => q.id)).toEqual(["c", "d"]);
    });

    it("replaces a song once everything started here has been saved", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        expect(server.saves).toHaveLength(1);
        server.state = fromOtherDevice({});
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("e");
    });

    it("does not replace a song started here whose save failed", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.saveFails = true;
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        server.state = fromOtherDevice({});
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("c");
    });

    it("is taken when nothing plays here because the restore failed, though the server state is the one this page already saw", async () => {
        const tick = capturePoll();
        server.trackFails = true;
        await open();
        await wait(1500);
        expect(probe.state.currentTrack).toBeNull();
        server.trackFails = false;
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("a");
    });
});

describe("a device clock that is not the server's", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const otherQueue = (updatedAt: number) => ({
        playbackType: "track", trackId: "a", audiobookId: null, podcastId: null, queue: [t("a"), t("b"), t("z")], currentIndex: 0,
        isShuffle: false, updatedAt: new Date(updatedAt).toISOString(),
    });
    /** Moves this device's clock apart from the server's, which keeps telling real time. */
    const skewClock = (ms: number) => {
        const real = Date.now.bind(Date);
        server.now = real;
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(real() + ms);
        return real;
    };

    it("takes another device's change though this clock runs a day ahead of the server", async () => {
        const tick = capturePoll();
        const serverNow = skewClock(DAY);
        await open();
        await wait(1500);
        server.state = otherQueue(serverNow() + 1000);
        await pollNow(tick());
        expect(probe.state.queue.map((q) => q.id)).toEqual(["a", "b", "z"]);
    });

    it("keeps a change made here whose save has not gone out, though this clock runs a day behind the server", async () => {
        const tick = capturePoll();
        const serverNow = skewClock(-DAY);
        await open();
        await wait(1500);
        await act(async () => probe.controls.playTracks([t("a") as never, t("c") as never], 0));
        server.state = otherQueue(serverNow() + 1000);
        await pollNow(tick());
        expect(probe.state.queue.map((q) => q.id)).toEqual(["a", "c"]);
    });

    it("clears when another device cleared, though this clock runs a day ahead of the server", async () => {
        const tick = capturePoll();
        const serverNow = skewClock(DAY);
        await open();
        await wait(1500);
        server.state = {
            playbackType: "track", trackId: null, audiobookId: null, podcastId: null, queue: null, currentIndex: 0,
            isShuffle: false, updatedAt: new Date(serverNow() + 1000).toISOString(),
        };
        await pollNow(tick());
        expect(probe.state.currentTrack).toBeNull();
    });
});

describe("another device's audiobook or podcast that the server no longer has", () => {
    const fromOtherDevice = (fields: Record<string, unknown>) => ({
        playbackType: "track", trackId: null, audiobookId: null, podcastId: null, queue: null, currentIndex: 0,
        isShuffle: false, updatedAt: new Date(Date.now() + 5000).toISOString(), ...fields,
    });

    it("is replaced by what plays here for an audiobook, and not asked for again", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.audiobookGone = true;
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("a");
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).toMatchObject({ playbackType: "track", trackId: "a" });
        await pollNow(tick());
        expect(server.saves).toHaveLength(1);
        // Never emptied first: another device that looked in between would see a cleared player and stop.
        expect(server.clears).toBe(0);
    });

    it("is replaced by what plays here for a podcast, and not asked for again", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ playbackType: "podcast", podcastId: "show:ep-1" });
        server.podcastGone = true;
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("a");
        expect(server.saves).toHaveLength(1);
        await pollNow(tick());
        expect(server.saves).toHaveLength(1);
        expect(server.clears).toBe(0);
    });

    it("is replaced by what plays here for a song, and not asked for again", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ trackId: "e", queue: [t("e"), t("f")] });
        server.trackGone = true;
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("a");
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).toMatchObject({ trackId: "a" });
        await pollNow(tick());
        expect(server.saves).toHaveLength(1);
        expect(server.clears).toBe(0);
    });

    it("is cleared from the server when nothing plays here to take its place", async () => {
        const tick = capturePoll();
        server.trackFails = true;
        await open();
        await wait(1500);
        expect(probe.state.currentTrack).toBeNull();
        server.state = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.audiobookGone = true;
        await pollNow(tick());
        expect(server.clears).toBe(1);
        expect(server.saves).toEqual([]);
        await pollNow(tick());
        expect(server.clears).toBe(1);
    });

    it("is left alone when another device saved a newer state while it was being asked for", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.audiobookGone = true;
        server.whileAsking = () => {
            server.state = fromOtherDevice({ trackId: "e", queue: [t("e"), t("f")], updatedAt: new Date(Date.now() + 9000).toISOString() });
        };
        await pollNow(tick());
        expect(server.clears).toBe(0);
        expect(server.saves).toEqual([]);
        // The newer state is looked at on the next check, as any other device's change.
        server.whileAsking = null;
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("e");
    });

    it("names the time it saw when it is replaced, and a plain save names none", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).not.toHaveProperty("expectedUpdatedAt");

        const gone = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.state = gone;
        server.audiobookGone = true;
        await pollNow(tick());
        expect(server.saves).toHaveLength(2);
        expect(server.saves[1]).toMatchObject({ trackId: "a", expectedUpdatedAt: gone.updatedAt });
    });

    it("keeps the time it saw when its save failed, so the retry is refused over a state another device saved since", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        const saved = server.saves.length;

        const gone = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.state = gone;
        server.audiobookGone = true;
        server.saveFails = true;
        await pollNow(tick());
        expect(server.saveAttempts).toBe(saved + 1);

        // Another device saves while the retry is owed; the retry still names the time it first saw.
        server.saveFails = false;
        const newer = { ...fromOtherDevice({ playbackType: "track", trackId: "e" }), updatedAt: new Date(Date.now() + 60_000).toISOString() };
        server.state = newer;
        await pollNow(tick());
        expect(server.refused.at(-1)).toMatchObject({ expectedUpdatedAt: gone.updatedAt });
        expect(server.saves).toHaveLength(saved);
        expect(server.state).toBe(newer);
    });

    it("is sent no more once the retry that kept its time has landed, not even as the page goes", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        const gone = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.state = gone;
        server.audiobookGone = true;
        server.saveFails = true;
        await pollNow(tick());
        // The retry names the time first seen, and lands while the server still holds it.
        server.saveFails = false;
        await pollNow(tick());
        expect(server.state).toMatchObject({ playbackType: "track", trackId: "a" });
        const attempts = server.saveAttempts;
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        await wait(50);
        expect(server.saveAttempts).toBe(attempts);
    }, 15_000);

    it("is not written over a state another device saved between the check and the write, which is taken up at once", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.audiobookGone = true;
        server.beforeSave = () => {
            server.beforeSave = null;
            server.state = fromOtherDevice({ trackId: "e", queue: [t("e"), t("f")], updatedAt: new Date(Date.now() + 9000).toISOString() });
        };
        await pollNow(tick());
        // The server refused the replacement and kept the other device's state; this page took it up in the same check.
        expect(server.refused).toHaveLength(1);
        expect(server.saves).toEqual([]);
        expect(server.state).toMatchObject({ trackId: "e" });
        expect(probe.state.currentTrack?.id).toBe("e");
        expect(server.clears).toBe(0);
        // Nothing is owed any more: no save of "a" follows, not even as the page goes.
        await wait(1500);
        expect(server.saves).toEqual([]);
        const attempts = server.saveAttempts;
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        await wait(50);
        expect(server.saveAttempts).toBe(attempts);
    });

    it("takes up a clear that another device made before the write, as the poll takes up a cleared state", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.audiobookGone = true;
        server.beforeSave = () => {
            server.beforeSave = null;
            server.state = null;
        };
        await pollNow(tick());
        expect(server.refused).toHaveLength(1);
        expect(server.saves).toEqual([]);
        // Nothing plays here any more, and nothing is written behind the other device's back.
        expect(probe.state.currentTrack).toBeNull();
        expect(pause).toHaveBeenCalled();
        await wait(1500);
        expect(server.saves).toEqual([]);
        expect(server.state).toBeNull();
        // The next thing played here saves as usual.
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        expect(server.saves.at(-1)).toMatchObject({ trackId: "c" });
        expect(server.saves.at(-1)).not.toHaveProperty("expectedUpdatedAt");
    });

    it("keeps a change made here, when a refusal answers that the state was cleared, and saves it", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.audiobookGone = true;
        // The replacement is held on its way; a new song is chosen here meanwhile, and the other device clears.
        let release: () => void = () => undefined;
        server.saveGate = new Promise<void>((resolve) => { release = resolve; });
        server.beforeSave = () => {
            server.beforeSave = null;
            server.state = null;
        };
        let polling: Promise<void> = Promise.resolve();
        await act(async () => {
            polling = Promise.resolve(tick()()).then(() => undefined);
        });
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        server.saveGate = null;
        await act(async () => release());
        await act(async () => polling);
        await wait(1500);
        expect(probe.state.currentTrack?.id).toBe("c");
        expect(server.saves.at(-1)).toMatchObject({ trackId: "c" });
        expect(server.state).toMatchObject({ trackId: "c" });
    }, 15_000);

    it("is not cleared over a change made here while it was being asked for, which saves as usual", async () => {
        const tick = capturePoll();
        server.trackFails = true;
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.audiobookGone = true;
        server.audiobookDelay = 300;
        let polling: Promise<void> = Promise.resolve();
        await act(async () => {
            polling = Promise.resolve(tick()()).then(() => undefined);
        });
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        await act(async () => polling);
        expect(server.clears).toBe(0);
        expect(server.saves.at(-1)).toMatchObject({ trackId: "c" });
        expect(probe.state.currentTrack?.id).toBe("c");
    });

    it("lets the next change made here save, since the server holds nothing of it", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.audiobookGone = true;
        await pollNow(tick());
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        expect(server.saves.at(-1)).toMatchObject({ trackId: "c" });
    });

    it("is not forgotten when asking for it failed for another reason", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice({ playbackType: "audiobook", audiobookId: "book" });
        server.audiobookFails = true;
        await pollNow(tick());
        expect(server.clears).toBe(0);
    });
});

describe("a save that failed", () => {
    const fromOtherDevice = () => ({
        playbackType: "track", trackId: "e", audiobookId: null, podcastId: null, queue: [t("e"), t("f")], currentIndex: 0,
        isShuffle: false, updatedAt: new Date(Date.now() + 5000).toISOString(),
    });

    async function playWhileSavesFail() {
        await open();
        await wait(1500);
        server.saveFails = true;
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
    }

    it("is sent again on the next check once the server answers", async () => {
        const tick = capturePoll();
        await playWhileSavesFail();
        server.saveFails = false;
        await pollNow(tick());
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).toMatchObject({ trackId: "c" });
    });

    it("waits longer after each failed try, so a server that stays down is not hit every check", async () => {
        const tick = capturePoll();
        await playWhileSavesFail();
        const attempts: number[] = [];
        for (let i = 0; i < 8; i++) {
            await pollNow(tick());
            attempts.push(server.saveAttempts);
        }
        // The first check retries, the next waits one check, then three, then seven.
        expect(attempts).toEqual([2, 2, 3, 3, 3, 3, 4, 4]);
    });

    it("lets another device's newer state in once the retry went through", async () => {
        const tick = capturePoll();
        await playWhileSavesFail();
        server.saveFails = false;
        await pollNow(tick());
        server.state = { ...fromOtherDevice(), updatedAt: new Date(Date.now() + 60_000).toISOString() };
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("e");
    });

    // Only a save that named a time can be refused as a conflict; a 409 to any other is a failure like a 500 is.
    it("counts a 409 to a save that named no time as a failure, and sends it again", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.saveAnswers409 = true;
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
        // Still owed: another device's state does not replace it, and the next check sends it again.
        server.state = fromOtherDevice();
        await pollNow(tick());
        expect(server.saveAttempts).toBe(2);
        expect(probe.state.currentTrack?.id).toBe("c");
        server.saveAnswers409 = false;
        await pollNow(tick());
        await pollNow(tick());
        expect(server.saves.at(-1)).toMatchObject({ trackId: "c" });
    });

    it("keeps the change here while the retries keep failing", async () => {
        const tick = capturePoll();
        await playWhileSavesFail();
        server.state = fromOtherDevice();
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("c");
    });
});

describe("a state another device cleared", () => {
    it("is written again when this device comes back to the song it had saved before", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        expect(server.state).toMatchObject({ trackId: "c" });
        server.state = null;
        await pollNow(tick());
        const saved = server.saves.length;
        // Another song and back within the wait: only the last is sent, and it is what the server (now empty) lacks.
        await act(async () => probe.controls.playTracks([t("d") as never, t("e") as never], 0));
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        expect(server.saves).toHaveLength(saved + 1);
        expect(server.state).toMatchObject({ trackId: "c" });
    });
});

describe("a read that began before this device's own save landed", () => {
    function holdReads(readsToPass = 0) {
        let release: () => void = () => undefined;
        server.readGate = new Promise<void>((resolve) => { release = resolve; });
        server.readsToPass = readsToPass;
        return () => { server.readGate = null; release(); };
    }

    it("does not make the server look empty to the poll, so the state it holds is still not sent again", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        // The server is empty when the poll asks; the answer is held on its way.
        server.state = null;
        const letGo = holdReads();
        let polling: Promise<void> = Promise.resolve();
        await act(async () => {
            polling = Promise.resolve(tick()()).then(() => undefined);
        });
        // This device saves meanwhile, so the server holds a state when the older answer reaches this page.
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
        await act(async () => letGo());
        await act(async () => polling);
        // Away from that state and back within the wait: the server has it, so nothing is sent.
        await act(async () => probe.controls.toggleShuffle());
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
    }, 15_000);

    it("does not make the server look empty when the read that settles a gone item is the older one", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = {
            playbackType: "audiobook", trackId: null, audiobookId: "book", podcastId: null, queue: null, currentIndex: 0,
            isShuffle: false, updatedAt: new Date(Date.now() + 5000).toISOString(),
        };
        server.audiobookGone = true;
        // The poll's own read answers at once; the one that settles the gone item is asked after the state was
        // cleared, and its answer ("nothing") is held on its way.
        const letGo = holdReads(1);
        server.whileAsking = () => { server.whileAsking = null; server.state = null; };
        let polling: Promise<void> = Promise.resolve();
        await act(async () => {
            polling = Promise.resolve(tick()()).then(() => undefined);
        });
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
        await act(async () => letGo());
        await act(async () => polling);
        await act(async () => probe.controls.toggleShuffle());
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
    }, 15_000);
});

describe("replies that arrive out of order", () => {
    it("never move the time this device last saw back, so the state it saved last is not taken for another device's", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        // The server's clock only moves forward, a tick per save.
        let clock = Date.now() + 1000;
        server.now = () => (clock += 10);
        let releaseFirst: () => void = () => undefined;
        server.replyGates = [new Promise<void>((resolve) => { releaseFirst = resolve; }), null];
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        // The first save is written, its reply held. As the page goes the same state is sent again beside it: written
        // later, answered at once.
        expect(server.saves).toHaveLength(1);
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        await wait(50);
        expect(server.saves).toHaveLength(2);
        const lastWritten = String(server.state?.updatedAt);
        // The older save's reply comes last.
        await act(async () => releaseFirst());
        await wait(50);
        // A state no newer than the last one written is not another device's: it is not taken up here.
        server.state = {
            playbackType: "track", trackId: "e", audiobookId: null, podcastId: null, queue: [t("e"), t("f")], currentIndex: 0,
            isShuffle: false, updatedAt: lastWritten,
        };
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("a");
    }, 15_000);
});

describe("the wait after failed saves", () => {
    it("starts over when a newer change replaces the owed save", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.saveFails = true;
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        await pollNow(tick());
        await pollNow(tick());
        await pollNow(tick());
        const failing = server.saveAttempts;
        // A newer change is sent on its own turn and fails once: its retry is not held back by the older failures.
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.saveAttempts).toBe(failing + 1);
        await pollNow(tick());
        expect(server.saveAttempts).toBe(failing + 2);
    });
});

describe("saves that overlap", () => {
    function holdSaves() {
        let release: () => void = () => undefined;
        server.saveGate = new Promise<void>((resolve) => { release = resolve; });
        return () => { server.saveGate = null; release(); };
    }

    it("go out one at a time, the newest last, so the server ends up with the newest", async () => {
        await open();
        await wait(1500);
        const letGo = holdSaves();
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
        await act(async () => probe.controls.playTracks([t("e") as never, t("f") as never], 0));
        await wait(1500);
        // The first is still on its way, so the second waits for it.
        expect(server.saveAttempts).toBe(1);
        await act(async () => letGo());
        await wait(50);
        expect(server.mostSavesInFlight).toBe(1);
        expect(server.saves.map((s) => s.trackId)).toEqual(["c", "e"]);
        expect(JSON.parse(JSON.stringify(server.state)).trackId).toBe("e");
    }, 15_000);

    it("send only the newest of several made while one is on its way", async () => {
        await open();
        await wait(1500);
        const letGo = holdSaves();
        await act(async () => probe.controls.playTracks([t("c") as never], 0));
        await wait(1500);
        await act(async () => probe.controls.playTracks([t("d") as never], 0));
        await wait(1500);
        await act(async () => probe.controls.playTracks([t("e") as never], 0));
        await wait(1500);
        await act(async () => letGo());
        await wait(50);
        expect(server.saves.map((s) => s.trackId)).toEqual(["c", "e"]);
    }, 15_000);

    it("leave a failed older save out of the count once a newer one went through", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        const letGo = holdSaves();
        server.saveFails = true;
        await act(async () => probe.controls.playTracks([t("c") as never], 0));
        await wait(1500);
        await act(async () => probe.controls.playTracks([t("e") as never], 0));
        await wait(1500);
        server.saveFails = false;
        await act(async () => letGo());
        await wait(50);
        // The older save went out while the server was failing, but the newest went through after it.
        const attempts = server.saveAttempts;
        await pollNow(tick());
        expect(server.saveAttempts).toBe(attempts);
        expect(JSON.parse(JSON.stringify(server.state)).trackId).toBe("e");
    }, 15_000);
});

describe("a change made here that undoes one still on its way", () => {
    it("is owed to the server too: a failed send of it is sent again by the next check", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        let release: () => void = () => undefined;
        server.saveGate = new Promise<void>((resolve) => { release = resolve; });
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        // Back to what the server still holds, while the save of the other song has not landed.
        await act(async () => probe.controls.playTracks([t("a") as never, t("b") as never], 0));
        await wait(1500);
        server.saveGate = null;
        server.saveFails = true;
        await act(async () => release());
        await wait(50);
        const attempts = server.saveAttempts;
        expect(attempts).toBe(2);
        server.saveFails = false;
        await pollNow(tick());
        expect(server.saveAttempts).toBe(attempts + 1);
        expect(JSON.parse(JSON.stringify(server.state)).trackId).toBe("a");
    }, 15_000);
});

describe("a page that is closing or going to the background", () => {
    it("sends a change not yet saved as the page is hidden, and not again when its wait ends", async () => {
        await open();
        await wait(1500);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        expect(server.saveAttempts).toBe(0);
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        await wait(50);
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).toMatchObject({ trackId: "c" });
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
    });

    it("asks for the keepalive only for the send made as the page goes, not for a save sent in the ordinary way", async () => {
        await open();
        await wait(1500);
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.keptAlive).toEqual([false]);
        await act(async () => probe.controls.toggleShuffle());
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        await wait(100);
        expect(server.keptAlive).toEqual([false, true]);
    });

    it("sends a change kept alive beside the save on its way as the page goes, and again behind it when neither finishes", async () => {
        await open();
        await wait(1500);
        // The save already on its way is cancelled with the page (here: it fails), so the flush sends the change itself,
        // kept alive at once and, should that fail too, in the ordinary way behind the first.
        server.saveFails = true;
        let release: () => void = () => undefined;
        server.saveGate = new Promise<void>((resolve) => { release = resolve; });
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        server.saveFails = false;
        server.saveGate = null;
        await act(async () => release());
        await wait(100);
        expect(server.keptAlive).toEqual([false, true, false]);
        expect(server.state).toMatchObject({ isShuffle: true });
    });

    it("sends a newer change as the page goes without waiting for the save on its way, which the page may not outlive", async () => {
        await open();
        await wait(1500);
        let release: () => void = () => undefined;
        server.saveGate = new Promise<void>((resolve) => { release = resolve; });
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
        // A newer change still waiting out its delay when the page goes.
        await act(async () => probe.controls.playTracks([t("e") as never, t("f") as never], 0));
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        await wait(50);
        // Sent at once, kept alive, while the first is still held.
        expect(server.saveAttempts).toBe(2);
        expect(server.keptAlive).toEqual([false, true]);
        server.saveGate = null;
        await act(async () => release());
        await wait(100);
        // The older one reached the server first; the newest is what it ends with.
        expect(server.saves.map((s) => s.trackId)).toEqual(["c", "e"]);
        expect(server.state).toMatchObject({ trackId: "e" });
    }, 15_000);

    it("sends a change that undoes the save on its way as the page goes, though the server is not yet known to hold anything else", async () => {
        await open();
        await wait(1500);
        let release: () => void = () => undefined;
        server.saveGate = new Promise<void>((resolve) => { release = resolve; });
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
        // Back to what the server held before the save on its way.
        await act(async () => probe.controls.toggleShuffle());
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        await wait(50);
        expect(server.saveAttempts).toBe(2);
        server.saveGate = null;
        await act(async () => release());
        await wait(100);
        expect(server.state).toMatchObject({ isShuffle: false });
    }, 15_000);

    it("sends a change back to what the server held, queued behind the save that undid it, as the page goes", async () => {
        await open();
        await wait(1500);
        let release: () => void = () => undefined;
        server.saveGate = new Promise<void>((resolve) => { release = resolve; });
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
        // Back to the state the server is known to hold, so nothing is flagged as owed; its wait runs out and it is
        // queued behind the save on its way, which the page may not outlive.
        await act(async () => probe.controls.toggleShuffle());
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        await wait(50);
        expect(server.saveAttempts).toBe(2);
        expect(server.keptAlive).toEqual([false, true]);
        server.saveGate = null;
        await act(async () => release());
        await wait(100);
        expect(server.state).toMatchObject({ isShuffle: false });
    }, 15_000);

    it("sends it when the tab becomes hidden, too", async () => {
        await open();
        await wait(1500);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await act(async () => setHidden(true));
        await wait(50);
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).toMatchObject({ trackId: "c" });
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
    });

    it("sends nothing when nothing is owed", async () => {
        await open();
        await wait(1500);
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        await act(async () => setHidden(true));
        await wait(50);
        expect(server.saveAttempts).toBe(0);
    });

    it("sends nothing for a change already saved", async () => {
        await open();
        await wait(1500);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        expect(server.saveAttempts).toBe(1);
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        await wait(50);
        expect(server.saveAttempts).toBe(1);
    });

    it("sends the newest state, when changes followed one another before it", async () => {
        await open();
        await wait(1500);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await act(async () => probe.controls.playTracks([t("d") as never, t("c") as never], 0));
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        await wait(50);
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).toMatchObject({ trackId: "d" });
    });

    it("sends the owed change again later if the send as the page hid failed", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.saveFails = true;
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await act(async () => window.dispatchEvent(new Event("pagehide")));
        await wait(50);
        expect(server.saveAttempts).toBe(1);
        server.saveFails = false;
        await pollNow(tick());
        expect(server.saves.at(-1)).toMatchObject({ trackId: "c" });
    });
});

describe("a tab that was hidden", () => {
    const fromOtherDevice = () => ({
        playbackType: "track", trackId: "e", audiobookId: null, podcastId: null, queue: [t("e"), t("f")], currentIndex: 0,
        isShuffle: false, updatedAt: new Date(Date.now() + 5000).toISOString(),
    });

    it("does not look at the server's state while hidden", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        await act(async () => setHidden(true));
        server.state = fromOtherDevice();
        await pollNow(tick());
        expect(probe.state.currentTrack?.id).toBe("a");
    });

    it("looks at the server's state at once when shown again", async () => {
        await open();
        await wait(1500);
        await act(async () => setHidden(true));
        server.state = fromOtherDevice();
        await act(async () => setHidden(false));
        await wait(50);
        expect(probe.state.currentTrack?.id).toBe("e");
    });

    it("sends a change made here at once when shown again, without waiting for the debounce", async () => {
        await open();
        await wait(1500);
        await act(async () => setHidden(true));
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await act(async () => setHidden(false));
        await wait(50);
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).toMatchObject({ trackId: "c" });
        // The debounced save that follows finds it already sent.
        await wait(1500);
        expect(server.saves).toHaveLength(1);
    });

    it("sends a failed save again at once when shown, whatever the wait it was on", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.saveFails = true;
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        for (let i = 0; i < 3; i++) await pollNow(tick());
        server.saveFails = false;
        await act(async () => setHidden(true));
        await act(async () => setHidden(false));
        await wait(50);
        expect(server.saves).toHaveLength(1);
        expect(server.saves[0]).toMatchObject({ trackId: "c" });
    });

    it("counts one failed try for a save the tab being shown sent early, not two", async () => {
        await open();
        await wait(1500);
        server.saveFails = true;
        await act(async () => setHidden(true));
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await act(async () => setHidden(false));
        await wait(1500);
        // The debounced save that follows finds the early one already sent and does not send it again.
        expect(server.saveAttempts).toBe(1);
    });

    it("is not lost when a check was already running as the tab was shown", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = { ...fromOtherDevice(), playbackType: "audiobook", trackId: null, queue: null, audiobookId: "book" };
        server.audiobook = { id: "book", title: "Book" };
        server.audiobookDelay = 300;
        const readsBefore = server.stateReads;
        let polling: Promise<void> = Promise.resolve();
        await act(async () => {
            polling = Promise.resolve(tick()()).then(() => undefined);
        });
        await act(async () => setHidden(true));
        await act(async () => setHidden(false));
        await act(async () => polling);
        await wait(500);
        // The check that was running, then the one the shown tab asked for.
        expect(server.stateReads - readsBefore).toBe(2);
    });

    it("keeps one 30-second check running through a change of song", async () => {
        const spy = vi.spyOn(globalThis, "setInterval");
        const checks = () => spy.mock.calls.filter((call) => call[1] === 30000).length;
        await open();
        await wait(1500);
        const before = checks();
        expect(before).toBeGreaterThan(0);
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await wait(1500);
        await act(async () => probe.controls.playTracks([t("e") as never], 0));
        await wait(1500);
        expect(checks()).toBe(before);
    });

    it("drops a check that outlived a change made here", async () => {
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = fromOtherDevice();
        server.trackDelay = 300;
        let polling: Promise<void> = Promise.resolve();
        await act(async () => {
            polling = Promise.resolve(tick()()).then(() => undefined);
        });
        await act(async () => probe.controls.playTracks([t("c") as never, t("d") as never], 0));
        await act(async () => polling);
        expect(probe.state.currentTrack?.id).toBe("c");
    });
});

describe("another device's state that names no song", () => {
    const queueOnly = () => ({
        playbackType: "track", trackId: null, audiobookId: null, podcastId: null, queue: [t("x"), t("y")], currentIndex: 1,
        isShuffle: false, updatedAt: new Date(Date.now() + 5000).toISOString(),
    });

    it("puts its queue here when nothing plays here", async () => {
        server.state = null;
        const tick = capturePoll();
        await open();
        await wait(1500);
        expect(probe.state.currentTrack).toBeNull();
        server.state = queueOnly();
        await pollNow(tick());
        expect(probe.state.queue.map((q) => q.id)).toEqual(["x", "y"]);
        expect(probe.state.currentTrack).toBeNull();
        expect(server.saves).toEqual([]);
    });

    it("leaves an audiobook playing here alone", async () => {
        server.state = { playbackType: "audiobook", audiobookId: "book", queue: null, currentIndex: 0, isShuffle: false, updatedAt: new Date(Date.now() - 60_000).toISOString() };
        server.audiobook = { id: "book", title: "Book" };
        const tick = capturePoll();
        await open();
        await wait(1500);
        server.state = queueOnly();
        await pollNow(tick());
        expect(probe.state.currentAudiobook?.id).toBe("book");
        expect(probe.state.queue).toEqual([]);
        expect(server.saves).toEqual([]);
    });
});
