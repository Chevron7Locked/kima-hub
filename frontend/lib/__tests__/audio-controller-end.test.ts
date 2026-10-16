import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AudioController } from "../audio-controller";

// Fakes for the dual-element gapless swap, which is not iOS-gated, so a desktop
// UA is used. Browser globals are stubbed per test.

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

beforeEach(() => {
    vi.useRealTimers();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/**
 * A browser reaching the end of a file fires "pause" and then "ended". The pause is part of ending, not a pause:
 * the app's "ended" handler (which saves a podcast or audiobook as finished) must run before anything hears
 * "paused", or a not-finished save goes out first and can land last.
 */
describe("AudioController -- the end of a file", () => {
    it("announces the end before any listener sees it paused", async () => {
        const { controller, audio } = newController();
        const heard: string[] = [];
        controller.subscribe((snap) => heard.push(`status:${snap.status}`));
        controller.on("ended", () => heard.push("ended"));

        controller.load("http://x.com/episode.mp3", { autoplay: true });
        audio.duration = 120;
        audio.__fire("canplay");
        audio.paused = false;
        audio.__fire("playing");
        await flushMicrotasks();
        expect(controller.getSnapshot().status).toBe("playing");
        heard.length = 0;

        // What the element does at the end: paused and ended both true, then "pause", then "ended".
        audio.currentTime = 120;
        audio.paused = true;
        audio.ended = true;
        audio.__fire("pause");
        audio.__fire("ended");

        expect(heard.indexOf("ended")).toBeGreaterThanOrEqual(0);
        const firstPaused = heard.indexOf("status:paused");
        expect(firstPaused === -1 || firstPaused > heard.indexOf("ended")).toBe(true);
    });

    it("still treats a pause before the end as a pause", async () => {
        const { controller, audio } = newController();
        controller.load("http://x.com/episode.mp3", { autoplay: true });
        audio.duration = 120;
        audio.__fire("canplay");
        audio.paused = false;
        audio.__fire("playing");
        await flushMicrotasks();

        audio.currentTime = 40;
        audio.paused = true;
        audio.__fire("pause");

        expect(controller.getSnapshot().status).toBe("paused");
    });

    it("knows it ended, and a pause asked for after the end does not swallow the next real pause", async () => {
        const { controller, audio } = newController();
        controller.load("http://x.com/a.mp3", { autoplay: true });
        audio.duration = 120;
        audio.__fire("canplay");
        audio.paused = false;
        audio.__fire("playing");
        await flushMicrotasks();

        audio.currentTime = 120;
        audio.paused = true;
        audio.ended = true;
        audio.__fire("pause");
        audio.__fire("ended");
        expect(controller.hasEnded()).toBe(true);
        // The app pauses at the end of a show; the element is already paused and fires nothing.
        controller.pause();

        controller.load("http://x.com/b.mp3", { autoplay: true });
        audio.ended = false;
        audio.duration = 120;
        audio.__fire("canplay");
        audio.paused = false;
        audio.__fire("playing");
        await flushMicrotasks();
        expect(controller.hasEnded()).toBe(false);

        // An earbud pause mid-file.
        audio.currentTime = 30;
        audio.paused = true;
        audio.__fire("pause");
        expect(controller.getSnapshot().status).toBe("paused");
    });
});
