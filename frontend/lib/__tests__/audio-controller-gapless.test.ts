import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AudioController } from "../audio-controller";

// ---------------------------------------------------------------------------
// Fakes -- deliberately simpler than audio-controller-prime.test.ts's: these
// tests exercise the dual-element gapless swap, which is NOT iOS-gated
// (INV-2/4: both elements are bare off-iOS), so a plain desktop UA is used
// throughout. vitest.config.ts runs this suite under environment: "node", so
// document/window/navigator/localStorage must be stubbed per-test.
// ---------------------------------------------------------------------------

function createFakeAudioElement() {
    const listeners: Record<string, Array<() => void>> = {};
    return {
        preload: "",
        crossOrigin: "",
        src: "",
        currentTime: 0,
        duration: 0,
        paused: true,
        ended: false,
        volume: 1,
        muted: false,
        readyState: 0,
        error: null as { code?: number; message?: string } | null,
        style: {} as Record<string, string>,
        setAttribute: vi.fn(),
        addEventListener: vi.fn((event: string, handler: () => void) => {
            (listeners[event] ??= []).push(handler);
        }),
        removeEventListener: vi.fn((event: string, handler: () => void) => {
            listeners[event] = (listeners[event] || []).filter((h) => h !== handler);
        }),
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
        load: vi.fn(),
        removeAttribute: vi.fn(),
        remove: vi.fn(),
        // Test helper, not part of the real element API.
        __fire(event: string) {
            (listeners[event] || []).slice().forEach((h) => h());
        },
    };
}

type FakeAudioElement = ReturnType<typeof createFakeAudioElement>;

function installEnv(): { created: FakeAudioElement[] } {
    const created: FakeAudioElement[] = [];
    const fakeDocument = {
        visibilityState: "visible",
        hasFocus: () => true,
        createElement: (_tag: string) => {
            const el = createFakeAudioElement();
            created.push(el);
            return el;
        },
        body: { appendChild: vi.fn() },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
    const fakeWindow = {
        matchMedia: () => ({ matches: false }),
    };
    const fakeNavigator = {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        maxTouchPoints: 0,
        standalone: false,
    };
    const fakeLocalStorage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
    };

    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("navigator", fakeNavigator);
    vi.stubGlobal("localStorage", fakeLocalStorage);

    return { created };
}

// The constructor creates `this.audio` (main) then `this.audioNext` (next),
// in that order -- pull both real created elements back out.
function newController(): {
    controller: AudioController;
    audio: FakeAudioElement;
    audioNext: FakeAudioElement;
} {
    const { created } = installEnv();
    const controller = new AudioController();
    return { controller, audio: created[0], audioNext: created[1] };
}

// Flush the microtask queue enough times for a resolved/rejected play()
// promise's .then()/.catch() to have run.
async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

type ControllerInternals = {
    audio: FakeAudioElement;
    audioNext: FakeAudioElement;
    preloadedTrackId: string | null;
    expectedNextTrackId: string | null;
    idleReady: boolean;
    armDetectorUntil: number;
    silentStreak: number;
    rebuildCount: number;
};

function internals(controller: AudioController): ControllerInternals {
    return controller as unknown as ControllerInternals;
}

// Sets up an eligible preload: preloadNext() + a canplay on the idle element.
function makeEligible(
    controller: AudioController,
    audioNext: FakeAudioElement,
    trackId: string,
    url: string,
    durationS: number,
): void {
    controller.setUpcoming2B(url, trackId, durationS);
    controller.preloadNext();
    audioNext.duration = durationS;
    audioNext.__fire("canplay");
}

beforeEach(() => {
    vi.useRealTimers();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Eligible swap
// ---------------------------------------------------------------------------

describe("AudioController -- gapless swap: eligible", () => {
    it("on ended: swaps to the idle element synchronously in the play() call, then commits pointers/listeners/detector on resolve, emits gapless-advance, and never dispatches native-ended", async () => {
        const { controller, audio, audioNext } = newController();

        const endedCb = vi.fn();
        const gaplessCb = vi.fn();
        controller.on("ended", endedCb);
        controller.on("gapless-advance", gaplessCb);

        makeEligible(controller, audioNext, "track-2", "http://x.com/b.mp3", 210);

        // The swap `.play()` call must happen synchronously inside the native
        // `ended` tail (INV-1) -- assert it fired before any microtask flush.
        audio.__fire("ended");
        expect(audioNext.play).toHaveBeenCalledTimes(1);

        await flushMicrotasks();

        const snap = controller.getSnapshot();
        expect(snap.status).toBe("playing");
        expect(snap.src).toBe("http://x.com/b.mp3");
        expect(snap.duration).toBe(210);

        // Pointers swapped: the former idle fake is now the active element,
        // the former active fake is now the idle element.
        const state = internals(controller);
        expect(state.audio).toBe(audioNext);
        expect(state.audioNext).toBe(audio);

        // Old active element reused as idle -- torn down and re-synced.
        expect(audio.pause).toHaveBeenCalled();
        expect(audio.removeAttribute).toHaveBeenCalledWith("src");
        expect(audio.load).toHaveBeenCalled();

        // Preload bookkeeping cleared post-swap.
        expect(state.preloadedTrackId).toBeNull();
        expect(state.expectedNextTrackId).toBeNull();
        expect(state.idleReady).toBe(false);

        // Detector re-armed for the new active element.
        expect(state.armDetectorUntil).toBeGreaterThan(Date.now() - 1000);
        expect(state.silentStreak).toBe(0);
        expect(state.rebuildCount).toBe(0);

        // React layer notified via gapless-advance; native "ended" must NOT fire
        // (that would imply a cold-load fallback, defeating the whole point).
        expect(gaplessCb).toHaveBeenCalledTimes(1);
        expect(gaplessCb).toHaveBeenCalledWith({ durationS: 210, trackId: "track-2" });
        expect(endedCb).not.toHaveBeenCalled();
    });

    it("carries the current volume/mute onto the reused idle element (FIX B)", async () => {
        const { controller, audio, audioNext } = newController();

        controller.setVolume(0.4);
        // Both elements immediately carry the volume (FIX B, site 1).
        expect(audioNext.volume).toBe(0.4);

        makeEligible(controller, audioNext, "track-2", "http://x.com/b.mp3", 100);

        // Poison the element that will become the reused idle -- setVolume(0.4)
        // above already wrote 0.4 onto it, so without this the test would pass
        // even if the swap-time re-sync lines (FIX B) were deleted.
        audio.volume = 1;
        audio.muted = true;

        audio.__fire("ended");
        await flushMicrotasks();

        // `audio` (the fake) is now the reused idle element -- must carry the
        // controller's tracked volume/mute, not the poisoned values.
        expect(audio.volume).toBe(0.4);
        expect(audio.muted).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Not eligible -> native-ended fallthrough
// ---------------------------------------------------------------------------

describe("AudioController -- gapless swap: not eligible", () => {
    it("falls through to native-ended (honest end -> paused + emit-ended) and never touches the idle element", () => {
        const { controller, audio, audioNext } = newController();
        const endedCb = vi.fn();
        controller.on("ended", endedCb);

        // No preload set up at all.
        audio.currentTime = 100;
        audio.duration = 100;
        audio.__fire("ended");

        expect(audioNext.play).not.toHaveBeenCalled();
        expect(controller.getSnapshot().status).toBe("paused");
        expect(endedCb).toHaveBeenCalledTimes(1);
    });

    it("preloadedTrackId mismatching expectedNextTrackId is not eligible", () => {
        const { controller, audio, audioNext } = newController();

        controller.setUpcoming2B("http://x.com/b.mp3", "track-2", 100);
        controller.preloadNext();
        audioNext.duration = 100;
        audioNext.__fire("canplay");

        // Queue mutated after the preload was issued -- now expecting a
        // different track than what was actually buffered.
        controller.setUpcoming2B("http://x.com/c.mp3", "track-3", 120);

        audio.currentTime = 100;
        audio.duration = 100;
        audio.__fire("ended");

        expect(audioNext.play).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Swap play() rejection -> native-ended fallthrough (no dead air)
// ---------------------------------------------------------------------------

describe("AudioController -- gapless swap: play() rejection", () => {
    it("falls through to native-ended without any partial mutation (FIX A ordering)", async () => {
        const { controller, audio, audioNext } = newController();
        const endedCb = vi.fn();
        controller.on("ended", endedCb);

        audioNext.play = vi.fn().mockRejectedValue(
            Object.assign(new Error("boom"), { name: "NotAllowedError" }),
        );

        makeEligible(controller, audioNext, "track-2", "http://x.com/b.mp3", 100);

        audio.currentTime = 50;
        audio.duration = 50;
        audio.__fire("ended");

        await flushMicrotasks();

        // Nothing was mutated before the rejection landed -- pointers unchanged.
        const state = internals(controller);
        expect(state.audio).toBe(audio);
        expect(state.audioNext).toBe(audioNext);

        // Fallback ran the ordinary honest-ended path.
        expect(controller.getSnapshot().status).toBe("paused");
        expect(endedCb).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// repeat-one: no swap
// ---------------------------------------------------------------------------

describe("AudioController -- gapless swap: repeat-one suppression", () => {
    it("clearUpcoming2B() (the React layer's repeat-one guard) closes the eligibility gate even with a ready idle buffer", () => {
        const { controller, audio, audioNext } = newController();

        makeEligible(controller, audioNext, "track-2", "http://x.com/b.mp3", 100);

        // Simulates the audio-controls-context effect that fires when
        // repeatMode -> "one": the preload is no longer a valid next track.
        controller.clearUpcoming2B();

        audio.currentTime = 100;
        audio.duration = 100;
        audio.__fire("ended");

        expect(audioNext.play).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Generation guard: a manual skip / ctrl.load() races the swap's play() (FIX 4)
// ---------------------------------------------------------------------------

describe("AudioController -- gapless swap: generation guard", () => {
    it("aborts the commit if generation changed between the synchronous play() call and its promise resolving", async () => {
        const { controller, audio, audioNext } = newController();
        const gaplessCb = vi.fn();
        controller.on("gapless-advance", gaplessCb);

        makeEligible(controller, audioNext, "track-2", "http://x.com/b.mp3", 100);

        audio.__fire("ended");
        expect(audioNext.play).toHaveBeenCalledTimes(1);

        // A manual skip / ctrl.load() lands before the swap's play() promise
        // resolves -- this bumps `generation` via the "load" transition and
        // applies its own set-src-and-load to the pre-flip `this.audio`.
        controller.load("http://x.com/manual-skip.mp3");

        await flushMicrotasks();

        // Commit must be aborted: pointers unchanged, no gapless-advance
        // emitted, and the started idle-swap element gets paused so it
        // doesn't play over the intervening track.
        const state = internals(controller);
        expect(state.audio).toBe(audio);
        expect(state.audioNext).toBe(audioNext);
        expect(gaplessCb).not.toHaveBeenCalled();
        expect(audioNext.pause).toHaveBeenCalled();
    });
});
