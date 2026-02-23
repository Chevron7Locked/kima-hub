/**
 * SilenceKeepalive - Maintains the OS audio session while user audio is paused.
 *
 * iOS and Android may reclaim the audio session when a PWA is backgrounded with
 * audio paused. This breaks MediaSession lock-screen controls and causes subsequent
 * audio.play() calls to be blocked until the app is foregrounded.
 *
 * Keeping an inaudible audio element playing prevents the OS from reclaiming
 * the session. The element loops a programmatically-generated silent WAV so no
 * static asset is required.
 *
 * Usage:
 *   silenceKeepalive.prime()  — call from a user-gesture handler to unlock autoplay
 *   silenceKeepalive.start()  — begin looping silence (backgrounded + paused)
 *   silenceKeepalive.stop()   — stop when main audio resumes or media clears
 */

function buildSilentWavBlob(): Blob {
    // 1-second mono 8-bit PCM WAV at 8 kHz — ~8 KB, universally supported
    const sampleRate = 8000;
    const numSamples = sampleRate;
    const buffer = new ArrayBuffer(44 + numSamples);
    const view = new DataView(buffer);

    // RIFF header
    view.setUint32(0, 0x52494646, false); // "RIFF"
    view.setUint32(4, 36 + numSamples, true);
    view.setUint32(8, 0x57415645, false); // "WAVE"

    // fmt chunk
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true);          // chunk size
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);  // byteRate = sampleRate × 1ch × 1byte
    view.setUint16(32, 1, true);           // blockAlign
    view.setUint16(34, 8, true);           // bitsPerSample

    // data chunk
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, numSamples, true);
    // 8-bit PCM silence = 128 (midpoint), not 0 (which is maximum negative)
    new Uint8Array(buffer, 44).fill(128);

    return new Blob([buffer], { type: "audio/wav" });
}

class SilenceKeepalive {
    private audio: HTMLAudioElement | null = null;
    private blobUrl: string | null = null;

    private getAudio(): HTMLAudioElement {
        if (this.audio) return this.audio;

        const blob = buildSilentWavBlob();
        this.blobUrl = URL.createObjectURL(blob);

        const el = new Audio(this.blobUrl);
        el.loop = true;
        // Volume near-zero rather than exactly 0 — some platforms may skip the
        // session heartbeat for a mathematically-silent output graph.
        el.volume = 0.001;

        this.audio = el;
        return el;
    }

    /**
     * Unlock the audio element for future programmatic play calls.
     * Must be called from a user-gesture handler (click, touch, or MediaSession action).
     * Delegates to start() — kept as a separate call-site name so MediaSession handlers
     * read as "prime the keepalive" rather than "start" (intent over implementation).
     */
    prime(): void {
        this.start();
    }

    /**
     * Start looping silence to keep the audio session alive.
     * Call when the app is backgrounded with user audio paused, or from a user-gesture
     * context to unlock the element for subsequent backgrounded calls.
     */
    start(): void {
        if (typeof window === "undefined") return;
        const el = this.getAudio();
        if (!el.paused) return;
        el.play().catch(() => {
            // Will be retried on next prime() call or visibility change.
        });
    }

    /**
     * Stop looping silence.
     * Call when main audio resumes or no media is loaded.
     */
    stop(): void {
        if (!this.audio || this.audio.paused) return;
        this.audio.pause();
    }

    destroy(): void {
        this.stop();
        this.audio = null;
        if (this.blobUrl) {
            URL.revokeObjectURL(this.blobUrl);
            this.blobUrl = null;
        }
    }
}

export const silenceKeepalive = new SilenceKeepalive();
