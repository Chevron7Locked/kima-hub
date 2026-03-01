// frontend/lib/audio-engine.ts

/**
 * Native HTML5 Audio Engine
 *
 * Singleton manager for audio playback using a single <audio> element.
 * Replaces Howler.js - the browser handles buffering, seeking, and format detection.
 */

export type AudioEngineEvent =
    | "play"
    | "pause"
    | "ended"
    | "timeupdate"
    | "loading"
    | "canplay"
    | "error"
    | "waiting"
    | "seeked";

export type AudioEngineCallback = (data?: unknown) => void;

class AudioEngine {
    private audio: HTMLAudioElement | null = null;
    private timeUpdateInterval: NodeJS.Timeout | null = null;
    private eventListeners: Map<AudioEngineEvent, Set<AudioEngineCallback>> = new Map();
    private nativeListeners: Array<{ event: string; handler: EventListener }> = [];
    private state = {
        currentSrc: null as string | null,
        volume: 1,
        isMuted: false,
    };

    private networkRetryCount = 0;
    private readonly MAX_NETWORK_RETRIES = 2;
    private networkRetryTimeout: ReturnType<typeof setTimeout> | null = null;
    private retrySeekTime: number | null = null;

    // Preload for gapless playback
    private preloadAudio: HTMLAudioElement | null = null;
    private preloadSrc: string | null = null;

    constructor() {
        const events: AudioEngineEvent[] = [
            "play", "pause", "ended", "timeupdate",
            "loading", "canplay", "error", "waiting", "seeked",
        ];
        events.forEach((e) => this.eventListeners.set(e, new Set()));

        if (typeof window !== "undefined") {
            this.audio = new Audio();
            this.audio.preload = "auto";
            this.attachNativeListeners(this.audio);

            // Explicitly request the playback audio session category on Safari 16.4+.
            // <audio> elements get this automatically, but setting it explicitly
            // ensures the session category is correct before first playback.
            try {
                const nav = navigator as { audioSession?: { type: string } };
                if (nav.audioSession) {
                    nav.audioSession.type = "playback";
                }
            } catch {
                // Not supported on this platform
            }
        }
    }

    private attachNativeListeners(audio: HTMLAudioElement): void {
        // Detach any existing listeners first
        this.detachNativeListeners();

        const add = (event: string, handler: EventListener) => {
            audio.addEventListener(event, handler);
            this.nativeListeners.push({ event, handler });
        };

        add("play", () => {
            this.startTimeUpdates();
        });

        add("pause", () => {
            this.stopTimeUpdates();
            this.emit("pause");
        });

        add("ended", () => {
            this.stopTimeUpdates();
            this.emit("ended");
        });

        add("canplay", () => {
            if (this.retrySeekTime !== null) {
                const seekTo = this.retrySeekTime;
                this.retrySeekTime = null;
                try { audio.currentTime = seekTo; } catch {}
            }
            this.emit("canplay", { duration: audio.duration || 0 });
        });

        add("waiting", () => {
            this.emit("waiting");
        });

        // "playing" fires when audio data is actually being rendered.
        // This is the single source of truth for "audio is producing sound" --
        // the native "play" event fires too early (before buffering completes).
        add("playing", () => {
            this.emit("play");
        });

        add("error", () => {
            const err = audio.error;

            // Auto-retry on network errors (MEDIA_ERR_NETWORK = code 2) with backoff
            if (
                err?.code === 2 &&
                this.networkRetryCount < this.MAX_NETWORK_RETRIES &&
                this.state.currentSrc
            ) {
                this.networkRetryCount++;
                const delay = this.networkRetryCount * 2000;
                console.warn(
                    `[AudioEngine] Network error, retrying in ${delay}ms (attempt ${this.networkRetryCount}/${this.MAX_NETWORK_RETRIES})`
                );
                this.networkRetryTimeout = setTimeout(() => {
                    if (this.audio && this.state.currentSrc) {
                        this.retrySeekTime = this.audio.currentTime || null;
                        this.audio.load();
                        this.audio.play().catch((playErr) => {
                            // play() failed (e.g. iOS background, no gesture context).
                            // Emit error so UI/MediaSession can update instead of
                            // silently leaving state as "playing".
                            console.warn("[AudioEngine] Retry play() failed:", playErr);
                            // Exhaust retry count so any subsequent native error from
                            // the load() falls through to the terminal error path
                            // instead of creating an infinite retry loop.
                            this.networkRetryCount = this.MAX_NETWORK_RETRIES;
                            this.stopTimeUpdates();
                            this.emit("error", {
                                error: "Playback interrupted - unable to resume in background",
                                code: 2,
                            });
                        });
                    }
                }, delay);
                return;
            }

            this.stopTimeUpdates();
            this.emit("error", {
                error: err?.message || "Audio playback error",
                code: err?.code,
            });
        });

        add("seeked", () => {
            this.emit("seeked", { time: audio.currentTime });
        });

        add("loadstart", () => {
            this.emit("loading");
        });
    }

    private detachNativeListeners(): void {
        if (!this.audio) return;
        for (const { event, handler } of this.nativeListeners) {
            this.audio.removeEventListener(event, handler);
        }
        this.nativeListeners = [];
    }

    /**
     * Initialize engine with saved preferences.
     * Call before first playback.
     */
    initializeFromStorage(): void {
        if (typeof window === "undefined" || !this.audio) return;

        try {
            const savedVolume = localStorage.getItem("kima_volume");
            const savedMuted = localStorage.getItem("kima_muted");

            if (savedVolume) {
                const parsed = parseFloat(savedVolume);
                if (!isNaN(parsed)) {
                    this.state.volume = Math.max(0, Math.min(1, parsed));
                }
            }
            if (savedMuted === "true") {
                this.state.isMuted = true;
            }

            this.audio.volume = this.state.isMuted ? 0 : this.state.volume;
        } catch (error) {
            console.error("[AudioEngine] Failed to initialize from storage:", error);
        }
    }

    /**
     * Load and optionally play a new audio source.
     * Setting audio.src automatically stops current playback and starts loading.
     * Calling play() while loading is valid - browser queues it until ready.
     */
    load(src: string, autoplay: boolean = false): void {
        if (!this.audio) return;

        // Same source and already loaded - just play if requested
        if (this.state.currentSrc === src && this.audio.readyState >= 2) {
            if (autoplay && this.audio.paused) {
                this.play();
            }
            return;
        }

        // Check if this source is preloaded for gapless switching
        if (this.preloadSrc === src && this.preloadAudio && this.preloadAudio.readyState >= 2) {
            this.cancelNetworkRetry();
            const oldAudio = this.audio;

            // Detach native listeners from old element
            this.detachNativeListeners();

            // Stop old audio
            oldAudio.pause();
            oldAudio.removeAttribute("src");
            oldAudio.load(); // Release resources

            // Swap to preloaded element
            this.audio = this.preloadAudio;
            this.preloadAudio = null;
            this.preloadSrc = null;

            // Attach listeners to new element
            this.attachNativeListeners(this.audio);

            this.state.currentSrc = src;
            this.audio.volume = this.state.isMuted ? 0 : this.state.volume;

            // Emit canplay since it's already loaded
            this.emit("canplay", { duration: this.audio.duration || 0 });

            if (autoplay) {
                this.play();
            }
            return;
        }

        // Normal load path
        this.cancelNetworkRetry();
        this.state.currentSrc = src;
        this.audio.src = src;
        // Setting src stops any current playback and starts loading the new source.

        if (autoplay) {
            // play() returns a promise - browser queues playback until audio is ready.
            // No need for canplay listener or loading guards.
            this.play();
        }
    }

    /**
     * Play audio. Returns promise that resolves when playback starts.
     * Safe to call during loading - browser queues it.
     */
    async play(): Promise<void> {
        if (!this.audio || !this.audio.src) return;

        try {
            await this.audio.play();
        } catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") {
                // Load was aborted by a new src change - harmless, ignore
                return;
            }
            console.error("[AudioEngine] Play failed:", err);
            this.emit("error", { error: err instanceof Error ? err.message : String(err) });
        }
    }

    /**
     * Attempt to resume playback without emitting error events.
     * Used for direct resumption from MediaSession handlers or visibility recovery,
     * where a failed play should not trigger the error→skip-track flow.
     * Returns true if playback started successfully.
     */
    async tryResume(): Promise<boolean> {
        if (!this.audio || !this.audio.src) return false;
        if (!this.audio.paused) return true;
        try {
            await this.audio.play();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Pause audio.
     */
    pause(): void {
        if (!this.audio) return;
        this.audio.pause();
    }

    /**
     * Stop playback and reset position.
     */
    stop(): void {
        if (!this.audio) return;
        this.audio.pause();
        this.audio.currentTime = 0;
    }

    /**
     * Seek to a specific time. Synchronous - updates currentTime immediately.
     */
    seek(time: number): void {
        if (!this.audio) return;

        const duration = this.audio.duration || 0;
        if (duration > 0) {
            time = Math.max(0, Math.min(time, duration));
        } else {
            time = Math.max(0, time);
        }
        try {
            this.audio.currentTime = time;
        } catch (err) {
            // InvalidStateError if audio not ready (readyState < HAVE_METADATA)
            console.warn("[AudioEngine] Seek failed:", err);
        }
    }

    /**
     * Get current playback position.
     */
    getCurrentTime(): number {
        return this.audio?.currentTime || 0;
    }

    /**
     * Get audio duration.
     */
    getDuration(): number {
        const d = this.audio?.duration;
        return d && isFinite(d) ? d : 0;
    }

    /**
     * Check if currently playing (not paused and not ended).
     */
    isPlaying(): boolean {
        if (!this.audio) return false;
        return !this.audio.paused && !this.audio.ended;
    }

    /**
     * Check if audio is loaded and ready to play.
     */
    hasAudio(): boolean {
        if (!this.audio) return false;
        return this.audio.readyState >= 2; // HAVE_CURRENT_DATA
    }

    /**
     * Set volume (0-1).
     */
    setVolume(volume: number): void {
        this.state.volume = Math.max(0, Math.min(1, volume));
        if (this.audio && !this.state.isMuted) {
            this.audio.volume = this.state.volume;
        }
    }

    /**
     * Mute/unmute.
     */
    setMuted(muted: boolean): void {
        this.state.isMuted = muted;
        if (this.audio) {
            this.audio.volume = muted ? 0 : this.state.volume;
        }
    }

    /**
     * Get current engine state.
     */
    getState(): Readonly<{ currentSrc: string | null; volume: number; isMuted: boolean }> {
        return { ...this.state };
    }

    /**
     * Preload a track in the background for gapless playback.
     */
    preload(src: string): void {
        if (this.state.currentSrc === src || this.preloadSrc === src) return;

        this.cancelPreload();
        this.preloadSrc = src;
        this.preloadAudio = new Audio();
        this.preloadAudio.preload = "auto";
        this.preloadAudio.volume = 0; // Silent preload
        this.preloadAudio.src = src;
    }

    /**
     * Cancel any in-progress preload.
     */
    cancelPreload(): void {
        if (this.preloadAudio) {
            this.preloadAudio.pause();
            this.preloadAudio.removeAttribute("src");
            this.preloadAudio.load(); // Release resources
            this.preloadAudio = null;
        }
        this.preloadSrc = null;
    }

    /**
     * Check if a source is preloaded and ready.
     */
    isPreloaded(src: string): boolean {
        return (
            this.preloadSrc === src &&
            this.preloadAudio !== null &&
            this.preloadAudio.readyState >= 2
        );
    }

    /**
     * Subscribe to events.
     */
    on(event: AudioEngineEvent, callback: AudioEngineCallback): void {
        this.eventListeners.get(event)?.add(callback);
    }

    /**
     * Unsubscribe from events.
     */
    off(event: AudioEngineEvent, callback: AudioEngineCallback): void {
        this.eventListeners.get(event)?.delete(callback);
    }

    private emit(event: AudioEngineEvent, data?: unknown): void {
        this.eventListeners.get(event)?.forEach((callback) => {
            try {
                callback(data);
            } catch (err) {
                console.error(`[AudioEngine] Event listener error (${event}):`, err);
            }
        });
    }

    private startTimeUpdates(): void {
        this.stopTimeUpdates();
        this.timeUpdateInterval = setInterval(() => {
            if (this.audio && !this.audio.paused) {
                this.emit("timeupdate", { time: this.audio.currentTime });
            }
        }, 250); // 4 updates per second
    }

    private stopTimeUpdates(): void {
        if (this.timeUpdateInterval) {
            clearInterval(this.timeUpdateInterval);
            this.timeUpdateInterval = null;
        }
    }

    /**
     * Clean up current audio. Stops playback and releases resources.
     */
    cleanup(): void {
        this.cancelPreload();
        this.stopTimeUpdates();
        this.cancelNetworkRetry();

        if (this.audio) {
            this.audio.pause();
            this.audio.removeAttribute("src");
            this.audio.load(); // Release resources
        }

        this.state.currentSrc = null;
    }

    private cancelNetworkRetry(): void {
        if (this.networkRetryTimeout) {
            clearTimeout(this.networkRetryTimeout);
            this.networkRetryTimeout = null;
        }
        this.networkRetryCount = 0;
        this.retrySeekTime = null;
    }

    /**
     * Destroy the engine completely.
     */
    destroy(): void {
        this.cleanup();
        this.detachNativeListeners();
        this.eventListeners.clear();
    }
}

// Singleton instance
export const audioEngine = new AudioEngine();

// Export class for testing
export { AudioEngine };
