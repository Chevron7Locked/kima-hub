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
// Whether the visibility/pagehide flush listeners have been registered.
// Registered lazily on first log call so disabled users pay zero listener cost.
let listenersRegistered = false;

function detectEnabled(): boolean {
    if (enabled !== null) return enabled;
    if (typeof window === "undefined") return false;
    try {
        const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
        const flagged = window.localStorage.getItem(FLAG_KEY) === "1";
        // Auto-capture graduated out: the unconditional standalone enable was itself
        // perturbing the system under observation. The kima_ios_debug localStorage flag
        // (set via ?ios_debug=1) is the sole enable path. An in-app Settings toggle
        // ("Capture playback diagnostics") will be added with the support-bundle feature
        // (docs/plans/2026-06-04-diagnostics-support-bundle.md).
        enabled = isIos && flagged;
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

// Flush the in-memory ring buffer to sessionStorage. Called on visibility hide,
// pagehide, and immediately before each debounced upload POST.
//
// Trade-off (R16, accepted): if iOS kills the PWA without firing visibilitychange
// or pagehide, the unflushed tail is lost -- one of the crash classes diagnostics
// exist for. Accepted because the per-event synchronous write was itself a
// perturbation of the system under observation, and the 3s debounced upload bounds
// the loss window in practice.
function flushToStorage(): void {
    try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
    } catch {
        // sessionStorage full or unavailable -- not fatal
    }
}

function registerFlushListeners(): void {
    if (listenersRegistered || typeof window === "undefined") return;
    listenersRegistered = true;
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flushToStorage();
    });
    window.addEventListener("pagehide", flushToStorage);
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
    registerFlushListeners();
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
    scheduleAutoUpload();
}

// Debounced auto-archive: after a burst of audio events settles, POST the ring
// buffer to the server so the trace arrives without a manual Upload tap -- the
// installed iOS PWA can't navigate to /debug/ios-log.
let uploadTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutoUpload(): void {
    if (uploadTimer || typeof window === "undefined") return;
    uploadTimer = setTimeout(() => {
        uploadTimer = null;
        try {
            // Flush to sessionStorage immediately before each upload so the persisted
            // copy stays in sync with what we send.
            flushToStorage();
            // The /api/debug/ios-log route is requireAuth (Bearer), so the upload
            // MUST send the token the same way the api client does -- cookies
            // alone 401, and the .catch below would swallow it silently (which is
            // exactly why no trace was ever captured before).
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            let token: string | null = null;
            try {
                token = window.localStorage.getItem("auth_token");
            } catch {
                // localStorage unavailable
            }
            if (token) headers["Authorization"] = `Bearer ${token}`;
            void fetch("/api/debug/ios-log", {
                method: "POST",
                headers,
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
