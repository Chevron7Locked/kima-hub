"use client";

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

    private attachNativeListeners(): void {
        const add = (event: string, handler: EventListener) => {
            this.audio.addEventListener(event, handler);
            this.nativeListeners.push({ event, handler });
        };

        add("playing", () => {
            this.networkRetryCount = 0;
            this.stallRecoveryCount = 0;
            this.startWatchdog();
            this.cancelStallGrace();
            this.emit("play");
        });

        add("pause", () => {
            this.stopWatchdog();
            this.emit("pause");
        });

        add("ended", () => {
            this.stopWatchdog();
            this.emit("ended");
        });

        add("timeupdate", () => {
            this.cancelStallGrace();
            this.emit("timeupdate", { time: this.audio.currentTime });
        });

        add("canplay", () => {
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

    async play(): Promise<void> {
        if (!this.audio.src) return;

        this.setAudioSessionPlayback();

        try {
            await this.audio.play();
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") {
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

        try {
            await this.audio.play();
            return true;
        } catch {
            return false;
        }
    }

    pause(): void {
        this.autoResumeAfterRecovery = false;
        this.audio.pause();
    }

    notifyForeground(): void {
        if (this.watchdogInterval) {
            this.resetWatchdog();
        }
        this.cancelStallGrace();
    }

    stop(): void {
        this.audio.pause();
        this.audio.currentTime = 0;
    }

    load(src: string, autoplay: boolean = false): void {
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
