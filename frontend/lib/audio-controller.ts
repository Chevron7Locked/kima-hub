"use client";

import { iosAudioLog } from "./iosAudioLog";
import type {
    EngineStatus,
    PauseClass,
    TimerId,
    EngineSnapshot,
    EngineEvent,
    Effect,
} from "./audio-engine-policy";
import { initialSnapshot, transition } from "./audio-engine-policy";

// Re-export types consumers may need
export type { EngineStatus, PauseClass, EngineSnapshot };

type ExternalEvent = "ended" | "timeupdate" | "canplay" | "seeked" | "error";
type ExternalCallback = (data?: unknown) => void;

const TICKER_INTERVAL_MS = 1000;

export class AudioController {
    private audio: HTMLAudioElement;
    private audioSessionSet = false;

    // State machine
    private snapshot: EngineSnapshot;
    private subscribers: Set<(snap: EngineSnapshot) => void> = new Set();

    // External event listeners (ended / timeupdate / canplay / seeked / error)
    private externalListeners: Map<ExternalEvent, Set<ExternalCallback>> = new Map();

    // Native element listeners for cleanup
    private nativeListeners: Array<{ event: string; handler: EventListener }> = [];

    // Timers keyed by TimerId
    private timers: Map<TimerId, ReturnType<typeof setTimeout>> = new Map();

    // 1s ticker
    private tickerInterval: ReturnType<typeof setInterval> | null = null;

    // Tracks whether the last pause event was caused by our own call-pause effect
    private expectingPause = false;

    // Volume / mute
    private volume = 1;
    private isMuted = false;

    // iOS standalone PWA audio session bridge. iOS WKWebView suspends the
    // HTMLAudioElement's audio session when backgrounded; MediaSession reports
    // "playing" but no sound. Routing the element through an AudioContext
    // keeps the iOS audio session active across backgrounding because the
    // AudioContext claims it more durably than a bare <audio>.
    // WebKit #261858. Bridge set up lazily on the first user-gesture play.
    private audioContext: AudioContext | null = null;
    private mediaSourceNode: MediaElementAudioSourceNode | null = null;
    private audioContextBridgeAttempted = false;
    private audioContextStateHandler: (() => void) | null = null;

    // "Running-but-silent" safety net: an AnalyserNode tapped off the media
    // source. iOS can leave the AudioContext state "running" with the element
    // "playing" but genuinely emit no audio (post-interruption/backgrounding
    // edge cases). Only armed for a window after cold-start/foreground since
    // that is when this has been observed; null off-iOS (bridge never builds).
    private analyser: AnalyserNode | null = null;
    private armDetectorUntil = 0;
    private silentStreak = 0;
    private lastAnalyserCurrentTime: number | null = null;

    // Bounds how many times a single silent episode may trigger a full
    // DOM/Web-Audio rebuild. Reset ONLY when audible output is confirmed
    // (see checkSilentPlayback), so a genuinely wedged context gets one
    // rebuild attempt per episode rather than thrashing every 5 ticks.
    private rebuildCount = 0;

    // Silent-buffer unlock latch (see unlockOnce) and the persistent global
    // gesture listener that keeps the AudioContext resumed across iOS
    // backgrounding/interruption without needing a prime() call at every
    // playback call site.
    private unlockedOnce = false;
    private gestureUnlockHandler: (() => void) | null = null;

    constructor() {
        this.audio = typeof document === "undefined" ? ({} as HTMLAudioElement) : this.createOwnedElement();

        const events: ExternalEvent[] = ["ended", "timeupdate", "canplay", "seeked", "error"];
        events.forEach((e) => this.externalListeners.set(e, new Set()));

        this.snapshot = initialSnapshot();

        this.attachNativeListeners();
        this.initializeVolume();
        this.attachGestureUnlock();
    }

    // The controller owns its <audio> element rather than receiving one from
    // React -- this lets rebuildAudioContextBridge() tear down and recreate
    // the element/AudioContext graph entirely in-page (no remount) when the
    // iOS audio session is genuinely wedged.
    private createOwnedElement(): HTMLAudioElement {
        const el = document.createElement("audio");
        el.setAttribute("playsinline", "");
        el.preload = "auto";
        el.crossOrigin = "anonymous";
        el.style.display = "none";
        el.setAttribute("data-kima-player", "main");
        document.body.appendChild(el);
        return el;
    }

    // -------------------------------------------------------------------------
    // Battle-tested iOS code -- preserved verbatim
    // -------------------------------------------------------------------------

    // Claim the iOS "playback" audio session category. iOS demotes / reassigns
    // the category to another app when our session is interrupted (earbud click,
    // Control Center, a call), so an explicit resume MUST re-assert it (force)
    // rather than trusting the one-time latch -- otherwise iOS leaves the session
    // with whatever app grabbed it (e.g. a sleep-sounds app) and our resume is
    // silent. The latch still short-circuits the non-gesture auto paths.
    private setAudioSessionPlayback(force = false): void {
        if (this.audioSessionSet && !force) return;
        this.audioSessionSet = true;
        try {
            const nav = navigator as { audioSession?: { type: string } };
            if (nav.audioSession) {
                nav.audioSession.type = "playback";
            }
        } catch {
            // Not supported
        }
    }

    private isIosStandalone(): boolean {
        if (typeof window === "undefined") return false;
        try {
            const isIos =
                /iPhone|iPad|iPod/.test(navigator.userAgent) ||
                (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
            if (!isIos) return false;
            const legacy = (navigator as { standalone?: boolean }).standalone === true;
            const modern = window.matchMedia?.("(display-mode: standalone)").matches === true;
            return legacy || modern;
        } catch {
            return false;
        }
    }

    // Persistent (non-one-shot) capture-phase gesture listener. iOS re-suspends
    // the AudioContext on backgrounding, so a single early-page-life unlock is
    // not enough -- every later gesture must be able to re-resume it. prime()
    // is a cheap no-op once the context is already running, so this costs
    // nothing on repeat gestures or on non-iOS platforms.
    private attachGestureUnlock(): void {
        if (typeof document === "undefined") return;
        this.gestureUnlockHandler = () => this.prime();
        document.addEventListener("pointerdown", this.gestureUnlockHandler, { passive: true, capture: true });
        document.addEventListener("touchend", this.gestureUnlockHandler, { passive: true, capture: true });
    }

    // Synchronous, idempotent gesture-time unlock. Contains no `await` and never
    // calls audio.play() -- it only re-asserts the audio session and nudges the
    // AudioContext so iOS keeps CoreAudio clocking. Gated on iOS-standalone (its
    // only purpose is the WebKit #261858 bridge), so it is a true no-op on web,
    // Android, and even a plain iOS Safari tab.
    prime(): void {
        if (!this.isIosStandalone()) return;
        this.setAudioSessionPlayback(true);
        this.setupAudioContextBridge();
        this.ensureContextRunning();
        this.unlockOnce();
    }

    // resume() resolving does not guarantee CoreAudio actually started clocking --
    // starting a 1-frame silent buffer source forces it. Latched so it only runs once.
    private unlockOnce(): void {
        if (this.unlockedOnce) return;
        if (!this.isIosStandalone() || !this.audioContext) return;
        try {
            const ctx = this.audioContext;
            const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.start();
            source.onended = () => {
                try {
                    source.disconnect();
                } catch {
                    // Already disconnected
                }
            };
            // Latch ONLY on success -- a failed attempt stays retryable on a later gesture.
            this.unlockedOnce = true;
        } catch {
            // Not fatal -- leave the latch unset so a later gesture retries.
        }
    }

    private setupAudioContextBridge(): void {
        if (this.audioContextBridgeAttempted) {
            // Already attempted; resume if suspended (idempotent, cheap).
            this.audioContext?.resume?.().catch(() => {});
            return;
        }
        if (!this.isIosStandalone()) return;
        try {
            const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AC) return;
            this.audioContext = new AC();
            this.audioContextStateHandler = () => {
                const state = this.audioContext?.state;
                iosAudioLog(
                    "audio-context:statechange",
                    "audio-controller:setupAudioContextBridge",
                    this.audio,
                    { state, paused: this.audio.paused },
                );
                // OS ended an interruption and the context is live again: re-claim
                // the playback session category so iOS does not leave it with
                // whatever app grabbed it. Do NOT call audio.play() here -- iOS
                // does not emit a route-change signal we can use to tell an earbud
                // unplug from an interruption end, so auto-resume cannot be made
                // safe (it routes unplugged audio to the speaker: v1.7.12).
                if (state === "running" && !this.audio.paused) {
                    this.setAudioSessionPlayback(true);
                }
            };
            this.audioContext.addEventListener("statechange", this.audioContextStateHandler);
            this.mediaSourceNode = this.audioContext.createMediaElementSource(this.audio);
            try {
                this.analyser = this.audioContext.createAnalyser();
                this.analyser.fftSize = 256;
                this.mediaSourceNode.connect(this.analyser);
                this.analyser.connect(this.audioContext.destination);
            } catch {
                // Analyser is an enhancement; if it fails, still route audio to the
                // destination so playback works (the silence detector just won't run).
                this.analyser = null;
                this.mediaSourceNode.connect(this.audioContext.destination);
            }
            // Latch only after the audio path is fully routed -- a throw in
            // createMediaElementSource or the routing above leaves this false so
            // a later gesture can retry building the bridge instead of the
            // early-return path above permanently latching it half-wired.
            this.audioContextBridgeAttempted = true;
            this.ensureContextRunning();
            iosAudioLog(
                "audio-context:bridge-up",
                "audio-controller:setupAudioContextBridge",
                this.audio,
                { state: this.audioContext.state },
            );
        } catch (err) {
            iosAudioLog(
                "audio-context:bridge-fail",
                "audio-controller:setupAudioContextBridge",
                this.audio,
                { error: err instanceof Error ? err.message : String(err) },
            );
        }
    }

    // Non-blocking resume confirmation: resume() resolving does not guarantee
    // the context actually reached "running" on iOS. Retries up to 3 times
    // with backoff, never awaited by any caller (INV-1).
    private ensureContextRunning(attempt = 0): void {
        const ctx = this.audioContext;
        if (!ctx || ctx.state === "running" || attempt >= 3) return;
        ctx.resume().catch(() => {});
        setTimeout(() => this.ensureContextRunning(attempt + 1), 150 * (attempt + 1));
    }

    // -------------------------------------------------------------------------
    // State machine dispatch
    // -------------------------------------------------------------------------

    private dispatch(event: EngineEvent): void {
        const { snapshot, effects } = transition(this.snapshot, event);
        const changed = snapshot !== this.snapshot;
        this.snapshot = snapshot;

        this.runEffects(effects);

        if (changed) {
            this.updateTicker(snapshot.status);
            this.notifySubscribers();
        }
    }

    private runEffects(effects: Effect[]): void {
        for (const effect of effects) {
            switch (effect.kind) {
                case "set-src-and-load": {
                    this.audio.src = effect.src;
                    this.audio.load();
                    break;
                }
                case "seek": {
                    try {
                        this.audio.currentTime = effect.time;
                    } catch {
                        // Element not ready
                    }
                    break;
                }
                case "call-play": {
                    // Capture generation at call time so the reaction is bound to it.
                    // The whole dispatch including audio.play() runs synchronously to
                    // preserve the iOS autoplay grant in event tails (e.g. ended -> next track).
                    const capturedGen = this.snapshot.generation;
                    // Resume AudioContext in parallel (fire-and-forget) so it is running
                    // by the time the first audio frames need routing. Must NOT be awaited
                    // or chained -- play() must remain synchronous for the iOS event-tail grant.
                    this.ensureContextRunning();
                    this.audio.play().then(() => {
                        // Play succeeded -- nothing to do; native-playing fires
                    }).catch((err: unknown) => {
                        if (!(err instanceof DOMException)) {
                            iosAudioLog("play:error", "audio-controller:call-play", this.audio, {
                                error: err instanceof Error ? err.message : String(err),
                            });
                            this.dispatch({
                                type: "play-rejected",
                                reason: "other",
                                generation: capturedGen,
                                now: Date.now(),
                            });
                            return;
                        }
                        const name = (err as DOMException).name;
                        if (name === "AbortError") {
                            iosAudioLog("play:abort-error", "audio-controller:call-play", this.audio);
                            // Superseded generations are silently ignored by the policy.
                            this.dispatch({
                                type: "play-rejected",
                                reason: "abort",
                                generation: capturedGen,
                                now: Date.now(),
                            });
                        } else if (name === "NotAllowedError") {
                            iosAudioLog("play:not-allowed", "audio-controller:call-play", this.audio);
                            this.dispatch({
                                type: "play-rejected",
                                reason: "not-allowed",
                                generation: capturedGen,
                                now: Date.now(),
                            });
                        } else {
                            iosAudioLog("play:error", "audio-controller:call-play", this.audio, { error: (err as DOMException).message });
                            this.dispatch({
                                type: "play-rejected",
                                reason: "other",
                                generation: capturedGen,
                                now: Date.now(),
                            });
                        }
                    });
                    break;
                }
                case "call-pause": {
                    this.expectingPause = true;
                    this.audio.pause();
                    break;
                }
                case "arm-timer": {
                    const timerId = effect.timer;
                    const existing = this.timers.get(timerId);
                    if (existing != null) clearTimeout(existing);
                    const handle = setTimeout(() => {
                        this.timers.delete(timerId);
                        this.dispatch({ type: "timer-fired", timer: timerId, now: Date.now() });
                    }, effect.ms);
                    this.timers.set(timerId, handle);
                    break;
                }
                case "cancel-timer": {
                    const timerId = effect.timer;
                    const existing = this.timers.get(timerId);
                    if (existing != null) {
                        clearTimeout(existing);
                        this.timers.delete(timerId);
                    }
                    break;
                }
                case "claim-session": {
                    this.setAudioSessionPlayback(true);
                    this.setupAudioContextBridge();
                    break;
                }
                case "emit-ended": {
                    this.emitExternal("ended");
                    break;
                }
                case "emit-error": {
                    this.emitExternal("error", {
                        error: this.snapshot.error?.message ?? "Audio playback error",
                        code: this.snapshot.error?.code,
                    });
                    break;
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Ticker
    // -------------------------------------------------------------------------

    private updateTicker(status: EngineStatus): void {
        const active = status === "playing" || status === "buffering" || status === "recovering";
        if (active && !this.tickerInterval) {
            this.tickerInterval = setInterval(() => {
                this.dispatch({
                    type: "tick",
                    currentTime: this.audio.currentTime,
                    readyState: this.audio.readyState,
                    paused: this.audio.paused,
                    hidden: document.visibilityState === "hidden",
                    now: Date.now(),
                });
                this.checkSilentPlayback();
            }, TICKER_INTERVAL_MS);
        } else if (!active && this.tickerInterval) {
            clearInterval(this.tickerInterval);
            this.tickerInterval = null;
        }
    }

    // "Running-but-silent" detector -- reads the analyser only inside the
    // armed window while genuinely playing with an advancing decode clock.
    // Requires 5 consecutive silent ticks (true digital silence) before
    // dispatching, so ordinary quiet passages (which are never bit-exact
    // 128 across the whole buffer) do not false-positive.
    private checkSilentPlayback(): void {
        if (!this.analyser) return;

        if (this.snapshot.status !== "playing" || Date.now() >= this.armDetectorUntil) {
            this.silentStreak = 0;
            this.lastAnalyserCurrentTime = null;
            return;
        }

        const currentTime = this.audio.currentTime;
        const advanced =
            this.lastAnalyserCurrentTime !== null && currentTime !== this.lastAnalyserCurrentTime;
        this.lastAnalyserCurrentTime = currentTime;
        if (!advanced) {
            this.silentStreak = 0;
            return;
        }

        const buf = new Uint8Array(this.analyser.fftSize);
        this.analyser.getByteTimeDomainData(buf);
        let sumSq = 0;
        let maxDeviation = 0;
        for (let i = 0; i < buf.length; i++) {
            const deviation = buf[i] - 128;
            sumSq += deviation * deviation;
            const abs = Math.abs(deviation);
            if (abs > maxDeviation) maxDeviation = abs;
        }
        const rms = Math.sqrt(sumSq / buf.length);

        if (rms < 1.0 && maxDeviation < 2) {
            this.silentStreak++;
            if (this.silentStreak >= 5) {
                this.ensureContextRunning();
                if (this.rebuildCount < 1) {
                    this.rebuildAudioContextBridge();
                    this.rebuildCount++;
                }
                this.dispatch({ type: "silent-playback-detected", now: Date.now() });
                this.silentStreak = 0;
            }
        } else {
            // Real output confirmed -- the only place rebuildCount resets, so a
            // rebuild is attempted at most once per genuine silence episode.
            this.silentStreak = 0;
            this.rebuildCount = 0;
        }
    }

    // In-page recovery for a genuinely wedged iOS audio session: rebuilds
    // the <audio> element + AudioContext/analyser graph from scratch. Does
    // NOT touch engine state and does NOT play -- the snapshot's src/
    // currentTime stay intact, the trigger below moves status to "blocked",
    // and the existing play-requested-from-blocked path (audio-engine-policy.ts)
    // reloads snap.src, seeks to snap.currentTime, and plays on this fresh
    // element in-gesture when the user taps retry.
    private rebuildAudioContextBridge(): void {
        if (!this.isIosStandalone()) return;

        // Detach listeners FIRST -- otherwise pause/emptied events fired by
        // tearing down the old element dispatch into the live engine mid-rebuild.
        this.detachNativeListeners();
        this.audio.pause();
        this.audio.removeAttribute("src");
        this.audio.load();
        this.audio.remove();

        if (this.audioContextStateHandler) {
            this.audioContext?.removeEventListener("statechange", this.audioContextStateHandler);
        }
        this.audioContext?.close().catch(() => {});
        this.audioContext = null;
        this.mediaSourceNode = null;
        this.analyser = null;
        this.audioContextStateHandler = null;

        this.audioContextBridgeAttempted = false;
        this.unlockedOnce = false;
        this.silentStreak = 0;

        this.audio = this.createOwnedElement();
        this.attachNativeListeners();
        this.audio.volume = this.isMuted ? 0 : this.volume;
        this.audio.muted = this.isMuted;

        // Fresh context + analyser on the new element. Deliberately does NOT
        // set src / seek / play here.
        this.setupAudioContextBridge();
    }

    // -------------------------------------------------------------------------
    // Native element listeners
    // -------------------------------------------------------------------------

    private attachNativeListeners(): void {
        const add = (event: string, handler: EventListener) => {
            this.audio.addEventListener(event, handler);
            this.nativeListeners.push({ event, handler });
        };

        add("playing", () => {
            iosAudioLog("playing", "audio-controller:listeners", this.audio);
            this.dispatch({ type: "native-playing", now: Date.now() });
        });

        add("pause", () => {
            iosAudioLog("pause", "audio-controller:listeners", this.audio);
            if (this.expectingPause) {
                // Our own call-pause effect fired this -- do not dispatch native-pause
                this.expectingPause = false;
                return;
            }
            // Unexpected pause (earbud, interruption, system) -- dispatch to policy
            this.dispatch({ type: "native-pause", now: Date.now() });
        });

        add("ended", () => {
            iosAudioLog("ended", "audio-controller:listeners", this.audio);
            this.dispatch({
                type: "native-ended",
                currentTime: this.audio.currentTime,
                duration: this.audio.duration,
                now: Date.now(),
            });
        });

        add("timeupdate", () => {
            // Suppress upstream timeupdate while transitioning (avoids 0-position flash)
            if (!this.isTransitioning) {
                this.emitExternal("timeupdate", { time: this.audio.currentTime });
            }
        });

        add("canplay", () => {
            const dur = this.audio.duration;
            iosAudioLog("canplay", "audio-controller:listeners", this.audio, {
                gen: this.snapshot.generation,
                pendingSeek: this.snapshot.pendingSeek,
            });
            // Dispatch first so policy applies the pending seek (if any)
            this.dispatch({ type: "native-canplay", duration: isFinite(dur) ? dur : 0, now: Date.now() });
            // Then emit upstream -- pendingSeek is now applied
            this.emitExternal("canplay", { duration: isFinite(dur) ? dur : 0 });
        });

        add("waiting", () => {
            this.dispatch({ type: "native-waiting", now: Date.now() });
        });

        add("seeked", () => {
            this.emitExternal("seeked", { time: this.audio.currentTime });
        });

        add("error", () => {
            const err = this.audio.error;
            iosAudioLog("error", "audio-controller:listeners", this.audio, {
                code: err?.code,
                message: err?.message,
            });
            this.dispatch({
                type: "native-error",
                code: err?.code ?? 0,
                message: err?.message ?? "Audio error",
                now: Date.now(),
            });
        });

        // NOTE: "stalled" is intentionally NOT forwarded to the policy.
        // Production calibration: 1094 stalled events in the 2.5-day iOS trace,
        // all during healthy playback with readyState=4. Pure noise on iOS.
    }

    private detachNativeListeners(): void {
        for (const { event, handler } of this.nativeListeners) {
            this.audio.removeEventListener(event, handler);
        }
        this.nativeListeners = [];
    }

    // -------------------------------------------------------------------------
    // Subscriber management
    // -------------------------------------------------------------------------

    private notifySubscribers(): void {
        this.subscribers.forEach((fn) => {
            try {
                fn(this.snapshot);
            } catch (err) {
                console.error("[AudioController] Subscriber error:", err);
            }
        });
    }

    subscribe(fn: (snap: EngineSnapshot) => void): () => void {
        this.subscribers.add(fn);
        // Call immediately with current snapshot
        try {
            fn(this.snapshot);
        } catch (err) {
            console.error("[AudioController] Subscriber error on initial call:", err);
        }
        return () => {
            this.subscribers.delete(fn);
        };
    }

    getSnapshot(): EngineSnapshot {
        return this.snapshot;
    }

    // -------------------------------------------------------------------------
    // External event bus
    // -------------------------------------------------------------------------

    on(event: ExternalEvent, cb: ExternalCallback): void {
        this.externalListeners.get(event)?.add(cb);
    }

    off(event: ExternalEvent, cb: ExternalCallback): void {
        this.externalListeners.get(event)?.delete(cb);
    }

    private emitExternal(event: ExternalEvent, data?: unknown): void {
        this.externalListeners.get(event)?.forEach((cb) => {
            try {
                cb(data);
            } catch (err) {
                console.error(`[AudioController] Event listener error (${event}):`, err);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    load(src: string, opts: { autoplay?: boolean; seekTo?: number; expectedDurationS?: number } = {}): void {
        const { autoplay = false, seekTo, expectedDurationS } = opts;
        this.armDetectorUntil = Date.now() + 15000;
        this.lastAnalyserCurrentTime = this.audio.currentTime;
        iosAudioLog("load:entry", "audio-controller:load", this.audio, {
            autoplay,
            seekTo,
            sameSrc: this.snapshot.src === src,
        });

        // Same-src dedup: if already loading this src, only update intent
        if (src === this.snapshot.src && this.snapshot.status === "loading") {
            if (autoplay) {
                this.dispatch({ type: "play-requested", now: Date.now() });
            }
            return;
        }

        this.dispatch({
            type: "load",
            src,
            autoplay,
            seekTo,
            expectedDurationS,
            now: Date.now(),
        });
    }

    play(): void {
        iosAudioLog("play:entry", "audio-controller:play", this.audio);
        this.dispatch({ type: "play-requested", now: Date.now() });
    }

    pause(cls: "user" | "system" = "user"): void {
        iosAudioLog("pause", "audio-controller:pause", this.audio, { cls });
        this.dispatch({ type: "pause-requested", cls, now: Date.now() });
    }

    seek(time: number): void {
        const duration = this.audio.duration;
        if (duration && isFinite(duration) && duration > 0) {
            time = Math.max(0, Math.min(time, duration));
        } else {
            time = Math.max(0, time);
        }
        try {
            this.audio.currentTime = time;
        } catch {
            console.warn("[AudioController] Seek failed: element not ready");
        }
    }

    stop(): void {
        this.audio.pause();
        this.audio.currentTime = 0;
    }

    cleanup(): void {
        this.dispatch({ type: "cleanup", now: Date.now() });

        // Cancel all pending timers
        for (const [, handle] of this.timers) {
            clearTimeout(handle);
        }
        this.timers.clear();

        // Element teardown
        this.audio.pause();
        this.audio.removeAttribute("src");
        this.audio.load();
    }

    destroy(): void {
        this.cleanup();
        this.detachNativeListeners();

        if (this.gestureUnlockHandler) {
            document.removeEventListener("pointerdown", this.gestureUnlockHandler, { capture: true });
            document.removeEventListener("touchend", this.gestureUnlockHandler, { capture: true });
            this.gestureUnlockHandler = null;
        }

        if (this.tickerInterval) {
            clearInterval(this.tickerInterval);
            this.tickerInterval = null;
        }

        // Bridge teardown
        if (this.audioContext) {
            if (this.audioContextStateHandler) {
                this.audioContext.removeEventListener("statechange", this.audioContextStateHandler);
                this.audioContextStateHandler = null;
            }
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
            this.mediaSourceNode = null;
        }

        // Owned-element teardown -- the controller appended it to
        // document.body itself, so it must remove it here too.
        this.audio.pause();
        this.audio.removeAttribute("src");
        this.audio.load();
        this.audio.remove();

        this.subscribers.clear();
    }

    notifyForeground(): void {
        this.armDetectorUntil = Date.now() + 15000;
        this.lastAnalyserCurrentTime = this.audio.currentTime;
        this.dispatch({ type: "foreground", now: Date.now() });
    }

    getCurrentTime(): number {
        return this.audio.currentTime || 0;
    }

    getDuration(): number {
        const d = this.audio.duration;
        return d && isFinite(d) ? d : 0;
    }

    isPlaying(): boolean {
        return !this.audio.paused && !this.audio.ended;
    }

    hasAudio(): boolean {
        return this.audio.readyState >= 2;
    }

    get isTransitioning(): boolean {
        return (
            this.snapshot.status === "loading" ||
            this.snapshot.pendingSeek != null
        );
    }

    getState(): Readonly<{ currentSrc: string | null; volume: number; isMuted: boolean }> {
        return { currentSrc: this.snapshot.src, volume: this.volume, isMuted: this.isMuted };
    }

    setVolume(volume: number): void {
        this.volume = Math.max(0, Math.min(1, volume));
        if (!this.isMuted) {
            this.audio.volume = this.volume;
        }
    }

    setMuted(muted: boolean): void {
        this.isMuted = muted;
        // FE14: must use audio.muted on iOS (audio.volume is read-only there)
        this.audio.muted = muted;
        // Also set volume for non-iOS devices
        if (!muted) {
            this.audio.volume = this.volume;
        }
    }

    initializeVolume(): void {
        if (typeof window === "undefined") return;

        try {
            const savedVolume = localStorage.getItem("kima_volume");
            const savedMuted = localStorage.getItem("kima_muted");

            if (savedVolume) {
                const parsed = parseFloat(savedVolume);
                if (!isNaN(parsed)) {
                    this.volume = Math.max(0, Math.min(1, parsed));
                }
            }
            if (savedMuted === "true") {
                this.isMuted = true;
            }

            this.audio.volume = this.isMuted ? 0 : this.volume;
        } catch (error) {
            console.error("[AudioController] Failed to initialize from storage:", error);
        }
    }
}

