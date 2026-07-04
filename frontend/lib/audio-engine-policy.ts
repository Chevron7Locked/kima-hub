/**
 * Audio engine policy -- pure state machine.
 * No DOM access, no Date.now(), no randomness. All time comes from events via `now`.
 */

export type EngineStatus =
    | "idle"
    | "loading"
    | "playing"
    | "buffering"
    | "paused"
    | "recovering"
    | "blocked"
    | "error";

export type PauseClass = "user" | "system";

export type TimerId = "nudge-settle" | "reload-settle" | "load-deadline";

export interface EngineSnapshot {
    status: EngineStatus;
    intent: "play" | "pause";
    pauseClass: PauseClass | null;
    src: string | null;
    generation: number;
    currentTime: number;
    duration: number;
    error: { message: string; code: number } | null;
    attempts: number;
    lastProgressAt: number;
    progressStreakStartedAt: number | null;
    rung: "none" | "nudge-wait" | "reload-wait";
    pendingSeek: number | null;
    resumeOnForeground: boolean;
    // Tracks document.hidden from the most recent tick delivered to us.
    lastKnownHidden: boolean;
}

export type EngineEvent =
    | { type: "load"; src: string; autoplay: boolean; seekTo?: number; now: number }
    | { type: "play-requested"; now: number }
    | { type: "pause-requested"; cls: PauseClass; now: number }
    | { type: "native-playing"; now: number }
    | { type: "native-pause"; now: number }
    | { type: "native-ended"; currentTime: number; duration: number; now: number }
    | { type: "native-canplay"; duration: number; now: number }
    | { type: "native-waiting"; now: number }
    | { type: "native-error"; code: number; message: string; now: number }
    | {
          type: "tick";
          currentTime: number;
          readyState: number;
          paused: boolean;
          hidden: boolean;
          now: number;
      }
    | { type: "timer-fired"; timer: TimerId; now: number }
    | {
          type: "play-rejected";
          reason: "not-allowed" | "abort" | "other";
          generation: number;
          now: number;
      }
    | { type: "foreground"; now: number }
    | { type: "cleanup"; now: number }
    | { type: "silent-playback-detected"; now: number };

export type Effect =
    | { kind: "set-src-and-load"; src: string }
    | { kind: "seek"; time: number }
    | { kind: "call-play" }
    | { kind: "call-pause" }
    | { kind: "arm-timer"; timer: TimerId; ms: number }
    | { kind: "cancel-timer"; timer: TimerId }
    | { kind: "claim-session" }
    | { kind: "emit-ended" }
    | { kind: "emit-error" };

export const RECOVERY = {
    bufferingDeadlineMs: 30_000,
    stallDeadlineMs: 5_000,
    nudgeSettleMs: 4_000,
    reloadSettleMs: 12_000,
    loadDeadlineMs: 15_000,
    maxAttempts: 4,
    budgetResetAfterMs: 60_000,
    endedToleranceS: 3,
} as const;

// Status set for which the recovery ladder is active.
const LADDER_ACTIVE_STATUSES = new Set<EngineStatus>([
    "playing",
    "buffering",
    "recovering",
]);

// Status set that allows immediate escalation (not idle/paused/blocked/error).
const ESCALATABLE_STATUSES = new Set<EngineStatus>([
    "playing",
    "buffering",
    "loading",
    "recovering",
]);

export function initialSnapshot(): EngineSnapshot {
    return {
        status: "idle",
        intent: "pause",
        pauseClass: null,
        src: null,
        generation: 0,
        currentTime: 0,
        duration: 0,
        error: null,
        attempts: 0,
        lastProgressAt: 0,
        progressStreakStartedAt: null,
        rung: "none",
        pendingSeek: null,
        resumeOnForeground: false,
        lastKnownHidden: false,
    };
}

// Cancel both timers -- used whenever we leave the ladder.
function cancelBothTimers(): Effect[] {
    return [
        { kind: "cancel-timer", timer: "nudge-settle" },
        { kind: "cancel-timer", timer: "reload-settle" },
        { kind: "cancel-timer", timer: "load-deadline" },
    ];
}

type TransitionResult = { snapshot: EngineSnapshot; effects: Effect[] };

/**
 * Start the nudge rung. Increments attempts and arms the nudge-settle timer.
 * Does NOT mutate the input.
 */
function startNudgeRung(snap: EngineSnapshot, now: number): TransitionResult {
    void now;
    const newAttempts = snap.attempts + 1;
    return {
        snapshot: {
            ...snap,
            status: "recovering",
            rung: "nudge-wait",
            attempts: newAttempts,
            progressStreakStartedAt: null,
        },
        effects: [
            { kind: "cancel-timer", timer: "reload-settle" },
            { kind: "seek", time: snap.currentTime },
            { kind: "arm-timer", timer: "nudge-settle", ms: RECOVERY.nudgeSettleMs },
        ],
    };
}

/**
 * Start the reload rung. Does NOT increment attempts (caller already did via
 * startNudgeRung, or this is a direct escalation from native-error).
 * Applies the park policy: if hidden, park instead of calling play.
 */
function startReloadRung(
    snap: EngineSnapshot,
    resumeAt: number,
    _now: number,
): TransitionResult {
    if (!snap.src) {
        return {
            snapshot: {
                ...snap,
                status: "error",
                error: { message: "Playback stalled repeatedly", code: 99 },
                rung: "none",
                progressStreakStartedAt: null,
            },
            effects: [...cancelBothTimers(), { kind: "emit-error" }],
        };
    }

    const pendingSeek = resumeAt > 0 ? resumeAt : null;

    // Park policy: if hidden, do not call play.
    if (snap.lastKnownHidden) {
        return {
            snapshot: {
                ...snap,
                status: "paused",
                pauseClass: "system",
                rung: "none",
                resumeOnForeground: true,
                pendingSeek,
                progressStreakStartedAt: null,
            },
            effects: [
                ...cancelBothTimers(),
                { kind: "set-src-and-load", src: snap.src },
            ],
        };
    }

    return {
        snapshot: {
            ...snap,
            status: "recovering",
            rung: "reload-wait",
            pendingSeek,
            progressStreakStartedAt: null,
        },
        effects: [
            { kind: "cancel-timer", timer: "nudge-settle" },
            { kind: "set-src-and-load", src: snap.src },
            { kind: "arm-timer", timer: "reload-settle", ms: RECOVERY.reloadSettleMs },
            { kind: "claim-session" },
            { kind: "call-play" },
        ],
    };
}

/**
 * Direct escalation to error terminal state.
 */
function enterError(
    snap: EngineSnapshot,
    message: string,
    code: number,
): TransitionResult {
    return {
        snapshot: {
            ...snap,
            status: "error",
            error: { message, code },
            rung: "none",
            progressStreakStartedAt: null,
        },
        effects: [...cancelBothTimers(), { kind: "emit-error" }],
    };
}

/**
 * Escalate: pick nudge first, then reload, then error.
 * Increments attempts before nudge rung (counted once per rung pair).
 * For direct escalation (native-error) that skips nudge, attempts++ is
 * also done here to keep the semantics consistent.
 */
function escalate(
    snap: EngineSnapshot,
    now: number,
    skipNudge: boolean,
): TransitionResult {
    if (snap.attempts >= RECOVERY.maxAttempts) {
        return enterError(snap, "Playback stalled repeatedly", 99);
    }

    if (skipNudge) {
        const withAttempts = { ...snap, attempts: snap.attempts + 1 };
        if (withAttempts.attempts >= RECOVERY.maxAttempts) {
            return enterError(withAttempts, "Playback stalled repeatedly", 99);
        }
        return startReloadRung(withAttempts, snap.currentTime, now);
    }

    return startNudgeRung(snap, now);
}

export function transition(
    snap: EngineSnapshot,
    event: EngineEvent,
): { snapshot: EngineSnapshot; effects: Effect[] } {
    switch (event.type) {
        case "load": {
            const effects: Effect[] = [
                ...cancelBothTimers(),
                { kind: "set-src-and-load", src: event.src },
                { kind: "arm-timer", timer: "load-deadline", ms: RECOVERY.loadDeadlineMs },
            ];
            if (event.autoplay) {
                effects.push({ kind: "claim-session" });
                effects.push({ kind: "call-play" });
            }
            return {
                snapshot: {
                    ...snap,
                    status: "loading",
                    src: event.src,
                    generation: snap.generation + 1,
                    attempts: 0,
                    rung: "none",
                    pendingSeek: event.seekTo ?? null,
                    intent: event.autoplay ? "play" : snap.intent,
                    error: null,
                    progressStreakStartedAt: null,
                    resumeOnForeground: false,
                    lastProgressAt: event.now,
                    currentTime: 0,
                    duration: snap.duration,
                },
                effects,
            };
        }

        case "play-requested": {
            // From error or blocked: treat as fresh retry.
            if (snap.status === "error" || snap.status === "blocked") {
                if (snap.src) {
                    const pendingSeek = snap.currentTime > 0 ? snap.currentTime : null;
                    return {
                        snapshot: {
                            ...snap,
                            status: "loading",
                            intent: "play",
                            attempts: 0,
                            rung: "none",
                            error: null,
                            pendingSeek,
                            progressStreakStartedAt: null,
                            lastProgressAt: event.now,
                        },
                        effects: [
                            ...cancelBothTimers(),
                            { kind: "claim-session" },
                            { kind: "set-src-and-load", src: snap.src },
                            { kind: "arm-timer", timer: "load-deadline", ms: RECOVERY.loadDeadlineMs },
                            { kind: "call-play" },
                        ],
                    };
                }
                // No src -- just update intent and claim session.
                return {
                    snapshot: {
                        ...snap,
                        intent: "play",
                        error: null,
                        status: snap.src ? "loading" : "idle",
                    },
                    effects: [{ kind: "claim-session" }, { kind: "call-play" }],
                };
            }
            return {
                snapshot: { ...snap, intent: "play" },
                effects: [{ kind: "claim-session" }, { kind: "call-play" }],
            };
        }

        case "pause-requested": {
            const newIntent = event.cls === "user" ? "pause" : snap.intent;
            return {
                snapshot: {
                    ...snap,
                    status: "paused",
                    intent: newIntent,
                    pauseClass: event.cls,
                    rung: "none",
                    progressStreakStartedAt: null,
                },
                effects: [...cancelBothTimers(), { kind: "call-pause" }],
            };
        }

        case "native-playing": {
            return {
                snapshot: {
                    ...snap,
                    status: "playing",
                    pauseClass: null,
                    rung: "none",
                    progressStreakStartedAt: snap.progressStreakStartedAt ?? event.now,
                    lastProgressAt: event.now,
                    resumeOnForeground: false,
                },
                effects: cancelBothTimers(),
            };
        }

        case "native-pause": {
            // Unexpected pause from native element (not initiated by our pause-requested).
            // Leave intent unchanged.
            return {
                snapshot: {
                    ...snap,
                    status: "paused",
                    pauseClass: "system",
                    rung: "none",
                    progressStreakStartedAt: null,
                    resumeOnForeground: snap.intent === "play",
                },
                effects: cancelBothTimers(),
            };
        }

        case "native-ended": {
            const { currentTime, duration } = event;
            const isHonest =
                isFinite(duration) &&
                duration > 0 &&
                currentTime >= duration - RECOVERY.endedToleranceS;

            if (!isHonest && snap.src && ESCALATABLE_STATUSES.has(snap.status)) {
                // Truncated delivery -- escalate like native-error (skip nudge).
                const updated: EngineSnapshot = {
                    ...snap,
                    currentTime: currentTime,
                    duration: duration,
                };
                const result = escalate(updated, event.now, true);
                return result;
            }

            return {
                snapshot: {
                    ...snap,
                    status: "paused",
                    currentTime: currentTime,
                    duration: duration,
                    rung: "none",
                    progressStreakStartedAt: null,
                },
                effects: [...cancelBothTimers(), { kind: "emit-ended" }],
            };
        }

        case "native-canplay": {
            const effects: Effect[] = [];
            let nextSnap: EngineSnapshot = { ...snap, duration: event.duration };

            // Apply pending seek.
            if (snap.pendingSeek !== null) {
                effects.push({ kind: "seek", time: snap.pendingSeek });
                nextSnap = { ...nextSnap, pendingSeek: null };
            }

            // Resolve reload-wait rung -- cancel the reload-settle timer but keep status
            // as determined below.
            if (snap.rung === "reload-wait") {
                effects.push({ kind: "cancel-timer", timer: "reload-settle" });
                // Do NOT cancel nudge-settle (it is not armed during reload-wait).
                nextSnap = { ...nextSnap, rung: "none" };
            }

            // Status: if intent is pause, stay paused/loading->paused.
            if (snap.intent === "pause") {
                nextSnap = {
                    ...nextSnap,
                    status: "paused",
                    rung: "none",
                    progressStreakStartedAt: null,
                };
                // Remove reload-settle cancel if we added it and cancel both instead.
                return {
                    snapshot: nextSnap,
                    effects: [...cancelBothTimers(), ...effects.filter(
                        (e) => e.kind !== "cancel-timer",
                    )],
                };
            }

            // Otherwise keep status unchanged; native-playing confirms playing.
            return { snapshot: nextSnap, effects };
        }

        case "native-waiting": {
            if (snap.status === "playing") {
                return {
                    snapshot: { ...snap, status: "buffering" },
                    effects: [],
                };
            }
            return { snapshot: snap, effects: [] };
        }

        case "native-error": {
            const { code, message } = event;

            if (
                snap.src &&
                ESCALATABLE_STATUSES.has(snap.status) &&
                snap.attempts < RECOVERY.maxAttempts
            ) {
                // Escalate directly to reload rung (skip nudge) -- increment attempts here.
                const updated: EngineSnapshot = {
                    ...snap,
                    attempts: snap.attempts + 1,
                };
                if (updated.attempts >= RECOVERY.maxAttempts) {
                    const msg =
                        code === 2 ? "Network error -- tap to retry" : message;
                    return {
                        snapshot: {
                            ...updated,
                            status: "error",
                            error: { message: msg, code },
                            rung: "none",
                            progressStreakStartedAt: null,
                        },
                        effects: [...cancelBothTimers(), { kind: "emit-error" }],
                    };
                }
                const result = startReloadRung(updated, snap.currentTime, event.now);
                return result;
            }

            const msg = code === 2 ? "Network error -- tap to retry" : message;
            return {
                snapshot: {
                    ...snap,
                    status: "error",
                    error: { message: msg, code },
                    rung: "none",
                    progressStreakStartedAt: null,
                },
                effects: [...cancelBothTimers(), { kind: "emit-error" }],
            };
        }

        case "tick": {
            // Update hidden knowledge always.
            let nextSnap: EngineSnapshot = {
                ...snap,
                lastKnownHidden: event.hidden,
            };

            // If paused (defensive), do nothing further.
            if (event.paused) {
                return { snapshot: nextSnap, effects: [] };
            }

            // Ladder only runs in active statuses.
            if (!LADDER_ACTIVE_STATUSES.has(snap.status)) {
                return { snapshot: nextSnap, effects: [] };
            }

            const moved = event.currentTime !== snap.currentTime;

            if (moved) {
                nextSnap = {
                    ...nextSnap,
                    currentTime: event.currentTime,
                    lastProgressAt: event.now,
                    progressStreakStartedAt:
                        nextSnap.progressStreakStartedAt ?? event.now,
                };

                // Budget reset after sustained progress.
                if (
                    nextSnap.progressStreakStartedAt !== null &&
                    event.now - nextSnap.progressStreakStartedAt >=
                        RECOVERY.budgetResetAfterMs
                ) {
                    nextSnap = { ...nextSnap, attempts: 0 };
                }

                // If buffering/recovering and now moving with readyState >= 3 -> playing.
                if (
                    (snap.status === "buffering" || snap.status === "recovering") &&
                    event.readyState >= 3
                ) {
                    nextSnap = {
                        ...nextSnap,
                        status: "playing",
                        rung: "none",
                    };
                    return { snapshot: nextSnap, effects: cancelBothTimers() };
                }

                return { snapshot: nextSnap, effects: [] };
            }

            // No progress -- clear streak.
            nextSnap = {
                ...nextSnap,
                currentTime: event.currentTime,
                progressStreakStartedAt: null,
            };

            // Classify and escalate.
            const timeSinceProgress = event.now - snap.lastProgressAt;

            if (event.readyState < 3) {
                // Starved -- buffering deadline.
                if (timeSinceProgress >= RECOVERY.bufferingDeadlineMs) {
                    nextSnap = { ...nextSnap, status: "buffering" };
                    const result = escalate(nextSnap, event.now, false);
                    return result;
                }
                // Not at deadline yet -- just classify.
                if (snap.status === "playing") {
                    nextSnap = { ...nextSnap, status: "buffering" };
                }
                return { snapshot: nextSnap, effects: [] };
            }

            // readyState >= 3: stall deadline.
            if (timeSinceProgress >= RECOVERY.stallDeadlineMs) {
                const result = escalate(nextSnap, event.now, false);
                return result;
            }

            return { snapshot: nextSnap, effects: [] };
        }

        case "timer-fired": {
            if (event.timer === "nudge-settle") {
                // Nudge wait expired without progress -- go to reload rung.
                if (snap.rung !== "nudge-wait") {
                    return { snapshot: snap, effects: [] };
                }
                // Check if we've hit max attempts (we incremented at nudge start).
                if (snap.attempts >= RECOVERY.maxAttempts) {
                    return enterError(snap, "Playback stalled repeatedly", 99);
                }
                const result = startReloadRung(snap, snap.currentTime, event.now);
                return result;
            }

            if (event.timer === "reload-settle") {
                // Reload settle expired without canplay/progress.
                if (snap.rung !== "reload-wait") {
                    return { snapshot: snap, effects: [] };
                }
                // Try next attempt (nudge first).
                if (snap.attempts >= RECOVERY.maxAttempts) {
                    return enterError(snap, "Playback stalled repeatedly", 99);
                }
                // Start nudge rung for next cycle.
                const result = startNudgeRung(snap, event.now);
                return result;
            }

            if (event.timer === "load-deadline") {
                // Load stalled (iOS throttles setTimeout while backgrounded -- expected).
                if (snap.status !== "loading") {
                    return { snapshot: snap, effects: [] };
                }
                const updated: EngineSnapshot = { ...snap, status: "buffering" };
                return escalate(updated, event.now, false);
            }

            return { snapshot: snap, effects: [] };
        }

        case "play-rejected": {
            // Stale generation -- ignore entirely.
            if (event.generation !== snap.generation) {
                return { snapshot: snap, effects: [] };
            }

            if (event.reason === "not-allowed") {
                return {
                    snapshot: {
                        ...snap,
                        status: "blocked",
                        rung: "none",
                        progressStreakStartedAt: null,
                    },
                    effects: cancelBothTimers(),
                };
            }

            if (event.reason === "abort") {
                // Genuine iOS bad-state -- single reload rung attempt, unless already recovering.
                if (snap.status === "recovering") {
                    return { snapshot: snap, effects: [] };
                }
                if (snap.src && snap.attempts < RECOVERY.maxAttempts) {
                    const updated = { ...snap, attempts: snap.attempts + 1 };
                    if (updated.attempts >= RECOVERY.maxAttempts) {
                        return enterError(
                            updated,
                            "Playback stalled repeatedly",
                            99,
                        );
                    }
                    const result = startReloadRung(updated, snap.currentTime, event.now);
                    return result;
                }
                return enterError(snap, "Playback stalled repeatedly", 99);
            }

            // "other" -- terminal error.
            return {
                snapshot: {
                    ...snap,
                    status: "error",
                    error: { message: "Playback failed", code: 0 },
                    rung: "none",
                    progressStreakStartedAt: null,
                },
                effects: [...cancelBothTimers(), { kind: "emit-error" }],
            };
        }

        case "foreground": {
            const effects: Effect[] = [{ kind: "claim-session" }];
            let nextSnap = snap;

            if (snap.resumeOnForeground && snap.intent === "play") {
                // One-tap affordance -- surface blocked, never call-play automatically.
                nextSnap = {
                    ...snap,
                    status: "blocked",
                    resumeOnForeground: false,
                    rung: "none",
                    progressStreakStartedAt: null,
                };
            }

            return { snapshot: nextSnap, effects };
        }

        case "cleanup": {
            return {
                snapshot: initialSnapshot(),
                effects: cancelBothTimers(),
            };
        }

        case "silent-playback-detected": {
            if (snap.status !== "playing") {
                return { snapshot: snap, effects: [] };
            }
            return {
                snapshot: {
                    ...snap,
                    status: "blocked",
                    rung: "none",
                    progressStreakStartedAt: null,
                },
                effects: cancelBothTimers(),
            };
        }
    }
}
