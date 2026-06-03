"use client";

import { iosAudioLog } from "./iosAudioLog";

export type AudioControllerEvent =
    | "play"
    | "pause"
    | "ended"
    | "timeupdate"
    | "loading"
    | "canplay"
    | "error"
    | "waiting"
    | "seeked"
    | "needs-resume";

export type AudioControllerCallback = (data?: unknown) => void;

export class AudioController {
    private audio: HTMLAudioElement;
    private audioSessionSet = false;
    private eventListeners: Map<AudioControllerEvent, Set<AudioControllerCallback>> = new Map();
    private nativeListeners: Array<{ event: string; handler: EventListener }> = [];
    private prefetchLink: HTMLLinkElement | null = null;

    private currentSrc: string | null = null;
    private volume = 1;
    private isMuted = false;

    private networkRetryCount = 0;
    private readonly MAX_NETWORK_RETRIES = 3;
    private networkRetryTimeout: ReturnType<typeof setTimeout> | null = null;
    private retrySeekTime: number | null = null;

    // Stall watchdog state
    private watchdogInterval: ReturnType<typeof setInterval> | null = null;
    private lastWatchdogTime = -1;
    private lastTimeChangeAt = 0;
    private readonly WATCHDOG_CHECK_MS = 1000;
    private readonly WATCHDOG_STALL_MS = 3000;

    // Stalled event grace timer
    private stallGraceTimeout: ReturnType<typeof setTimeout> | null = null;
    private readonly STALL_GRACE_MS = 10000;

    // Stall recovery state
    private stallRecoveryCount = 0;
    private readonly MAX_STALL_RECOVERIES = 3;
    private autoResumeAfterRecovery = false;

    // reloadAndPlay failsafe state (tracked for cleanup in destroy())
    private reloadFailsafeTimeout: ReturnType<typeof setTimeout> | null = null;
    private reloadFailsafeListener: (() => void) | null = null;

    // Route-change observability: track time of last play to compute ms-since-play on pause.
    private lastPlayAt = 0;

    // iOS standalone PWA audio session bridge. iOS WKWebView suspends the
    // HTMLAudioElement's audio session when backgrounded; MediaSession reports
    // "playing" but no sound. Routing the element through an AudioContext
    // keeps the iOS audio session active across backgrounding because the
    // AudioContext claims it more durably than a bare <audio>.
    // WebKit #261858. Bridge set up lazily on the first user-gesture play.
    private audioContext: AudioContext | null = null;
    private mediaSourceNode: MediaElementAudioSourceNode | null = null;
    private audioContextBridgeAttempted = false;

    // Silent-playback watchdog: after audio.play() resolves, expect a real
    // timeupdate event within SILENT_PLAYBACK_TIMEOUT_MS. If none arrives,
    // assume iOS has us in a "playing but silent" state (audio.paused=false,
    // MediaSession.playbackState="playing", no audio routing). Pause and emit
    // needs-resume so the UI renders a Tap-to-resume prompt; the user tap is
    // a fresh user gesture that can actually resume the AudioContext.
    private silentPlaybackTimeout: ReturnType<typeof setTimeout> | null = null;
    private silentWatchdogBaselineTime = -1;
    private readonly SILENT_PLAYBACK_TIMEOUT_MS = 2500;

    constructor(audio: HTMLAudioElement) {
        this.audio = audio;
        this.audio.preload = "auto";

        const events: AudioControllerEvent[] = [
            "play", "pause", "ended", "timeupdate",
            "loading", "canplay", "error", "waiting",
            "seeked", "needs-resume",
        ];
        events.forEach((e) => this.eventListeners.set(e, new Set()));

        this.attachNativeListeners();
        this.initializeVolume();
    }

    private setAudioSessionPlayback(): void {
        if (this.audioSessionSet) return;
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
            const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
            if (!isIos) return false;
            const legacy = (navigator as { standalone?: boolean }).standalone === true;
            const modern = window.matchMedia?.("(display-mode: standalone)").matches === true;
            return legacy || modern;
        } catch {
            return false;
        }
    }

    /**
     * Ensure the iOS AudioContext bridge is set up and the context is running.
     * Returns the final context state (or null if no bridge is needed on this
     * platform / browser). Always awaits resume() rather than fire-and-forget
     * so callers can gate play() on the actual ready state -- iOS nap-mode
     * and long backgrounding can leave the context "suspended" or
     * "interrupted" and a play() before resume completes produces silent
     * playback (audio.paused=false but no audio routing).
     */
    private async setupAudioContextBridge(): Promise<AudioContextState | null> {
        if (this.audioContextBridgeAttempted) {
            if (!this.audioContext) return null;
            if (this.audioContext.state !== "running") {
                try {
                    await this.audioContext.resume();
                } catch (err) {
                    iosAudioLog(
                        "audio-context:resume-rejected",
                        "audio-controller:setupAudioContextBridge",
                        this.audio,
                        { error: err instanceof Error ? err.message : String(err), state: this.audioContext.state },
                    );
                }
            }
            return this.audioContext.state;
        }
        if (!this.isIosStandalone()) return null;
        this.audioContextBridgeAttempted = true;
        try {
            const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AC) return null;
            this.audioContext = new AC();
            this.mediaSourceNode = this.audioContext.createMediaElementSource(this.audio);
            this.mediaSourceNode.connect(this.audioContext.destination);
            try {
                await this.audioContext.resume();
            } catch (err) {
                iosAudioLog(
                    "audio-context:initial-resume-rejected",
                    "audio-controller:setupAudioContextBridge",
                    this.audio,
                    { error: err instanceof Error ? err.message : String(err), state: this.audioContext.state },
                );
            }
            iosAudioLog(
                "audio-context:bridge-up",
                "audio-controller:setupAudioContextBridge",
                this.audio,
                { state: this.audioContext.state },
            );
            return this.audioContext.state;
        } catch (err) {
            iosAudioLog(
                "audio-context:bridge-fail",
                "audio-controller:setupAudioContextBridge",
                this.audio,
                { error: err instanceof Error ? err.message : String(err) },
            );
            return null;
        }
    }

    private attachNativeListeners(): void {
        const add = (event: string, handler: EventListener) => {
            this.audio.addEventListener(event, handler);
            this.nativeListeners.push({ event, handler });
        };

        add("playing", () => {
            this.lastPlayAt = Date.now();
            iosAudioLog("playing", "audio-controller:listeners", this.audio);
            this.networkRetryCount = 0;
            this.stallRecoveryCount = 0;
            this.startWatchdog();
            this.cancelStallGrace();
            // 'playing' is a stronger "audio actually started" signal than
            // 'timeupdate' and is not throttled the same way in background, so
            // disarm the silent watchdog here too -- the stall watchdog
            // (currentTime-based) covers any real no-progress case from now on.
            this.cancelSilentPlaybackWatchdog();
            this.emit("play");
        });

        add("pause", () => {
            iosAudioLog("pause", "audio-controller:listeners", this.audio, {
                msSincePlay: Date.now() - this.lastPlayAt,
            });
            this.stopWatchdog();
            // External pauses (Control Center, route loss) route through the
            // native 'pause' event, not the pause() method, so disarm here too.
            this.cancelSilentPlaybackWatchdog();
            this.emit("pause");
        });

        add("ended", () => {
            iosAudioLog("ended", "audio-controller:listeners", this.audio);
            this.stopWatchdog();
            this.emit("ended");
        });

        add("timeupdate", () => {
            this.cancelStallGrace();
            this.cancelSilentPlaybackWatchdog();
            this.emit("timeupdate", { time: this.audio.currentTime });
        });

        add("canplay", () => {
            iosAudioLog("canplay", "audio-controller:listeners", this.audio, {
                autoResumeAfterRecovery: this.autoResumeAfterRecovery,
                retrySeekTime: this.retrySeekTime,
            });
            if (this.retrySeekTime !== null) {
                const seekTo = this.retrySeekTime;
                this.retrySeekTime = null;
                try {
                    this.audio.currentTime = seekTo;
                } catch {
                    // Element not ready
                }
            }
            if (this.autoResumeAfterRecovery) {
                this.autoResumeAfterRecovery = false;
                this.play();
            }
            this.emit("canplay", { duration: this.audio.duration || 0 });
        });

        add("waiting", () => {
            this.emit("waiting");
        });

        add("loadstart", () => {
            this.emit("loading");
        });

        add("seeked", () => {
            this.resetWatchdog();
            this.emit("seeked", { time: this.audio.currentTime });
        });

        add("stalled", () => {
            iosAudioLog("stalled", "audio-controller:listeners", this.audio);
            if (this.audio.paused || this.audio.ended) return;
            if (this.stallGraceTimeout) return;

            this.stallGraceTimeout = setTimeout(() => {
                this.stallGraceTimeout = null;
                if (
                    this.audio.readyState < 3 &&
                    !this.audio.paused &&
                    !this.audio.ended
                ) {
                    console.warn("[AudioController] Stall grace expired, attempting recovery");
                    this.attemptStallRecovery();
                }
            }, this.STALL_GRACE_MS);
        });

        add("error", () => {
            iosAudioLog("error", "audio-controller:listeners", this.audio, {
                code: this.audio.error?.code,
                message: this.audio.error?.message,
            });
            const err = this.audio.error;

            if (
                err?.code === 2 &&
                this.networkRetryCount < this.MAX_NETWORK_RETRIES &&
                this.currentSrc
            ) {
                this.networkRetryCount++;
                const delay = Math.min(1000 * Math.pow(2, this.networkRetryCount - 1), 8000);
                console.warn(
                    `[AudioController] Network error, retrying in ${delay}ms (attempt ${this.networkRetryCount}/${this.MAX_NETWORK_RETRIES})`
                );
                this.networkRetryTimeout = setTimeout(() => {
                    if (this.currentSrc) {
                        const currentTime = this.audio.currentTime;
                        this.retrySeekTime = currentTime > 0 ? currentTime : null;
                        this.autoResumeAfterRecovery = true;
                        this.audio.src = this.currentSrc;
                        this.audio.load();
                    }
                }, delay);
                return;
            }

            this.emit("error", {
                error: err?.message || "Audio playback error",
                code: err?.code,
            });
        });
    }

    private detachNativeListeners(): void {
        for (const { event, handler } of this.nativeListeners) {
            this.audio.removeEventListener(event, handler);
        }
        this.nativeListeners = [];
    }

    // -- Stall watchdog --

    private startWatchdog(): void {
        if (this.watchdogInterval) return;
        this.lastWatchdogTime = this.audio.currentTime;
        this.lastTimeChangeAt = Date.now();

        this.watchdogInterval = setInterval(() => {
            this.checkWatchdog();
        }, this.WATCHDOG_CHECK_MS);
    }

    private stopWatchdog(): void {
        if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
            this.watchdogInterval = null;
        }
        this.lastWatchdogTime = -1;
    }

    private resetWatchdog(): void {
        this.lastWatchdogTime = this.audio.currentTime;
        this.lastTimeChangeAt = Date.now();
    }

    private checkWatchdog(): void {
        if (this.audio.paused || this.audio.ended) return;

        const now = Date.now();
        if (this.audio.currentTime !== this.lastWatchdogTime) {
            this.lastWatchdogTime = this.audio.currentTime;
            this.lastTimeChangeAt = now;
            return;
        }

        const stalledFor = now - this.lastTimeChangeAt;
        if (stalledFor >= this.WATCHDOG_STALL_MS) {
            console.warn(
                `[AudioController] Watchdog: no progress for ${stalledFor}ms, attempting recovery`
            );
            this.attemptStallRecovery();
        }
    }

    private attemptStallRecovery(): void {
        iosAudioLog("stall-recovery", "audio-controller:attemptStallRecovery", this.audio);
        if (!this.currentSrc) return;

        this.cancelStallGrace();
        this.stopWatchdog();

        this.stallRecoveryCount++;
        if (this.stallRecoveryCount > this.MAX_STALL_RECOVERIES) {
            console.error("[AudioController] Max stall recoveries exceeded, giving up");
            this.emit("error", {
                error: "Playback stalled repeatedly",
                code: 99,
            });
            return;
        }

        const currentTime = this.audio.currentTime;
        this.retrySeekTime = currentTime > 0 ? currentTime : null;
        this.autoResumeAfterRecovery = true;
        this.audio.src = this.currentSrc;
        this.audio.load();
    }

    private cancelStallGrace(): void {
        if (this.stallGraceTimeout) {
            clearTimeout(this.stallGraceTimeout);
            this.stallGraceTimeout = null;
        }
    }

    private startSilentPlaybackWatchdog(): void {
        this.cancelSilentPlaybackWatchdog();
        if (!this.isIosStandalone()) return;
        // Snapshot the clock so we can verify real decode progress at fire time.
        this.silentWatchdogBaselineTime = this.audio.currentTime;
        this.silentPlaybackTimeout = setTimeout(() => {
            this.silentPlaybackTimeout = null;
            if (this.audio.paused || this.audio.ended) return;

            // (1) Authoritative liveness: did the decode clock advance?
            // currentTime keeps moving whenever audio is genuinely routing,
            // even when iOS throttles the 'timeupdate' EVENT in background
            // (the stall watchdog trusts this exact signal, see checkWatchdog).
            // AudioContext.state is only a proxy for the graph node and can
            // read 'running' while silent or non-'running' while audible after
            // a backgrounded src swap (swapAndPlay never resumes the context),
            // so it is NOT used as the primary discriminator.
            if (this.audio.currentTime > this.silentWatchdogBaselineTime + 0.05) {
                return; // playing fine; timeupdate was just throttled
            }

            // (2) Never tear down playback while hidden. The Tap-to-resume UI
            // is not actionable in the user's pocket, and a transient route /
            // throttle stall must not pause healthy background playback. The
            // foreground path (handleForeground -> notifyForeground +
            // tryResume) re-evaluates: tryResume re-checks the AudioContext and
            // emits needs-resume if still suspended -- so genuine nap-mode
            // silence is surfaced when the user is actually looking at the
            // screen and can tap.
            if (typeof document !== "undefined" && document.visibilityState === "hidden") {
                return;
            }

            // (3) Visible + no decode progress + not paused/ended -> genuinely
            // silent. Corroborate with ctx state for the log only.
            iosAudioLog(
                "silent-playback:detected",
                "audio-controller:silent-watchdog",
                this.audio,
                {
                    ctxState: this.audioContext?.state ?? null,
                    baseline: this.silentWatchdogBaselineTime,
                    now: this.audio.currentTime,
                },
            );
            this.audio.pause();
            this.emit("needs-resume");
        }, this.SILENT_PLAYBACK_TIMEOUT_MS);
    }

    private cancelSilentPlaybackWatchdog(): void {
        if (this.silentPlaybackTimeout) {
            clearTimeout(this.silentPlaybackTimeout);
            this.silentPlaybackTimeout = null;
        }
        this.silentWatchdogBaselineTime = -1;
    }

    async play(): Promise<void> {
        iosAudioLog("play:entry", "audio-controller:play", this.audio);
        if (!this.audio.src) return;

        this.setAudioSessionPlayback();
        const ctxState = await this.setupAudioContextBridge();
        if (ctxState && ctxState !== "running") {
            iosAudioLog(
                "play:context-not-running",
                "audio-controller:play",
                this.audio,
                { state: ctxState },
            );
            this.emit("needs-resume");
            return;
        }

        try {
            await this.audio.play();
            this.startSilentPlaybackWatchdog();
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") {
                iosAudioLog("play:abort-error", "audio-controller:play", this.audio);
                // On iOS, AbortError after interruption means the audio element
                // is in a bad state. Try reloading the source as a recovery.
                if (this.currentSrc) {
                    this.reloadAndPlay();
                }
                return;
            }
            if (err instanceof DOMException && err.name === "NotAllowedError") {
                iosAudioLog("play:not-allowed", "audio-controller:play", this.audio);
                // User gesture required -- emit needs-resume so UI can prompt
                this.emit("needs-resume");
                return;
            }
            console.error("[AudioController] Play failed:", err);
            this.emit("error", { error: err instanceof Error ? err.message : String(err) });
        }
    }

    async tryResume(): Promise<boolean> {
        if (!this.audio.src) return false;
        if (!this.audio.paused) return true;

        this.setAudioSessionPlayback();
        const ctxState = await this.setupAudioContextBridge();
        if (ctxState && ctxState !== "running") {
            iosAudioLog(
                "tryResume:context-not-running",
                "audio-controller:tryResume",
                this.audio,
                { state: ctxState },
            );
            if (this.currentSrc) {
                this.emit("needs-resume");
            }
            return false;
        }

        try {
            await this.audio.play();
            this.startSilentPlaybackWatchdog();
            return true;
        } catch {
            if (this.currentSrc) {
                this.emit("needs-resume");
            }
            return false;
        }
    }

    /**
     * Explicit user-gesture resume (MediaSession "play" action / visible play
     * button). Unlike play(), this NEVER awaits the AudioContext before
     * audio.play() -- awaiting forfeits the iOS user-activation token, which is
     * what left earbud-click resume silent and let iOS hand the session to
     * another app (WebKit #261858). Mirrors swapAndPlay's synchronous pattern:
     * fire the context resume in parallel, call audio.play() synchronously in
     * the gesture tail, and on ANY failure reload the source to re-grab the
     * hardware session rather than emitting a needs-resume the lock screen
     * can't show.
     *
     * MUST only be called from an explicit user resume gesture, never from an
     * ambiguous 'pause'/route-change event (see v1.7.12 / 7b41b91 -- a timer
     * resuming on the native pause event routed audio through the speaker on
     * earbud unplug).
     */
    resumeFromGesture(): void {
        iosAudioLog("resumeFromGesture:entry", "audio-controller:resumeFromGesture", this.audio);
        if (!this.audio.src) return;

        this.setAudioSessionPlayback();
        // Kick the AudioContext resume but do NOT await it: audio.play() below
        // must run inside the live gesture. The bridge node resumes in parallel;
        // currentTime advancing is the liveness signal the silent watchdog
        // checks, not ctx.state.
        void this.setupAudioContextBridge();

        this.cancelSilentPlaybackWatchdog();
        this.audio.play().then(() => {
            this.startSilentPlaybackWatchdog();
        }).catch((err) => {
            if (err instanceof DOMException && err.name === "NotAllowedError") {
                iosAudioLog("resumeFromGesture:not-allowed", "audio-controller:resumeFromGesture", this.audio);
                // A fresh explicit gesture still rejected -> the element/session
                // is stale; reloadAndPlay re-establishes the hardware session.
                if (this.currentSrc) this.reloadAndPlay();
                return;
            }
            if (err instanceof DOMException && err.name === "AbortError") {
                iosAudioLog("resumeFromGesture:abort", "audio-controller:resumeFromGesture", this.audio);
                if (this.currentSrc) this.reloadAndPlay();
                return;
            }
            console.error("[AudioController] resumeFromGesture failed:", err);
            this.emit("error", { error: err instanceof Error ? err.message : String(err) });
        });
    }

    pause(): void {
        this.autoResumeAfterRecovery = false;
        this.cancelSilentPlaybackWatchdog();
        this.audio.pause();
    }

    notifyForeground(): void {
        if (this.watchdogInterval) {
            this.resetWatchdog();
        }
        this.cancelStallGrace();
        // A watchdog armed while hidden must not fire stale after return;
        // handleForeground -> tryResume re-evaluates liveness with a real
        // AudioContext check and re-arms the watchdog if it plays.
        this.cancelSilentPlaybackWatchdog();
    }

    private clearReloadFailsafe(): void {
        if (this.reloadFailsafeTimeout) {
            clearTimeout(this.reloadFailsafeTimeout);
            this.reloadFailsafeTimeout = null;
        }
        if (this.reloadFailsafeListener) {
            this.audio.removeEventListener("canplay", this.reloadFailsafeListener);
            this.reloadFailsafeListener = null;
        }
    }

    /**
     * Reload the current source and resume playback.
     * Used as a fallback when play() fails after iOS audio interruption
     * (the audio element can be left in a state where it reports playing
     * but the hardware audio session is disconnected).
     *
     * Recovery flow: set src → load() → canplay fires → seek to saved position
     * → autoResumeAfterRecovery triggers play(). If the element doesn't reach
     * canplay within 10 s, emits needs-resume so the UI can prompt the user.
     */
    reloadAndPlay(): void {
        iosAudioLog("reload:entry", "audio-controller:reloadAndPlay", this.audio);
        if (!this.currentSrc) return;
        const currentTime = this.audio.currentTime;
        this.retrySeekTime = Number.isFinite(currentTime) && currentTime > 0 ? currentTime : null;
        this.autoResumeAfterRecovery = true;

        // Clean up any previous reload's failsafe
        this.clearReloadFailsafe();

        const onCanPlayOnce = () => {
            this.clearReloadFailsafe();
        };

        this.reloadFailsafeListener = onCanPlayOnce;
        this.audio.addEventListener("canplay", onCanPlayOnce);

        this.audio.src = this.currentSrc;
        this.audio.load();

        // Safety net: if canplay never fires, notify the UI
        this.reloadFailsafeTimeout = setTimeout(() => {
            iosAudioLog("reload:failsafe-fired", "audio-controller:reloadAndPlay", this.audio);
            this.clearReloadFailsafe();
            if (this.autoResumeAfterRecovery) {
                this.autoResumeAfterRecovery = false;
                this.emit("needs-resume");
            }
        }, 10_000);
    }

    /**
     * iOS-safe track advance: swap src and call play() synchronously inside the
     * caller's event tail (e.g., inside an "ended" handler). This may preserve the
     * autoplay grant on iOS where load() -> play() does not.
     */
    swapAndPlay(src: string): void {
        iosAudioLog("swapAndPlay:entry", "audio-controller:swapAndPlay", this.audio, { src: src.slice(-40) });
        this.cancelNetworkRetry();
        this.stopWatchdog();
        this.cancelStallGrace();
        this.cancelSilentPlaybackWatchdog();
        this.currentSrc = src;
        this.audio.src = src;
        this.audio.play().then(() => {
            this.startSilentPlaybackWatchdog();
        }).catch((err) => {
            if (err instanceof DOMException && err.name === "NotAllowedError") {
                this.emit("needs-resume");
                return;
            }
            if (err instanceof DOMException && err.name === "AbortError") {
                this.reloadAndPlay();
                return;
            }
            console.error("[AudioController] swapAndPlay failed:", err);
            this.emit("error", { error: err instanceof Error ? err.message : String(err) });
        });
    }

    stop(): void {
        this.audio.pause();
        this.audio.currentTime = 0;
    }

    load(src: string, autoplay: boolean = false): void {
        iosAudioLog("load:entry", "audio-controller:load", this.audio, {
            autoplay,
            sameSrc: this.currentSrc === src,
        });
        if (this.currentSrc === src && this.audio.readyState >= 2) {
            if (autoplay && this.audio.paused) {
                this.play();
            }
            return;
        }

        this.cancelNetworkRetry();
        this.stopWatchdog();
        this.cancelStallGrace();
        this.currentSrc = src;
        this.audio.src = src;

        if (autoplay) {
            this.play();
        }
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

    preloadHint(src: string): void {
        if (this.prefetchLink) {
            this.prefetchLink.remove();
            this.prefetchLink = null;
        }

        const link = document.createElement("link");
        link.rel = "prefetch";
        link.as = "fetch";
        link.href = src;
        link.dataset.preloadAudio = "true";
        document.head.appendChild(link);
        this.prefetchLink = link;
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

    /**
     * iOS deep-suspension check: the element reports "playing" (paused=false)
     * but the AudioContext is suspended/interrupted, so no audio is routing --
     * the genuine "playing but silent" nap-mode state. tryResume() short-circuits
     * on !paused and cannot detect this, so handleForeground uses this to surface
     * the Tap-to-resume prompt when the user is foregrounded and can act.
     */
    isPlayingButContextSuspended(): boolean {
        if (!this.isIosStandalone()) return false;
        if (this.audio.paused || this.audio.ended) return false;
        // WebKit's "interrupted" state is outside the standard AudioContextState
        // union, so widen to string before comparing.
        const s = this.audioContext?.state as string | undefined;
        return s === "suspended" || s === "interrupted";
    }

    hasAudio(): boolean {
        return this.audio.readyState >= 2;
    }

    getState(): Readonly<{ currentSrc: string | null; volume: number; isMuted: boolean }> {
        return { currentSrc: this.currentSrc, volume: this.volume, isMuted: this.isMuted };
    }

    setVolume(volume: number): void {
        this.volume = Math.max(0, Math.min(1, volume));
        if (!this.isMuted) {
            this.audio.volume = this.volume;
        }
    }

    setMuted(muted: boolean): void {
        this.isMuted = muted;
        this.audio.volume = muted ? 0 : this.volume;
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

    on(event: AudioControllerEvent, callback: AudioControllerCallback): void {
        this.eventListeners.get(event)?.add(callback);
    }

    off(event: AudioControllerEvent, callback: AudioControllerCallback): void {
        this.eventListeners.get(event)?.delete(callback);
    }

    private emit(event: AudioControllerEvent, data?: unknown): void {
        this.eventListeners.get(event)?.forEach((callback) => {
            try {
                callback(data);
            } catch (err) {
                console.error(`[AudioController] Event listener error (${event}):`, err);
            }
        });
    }

    private cancelNetworkRetry(): void {
        if (this.networkRetryTimeout) {
            clearTimeout(this.networkRetryTimeout);
            this.networkRetryTimeout = null;
        }
        this.networkRetryCount = 0;
        this.stallRecoveryCount = 0;
        this.retrySeekTime = null;
        this.autoResumeAfterRecovery = false;
    }

    cleanup(): void {
        this.cancelNetworkRetry();
        this.stopWatchdog();
        this.cancelStallGrace();
        this.cancelSilentPlaybackWatchdog();
        this.clearReloadFailsafe();
        this.audio.pause();
        this.audio.removeAttribute("src");
        this.audio.load();
        this.currentSrc = null;

        if (this.prefetchLink) {
            this.prefetchLink.remove();
            this.prefetchLink = null;
        }
    }

    destroy(): void {
        this.cleanup();
        this.detachNativeListeners();

        this.eventListeners.clear();
    }
}
