import { vi } from "vitest";
import { AudioController } from "../../audio-controller";

// Fakes for the audio controller's two <audio> elements on a desktop browser. Browser globals are stubbed per test;
// a test's afterEach calls vi.unstubAllGlobals().

export function createFakeAudioElement() {
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

export type FakeAudioElement = ReturnType<typeof createFakeAudioElement>;

export function installEnv(): { created: FakeAudioElement[] } {
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
export function newController(): {
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
export async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}
