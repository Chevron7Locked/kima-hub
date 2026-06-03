"use client";

type IosAudioLogEvent = {
    t: number;
    name: string;
    site: string;
    paused: boolean | null;
    currentTime: number | null;
    readyState: number | null;
    duration: number | null;
    visibility: string | null;
    hasFocus: boolean | null;
    extra?: Record<string, unknown>;
};

const MAX_EVENTS = 200;
const STORAGE_KEY = "kima_ios_audio_log";
const FLAG_KEY = "kima_ios_debug";

let buffer: IosAudioLogEvent[] = [];
let enabled: boolean | null = null;

function detectEnabled(): boolean {
    if (enabled !== null) return enabled;
    if (typeof window === "undefined") return false;
    try {
        const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
        const standalone =
            (navigator as { standalone?: boolean }).standalone === true ||
            window.matchMedia?.("(display-mode: standalone)").matches === true;
        const flagged = window.localStorage.getItem(FLAG_KEY) === "1";
        // Auto-capture in the installed iOS PWA -- it has no URL bar to set
        // ?ios_debug=1, so the ring buffer must be available unconditionally for
        // the auto-upload below. (Temporary diagnostic aid.)
        enabled = isIos && (standalone || flagged);
        if (enabled) {
            const stored = window.sessionStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed)) buffer = parsed.slice(-MAX_EVENTS);
            }
        }
    } catch {
        enabled = false;
    }
    return enabled;
}

export function applyIosDebugQueryFlag(): void {
    if (typeof window === "undefined") return;
    try {
        const params = new URLSearchParams(window.location.search);
        const v = params.get("ios_debug");
        if (v === "1") window.localStorage.setItem(FLAG_KEY, "1");
        else if (v === "0") window.localStorage.removeItem(FLAG_KEY);
        enabled = null;
    } catch {
        // ignore
    }
}

export function iosAudioLog(
    name: string,
    site: string,
    audio?: HTMLAudioElement | null,
    extra?: Record<string, unknown>,
): void {
    if (!detectEnabled()) return;
    const evt: IosAudioLogEvent = {
        t: Date.now(),
        name,
        site,
        paused: audio ? audio.paused : null,
        currentTime: audio ? audio.currentTime : null,
        readyState: audio ? audio.readyState : null,
        duration: audio && isFinite(audio.duration) ? audio.duration : null,
        visibility: typeof document !== "undefined" ? document.visibilityState : null,
        hasFocus: typeof document !== "undefined" ? document.hasFocus() : null,
        extra,
    };
    buffer.push(evt);
    if (buffer.length > MAX_EVENTS) buffer = buffer.slice(-MAX_EVENTS);
    try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
    } catch {
        // sessionStorage full or unavailable -- not fatal
    }
    scheduleAutoUpload();
}

// Debounced auto-archive: after a burst of audio events settles, POST the ring
// buffer to the server so the trace arrives without a manual Upload tap -- the
// installed iOS PWA can't navigate to /debug/ios-log. Temporary diagnostic aid.
let uploadTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutoUpload(): void {
    if (uploadTimer || typeof window === "undefined") return;
    uploadTimer = setTimeout(() => {
        uploadTimer = null;
        try {
            void fetch("/api/debug/ios-log", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ events: buffer }),
            }).catch(() => {});
        } catch {
            // ignore
        }
    }, 3000);
}

export function readIosAudioLog(): IosAudioLogEvent[] {
    return buffer.slice();
}

export function clearIosAudioLog(): void {
    buffer = [];
    try {
        window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}

export function isIosAudioDebugEnabled(): boolean {
    return detectEnabled();
}
