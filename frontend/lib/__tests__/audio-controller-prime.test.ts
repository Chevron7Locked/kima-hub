import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AudioController } from "../audio-controller";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
// vitest.config.ts runs this suite under environment: "node", so document /
// window / navigator / localStorage do not exist unless stubbed per-test.
// AudioController references several of them as bare globals (not window.x),
// so each must be stubbed individually via vi.stubGlobal.

class MockAudioContext {
    static throwOnStart = false;
    static instances: MockAudioContext[] = [];

    state = "running";
    sampleRate = 44100;
    destination = {};
    startCallCount = 0;
    createBufferCallCount = 0;
    createBufferSourceCallCount = 0;

    constructor() {
        MockAudioContext.instances.push(this);
    }

    createBuffer() {
        this.createBufferCallCount++;
        return {};
    }

    createBufferSource() {
        this.createBufferSourceCallCount++;
        return {
            buffer: null as unknown,
            connect() {},
            start: () => {
                this.startCallCount++;
                if (MockAudioContext.throwOnStart) {
                    throw new Error("mock start failure");
                }
            },
        };
    }

    createMediaElementSource() {
        return { connect(_dest?: unknown) {} };
    }

    createAnalyser() {
        return {
            fftSize: 0,
            connect() {},
            getByteTimeDomainData(buf: Uint8Array) {
                buf.fill(128);
            },
        };
    }

    resume() {
        return Promise.resolve();
    }

    close() {
        return Promise.resolve();
    }

    addEventListener() {}
    removeEventListener() {}
}

function createFakeAudioElement() {
    return {
        preload: "",
        src: "",
        currentTime: 0,
        duration: 0,
        paused: true,
        volume: 1,
        muted: false,
        readyState: 0,
        error: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
        load: vi.fn(),
        removeAttribute: vi.fn(),
    };
}

type DocListeners = Record<string, Array<() => void>>;

function installEnv(opts: {
    userAgent: string;
    maxTouchPoints: number;
    standalone: boolean;
}) {
    const docListeners: DocListeners = {};
    const fakeDocument = {
        visibilityState: "visible",
        hasFocus: () => true,
        addEventListener(type: string, handler: () => void) {
            (docListeners[type] ??= []).push(handler);
        },
        removeEventListener(type: string, handler: () => void) {
            docListeners[type] = (docListeners[type] || []).filter((h) => h !== handler);
        },
    };

    const fakeWindow = {
        AudioContext: MockAudioContext,
        matchMedia: () => ({ matches: false }),
    };

    const fakeNavigator: Record<string, unknown> = {
        userAgent: opts.userAgent,
        maxTouchPoints: opts.maxTouchPoints,
        standalone: opts.standalone,
        audioSession: { type: "idle" },
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

    return { docListeners, navigator: fakeNavigator };
}

const IPHONE_STANDALONE = {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15",
    maxTouchPoints: 5,
    standalone: true,
};

const DESKTOP_NON_IOS = {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    maxTouchPoints: 0,
    standalone: false,
};

const IPAD_STANDALONE_MAC_UA = {
    // Modern iPadOS Safari reports a desktop Mac UA; only maxTouchPoints
    // distinguishes it from a real Mac.
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15",
    maxTouchPoints: 2,
    standalone: true,
};

const MAC_DESKTOP_NO_TOUCH = {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15",
    maxTouchPoints: 0,
    standalone: true,
};

const ANDROID_STANDALONE = {
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
    maxTouchPoints: 5,
    standalone: true,
};

beforeEach(() => {
    MockAudioContext.throwOnStart = false;
    MockAudioContext.instances = [];
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. unlockOnce retry-on-throw (F1 regression guard)
// ---------------------------------------------------------------------------

describe("AudioController.prime() -- unlockOnce retry-on-throw", () => {
    it("retries the silent-buffer unlock on every prime() call while it throws, and latches only after a successful attempt", () => {
        installEnv(IPHONE_STANDALONE);
        MockAudioContext.throwOnStart = true;

        const audio = createFakeAudioElement();
        const controller = new AudioController(audio as unknown as HTMLAudioElement);

        controller.prime();
        const ctx = MockAudioContext.instances[0];
        expect(ctx).toBeDefined();
        expect(ctx.startCallCount).toBe(1);

        // Second prime() call: the first attempt threw, so the latch must NOT
        // be set -- a retryable failure means every later gesture tries again.
        controller.prime();
        expect(ctx.startCallCount).toBe(2);

        // Now let the attempt succeed.
        MockAudioContext.throwOnStart = false;
        controller.prime();
        expect(ctx.startCallCount).toBe(3);

        // Latched: further prime() calls must not attempt the unlock again.
        controller.prime();
        expect(ctx.startCallCount).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// 2. prime() is inert off-iOS
// ---------------------------------------------------------------------------

describe("AudioController.prime() -- inert off-iOS", () => {
    it("does not claim the audio session, create an AudioContext, or throw on a non-iOS-standalone environment", () => {
        const { navigator } = installEnv(DESKTOP_NON_IOS);

        const audio = createFakeAudioElement();
        const controller = new AudioController(audio as unknown as HTMLAudioElement);

        expect(() => controller.prime()).not.toThrow();

        // setAudioSessionPlayback(true) would flip this to "playback" if the
        // isIosStandalone() gate at the top of prime() were removed.
        expect((navigator.audioSession as { type: string }).type).toBe("idle");
        expect(MockAudioContext.instances.length).toBe(0);
    });

    it("a pointerdown gesture on a non-iOS page does not create an AudioContext", () => {
        const { docListeners } = installEnv(DESKTOP_NON_IOS);

        const audio = createFakeAudioElement();
        new AudioController(audio as unknown as HTMLAudioElement);

        expect(docListeners["pointerdown"]?.length).toBeGreaterThan(0);
        docListeners["pointerdown"].forEach((h) => h());

        expect(MockAudioContext.instances.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 3. iPad detection (maxTouchPoints > 1 && Macintosh UA)
// ---------------------------------------------------------------------------

describe("AudioController.prime() -- iPad detection", () => {
    it("acts on an iPad reporting a Mac UA with maxTouchPoints > 1", () => {
        installEnv(IPAD_STANDALONE_MAC_UA);

        const audio = createFakeAudioElement();
        const controller = new AudioController(audio as unknown as HTMLAudioElement);
        controller.prime();

        expect(MockAudioContext.instances.length).toBe(1);
    });

    it("does not act on a real Mac desktop (Mac UA, maxTouchPoints = 0)", () => {
        installEnv(MAC_DESKTOP_NO_TOUCH);

        const audio = createFakeAudioElement();
        const controller = new AudioController(audio as unknown as HTMLAudioElement);
        controller.prime();

        expect(MockAudioContext.instances.length).toBe(0);
    });

    it("does not act on an Android device even with a high touch-point count", () => {
        installEnv(ANDROID_STANDALONE);

        const audio = createFakeAudioElement();
        const controller = new AudioController(audio as unknown as HTMLAudioElement);
        controller.prime();

        expect(MockAudioContext.instances.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 4. ensureContextRunning: non-blocking resume-confirmation retry (C2)
// ---------------------------------------------------------------------------

class FlippingAudioContext extends MockAudioContext {
    resumeCallCount = 0;
    private flipAfter: number;

    constructor(flipAfter: number) {
        super();
        this.flipAfter = flipAfter;
        this.state = "suspended";
    }

    resume() {
        this.resumeCallCount++;
        if (this.resumeCallCount >= this.flipAfter) {
            this.state = "running";
        }
        return Promise.resolve();
    }
}

type ControllerInternals = {
    audioContext: unknown;
    ensureContextRunning: (attempt?: number) => void;
};

describe("AudioController -- ensureContextRunning (C2)", () => {
    it("stops retrying once the context reaches running", () => {
        vi.useFakeTimers();
        installEnv(IPHONE_STANDALONE);

        const audio = createFakeAudioElement();
        const controller = new AudioController(audio as unknown as HTMLAudioElement);
        const ctx = new FlippingAudioContext(2);
        const internals = controller as unknown as ControllerInternals;
        internals.audioContext = ctx;

        internals.ensureContextRunning();
        expect(ctx.resumeCallCount).toBe(1);
        expect(ctx.state).toBe("suspended");

        vi.advanceTimersByTime(150);
        expect(ctx.resumeCallCount).toBe(2);
        expect(ctx.state).toBe("running");

        // The next scheduled retry sees state === "running" and returns
        // immediately -- no further resume() calls, ever.
        vi.advanceTimersByTime(10000);
        expect(ctx.resumeCallCount).toBe(2);
    });

    it("caps retries at 3 attempts when the context never reaches running", () => {
        vi.useFakeTimers();
        installEnv(IPHONE_STANDALONE);

        const audio = createFakeAudioElement();
        const controller = new AudioController(audio as unknown as HTMLAudioElement);
        const ctx = new FlippingAudioContext(Infinity);
        const internals = controller as unknown as ControllerInternals;
        internals.audioContext = ctx;

        internals.ensureContextRunning();
        expect(ctx.resumeCallCount).toBe(1);

        vi.advanceTimersByTime(150);
        expect(ctx.resumeCallCount).toBe(2);

        vi.advanceTimersByTime(300);
        expect(ctx.resumeCallCount).toBe(3);

        // attempt=3 hits the cap and returns without calling resume() again.
        vi.advanceTimersByTime(450);
        expect(ctx.resumeCallCount).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// 5. Analyser wiring and bridge-latch ordering (F-A)
// ---------------------------------------------------------------------------

type AnalyserInternals = {
    analyser: unknown;
    audioContextBridgeAttempted: boolean;
};

describe("AudioController -- analyser wiring and bridge latch ordering (F-A)", () => {
    it("wires a non-null analyser after prime() on iPhone-standalone", () => {
        installEnv(IPHONE_STANDALONE);

        const audio = createFakeAudioElement();
        const controller = new AudioController(audio as unknown as HTMLAudioElement);
        controller.prime();

        const internals = controller as unknown as AnalyserInternals;
        expect(internals.analyser).not.toBeNull();
        expect(MockAudioContext.instances.length).toBe(1);
    });

    it("a throw in createMediaElementSource leaves the bridge latch false and retryable", () => {
        let shouldThrow = true;
        class ThrowingMediaSourceContext extends MockAudioContext {
            createMediaElementSource() {
                if (shouldThrow) {
                    shouldThrow = false;
                    throw new Error("mock media source failure");
                }
                return super.createMediaElementSource();
            }
        }

        installEnv(IPHONE_STANDALONE);
        vi.stubGlobal("window", {
            AudioContext: ThrowingMediaSourceContext,
            matchMedia: () => ({ matches: false }),
        });

        const audio = createFakeAudioElement();
        const controller = new AudioController(audio as unknown as HTMLAudioElement);
        const internals = controller as unknown as AnalyserInternals;

        controller.prime();
        // The throw happened before routing completed -- latch must stay false.
        expect(internals.audioContextBridgeAttempted).toBe(false);
        expect(internals.analyser).toBeNull();

        // A later gesture retries and this time succeeds.
        controller.prime();
        expect(internals.audioContextBridgeAttempted).toBe(true);
        expect(internals.analyser).not.toBeNull();
    });

    it("an analyser failure still routes audio to the destination and latches the bridge", () => {
        class ThrowingAnalyserContext extends MockAudioContext {
            mediaSourceConnectedTo: unknown[] = [];
            createMediaElementSource() {
                return {
                    connect: (dest: unknown) => {
                        this.mediaSourceConnectedTo.push(dest);
                    },
                };
            }
            createAnalyser(): never {
                throw new Error("mock analyser failure");
            }
        }

        installEnv(IPHONE_STANDALONE);
        vi.stubGlobal("window", {
            AudioContext: ThrowingAnalyserContext,
            matchMedia: () => ({ matches: false }),
        });

        const audio = createFakeAudioElement();
        const controller = new AudioController(audio as unknown as HTMLAudioElement);
        controller.prime();

        const internals = controller as unknown as AnalyserInternals;
        expect(internals.analyser).toBeNull();
        // Bridge still latches -- the analyser is an enhancement, not load-bearing.
        expect(internals.audioContextBridgeAttempted).toBe(true);

        const ctx = MockAudioContext.instances[
            MockAudioContext.instances.length - 1
        ] as unknown as ThrowingAnalyserContext;
        expect(ctx.mediaSourceConnectedTo).toEqual([ctx.destination]);
    });
});

// ---------------------------------------------------------------------------
// 6. checkSilentPlayback -- C3 running-but-silent detector (F-B)
// ---------------------------------------------------------------------------
//
// These tests call the private checkSilentPlayback() directly (via cast)
// rather than driving it through the real setInterval ticker. Both the C3
// silent-audio detector and the unrelated stall/recovery ladder key off the
// same audio.currentTime signal via the "tick" policy event, so exercising
// them together (e.g. a frozen currentTime for 5+ seconds) trips the ladder's
// own stall escalation first and makes it impossible to isolate the detector.
// Calling checkSilentPlayback() directly still exercises the exact streak/
// arm-window/advancing-clock logic under test and fails under mutation of
// any of those three gates.

type SilentDetectorInternals = {
    dispatch(event: { type: string; now: number }): void;
    checkSilentPlayback(): void;
    analyser: { getByteTimeDomainData: (buf: Uint8Array) => void } | null;
};

function primeToPlaying(audio: ReturnType<typeof createFakeAudioElement>) {
    const controller = new AudioController(audio as unknown as HTMLAudioElement);
    controller.prime();
    controller.load("http://x.com/a.mp3");
    audio.paused = false;
    (controller as unknown as SilentDetectorInternals).dispatch({
        type: "native-playing",
        now: Date.now(),
    });
    return controller;
}

function fillFlat(buf: Uint8Array) {
    buf.fill(128);
}

function fillNoisy(buf: Uint8Array) {
    for (let i = 0; i < buf.length; i++) {
        buf[i] = i % 2 === 0 ? 0 : 255;
    }
}

describe("AudioController -- checkSilentPlayback (C3 / F-B)", () => {
    it("5 consecutive silent ticks with an advancing clock -> silent-playback-detected -> status blocked", () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        installEnv(IPHONE_STANDALONE);

        const audio = createFakeAudioElement();
        const controller = primeToPlaying(audio);
        const internals = controller as unknown as SilentDetectorInternals;
        expect(controller.getSnapshot().status).toBe("playing");

        for (let i = 1; i <= 5; i++) {
            audio.currentTime = i;
            vi.setSystemTime(i * 1000);
            internals.checkSilentPlayback();
        }

        expect(controller.getSnapshot().status).toBe("blocked");
    });

    it("varied/noisy data never fires, even with an advancing clock inside the arm window", () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        installEnv(IPHONE_STANDALONE);

        const audio = createFakeAudioElement();
        const controller = primeToPlaying(audio);
        const internals = controller as unknown as SilentDetectorInternals;
        internals.analyser!.getByteTimeDomainData = fillNoisy;

        for (let i = 1; i <= 10; i++) {
            audio.currentTime = i;
            vi.setSystemTime(i * 1000);
            internals.checkSilentPlayback();
        }

        expect(controller.getSnapshot().status).toBe("playing");
    });

    it("not armed (past the 15s window) -> never fires even with flat-silent data and an advancing clock", () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        installEnv(IPHONE_STANDALONE);

        const audio = createFakeAudioElement();
        const controller = primeToPlaying(audio);
        const internals = controller as unknown as SilentDetectorInternals;
        internals.analyser!.getByteTimeDomainData = fillFlat;

        // Jump past the 15s arm window before any silent ticks are fed.
        for (let i = 1; i <= 5; i++) {
            audio.currentTime = 20 + i;
            vi.setSystemTime(16000 + i * 1000);
            internals.checkSilentPlayback();
        }

        expect(controller.getSnapshot().status).toBe("playing");
    });

    it("clock not advancing -> never fires even with flat-silent data inside the arm window", () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        installEnv(IPHONE_STANDALONE);

        const audio = createFakeAudioElement();
        const controller = primeToPlaying(audio);
        const internals = controller as unknown as SilentDetectorInternals;

        // currentTime frozen at its post-load() value -- "advanced" never
        // becomes true, so the streak never accumulates.
        for (let i = 1; i <= 10; i++) {
            vi.setSystemTime(i * 1000);
            internals.checkSilentPlayback();
        }

        expect(controller.getSnapshot().status).toBe("playing");
    });
});
