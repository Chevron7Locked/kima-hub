import { describe, it, expect } from "vitest";
import {
    transition,
    initialSnapshot,
    RECOVERY,
    type EngineSnapshot,
    type EngineEvent,
    type EngineStatus,
    type Effect,
} from "../audio-engine-policy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_000_000; // arbitrary epoch base

function snap(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
    return { ...initialSnapshot(), ...overrides };
}

function tr(
    s: EngineSnapshot,
    ev: EngineEvent,
): { snapshot: EngineSnapshot; effects: Effect[] } {
    return transition(s, ev);
}

function hasEffect(effects: Effect[], kind: Effect["kind"]): boolean {
    return effects.some((e) => e.kind === kind);
}

function effectsOf(effects: Effect[], kind: Effect["kind"]): Effect[] {
    return effects.filter((e) => e.kind === kind);
}


// Build a minimal "playing" snapshot.
function playingSnap(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
    return snap({
        status: "playing",
        intent: "play",
        src: "http://example.com/track.mp3",
        generation: 1,
        currentTime: 10,
        lastProgressAt: NOW,
        progressStreakStartedAt: NOW,
        ...overrides,
    });
}

// Deliver N ticks without progress (readyState 4 = HAVE_ENOUGH_DATA >= 3).

// ---------------------------------------------------------------------------
// Table test: every (status x event-type) pair produces a defined status
// ---------------------------------------------------------------------------

const ALL_STATUSES: EngineStatus[] = [
    "idle",
    "loading",
    "playing",
    "buffering",
    "paused",
    "recovering",
    "blocked",
    "error",
];

const SAMPLE_EVENTS: EngineEvent[] = [
    { type: "load", src: "http://x.com/a.mp3", autoplay: false, now: NOW },
    { type: "play-requested", now: NOW },
    { type: "pause-requested", cls: "user", now: NOW },
    { type: "pause-requested", cls: "system", now: NOW },
    { type: "native-playing", now: NOW },
    { type: "native-pause", now: NOW },
    { type: "native-ended", currentTime: 100, duration: 100, now: NOW },
    { type: "native-canplay", duration: 100, now: NOW },
    { type: "native-waiting", now: NOW },
    { type: "native-error", code: 2, message: "network", now: NOW },
    {
        type: "tick",
        currentTime: 10,
        readyState: 4,
        paused: false,
        hidden: false,
        now: NOW,
    },
    { type: "timer-fired", timer: "nudge-settle", now: NOW },
    { type: "timer-fired", timer: "reload-settle", now: NOW },
    {
        type: "play-rejected",
        reason: "not-allowed",
        generation: 0,
        now: NOW,
    },
    { type: "foreground", now: NOW },
    { type: "cleanup", now: NOW },
    { type: "silent-playback-detected", now: NOW },
    { type: "gapless-swapped", src: "http://x.com/b.mp3", now: NOW },
];

describe("table test: every (status x event) pair produces a defined status", () => {
    for (const status of ALL_STATUSES) {
        for (const event of SAMPLE_EVENTS) {
            it(`status=${status} + event=${event.type}${event.type === "play-rejected" ? `(${(event as { reason: string }).reason})` : ""} does not throw`, () => {
                const s = snap({
                    status,
                    src: "http://x.com/a.mp3",
                    generation: 1,
                    attempts: 0,
                    lastProgressAt: NOW,
                });
                let result: ReturnType<typeof tr>;
                expect(() => {
                    result = tr(s, event);
                }).not.toThrow();
                expect(ALL_STATUSES).toContain(result!.snapshot.status);
            });
        }
    }
});

// ---------------------------------------------------------------------------
// R1 invariant: paused element is never a stall
// ---------------------------------------------------------------------------

describe("R1 invariant: entering paused always idles the ladder", () => {
    const PAUSE_EVENTS: EngineEvent[] = [
        { type: "pause-requested", cls: "user", now: NOW },
        { type: "pause-requested", cls: "system", now: NOW },
        { type: "native-pause", now: NOW },
    ];

    const ACTIVE_BASES: EngineSnapshot[] = [
        playingSnap(),
        playingSnap({ status: "buffering" }),
        playingSnap({ status: "recovering", rung: "nudge-wait" }),
        playingSnap({ status: "recovering", rung: "reload-wait" }),
    ];

    for (const base of ACTIVE_BASES) {
        for (const ev of PAUSE_EVENTS) {
            it(`${base.status}/${base.rung} + ${ev.type}(${ev.type === "pause-requested" ? (ev as { cls: string }).cls : ""}) -> status=paused, rung=none`, () => {
                const { snapshot, effects } = tr(base, ev);
                expect(snapshot.status).toBe("paused");
                expect(snapshot.rung).toBe("none");
                expect(hasEffect(effects, "call-play")).toBe(false);
            });
        }
    }

    it("subsequent tick after pause does not call play or escalate", () => {
        const paused = snap({
            status: "paused",
            intent: "play",
            src: "http://x.com/a.mp3",
            generation: 1,
            lastProgressAt: NOW - RECOVERY.stallDeadlineMs - 1000,
            currentTime: 10,
        });
        const { snapshot, effects } = tr(paused, {
            type: "tick",
            currentTime: 10,
            readyState: 4,
            paused: false,
            hidden: false,
            now: NOW,
        });
        expect(snapshot.status).toBe("paused");
        expect(hasEffect(effects, "call-play")).toBe(false);
        expect(hasEffect(effects, "set-src-and-load")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Buffering vs stall classification
// ---------------------------------------------------------------------------

describe("buffering vs stall classification", () => {
    it("readyState < 3 with no progress classifies as buffering (not immediately escalating)", () => {
        const base = playingSnap({ lastProgressAt: NOW });
        const { snapshot } = tr(base, {
            type: "tick",
            currentTime: base.currentTime,
            readyState: 2,
            paused: false,
            hidden: false,
            now: NOW + 1000,
        });
        expect(snapshot.status).toBe("buffering");
    });

    it("readyState < 3: buffering deadline escalates at exact boundary", () => {
        const base = playingSnap({ lastProgressAt: NOW });
        const atBoundary = tr(base, {
            type: "tick",
            currentTime: base.currentTime,
            readyState: 2,
            paused: false,
            hidden: false,
            now: NOW + RECOVERY.bufferingDeadlineMs,
        });
        expect(atBoundary.snapshot.status).toBe("recovering");
        expect(atBoundary.snapshot.rung).toBe("nudge-wait");
    });

    it("readyState < 3: just before buffering deadline does not escalate", () => {
        const base = playingSnap({ lastProgressAt: NOW });
        const justBefore = tr(base, {
            type: "tick",
            currentTime: base.currentTime,
            readyState: 2,
            paused: false,
            hidden: false,
            now: NOW + RECOVERY.bufferingDeadlineMs - 1,
        });
        expect(justBefore.snapshot.status).toBe("buffering");
        expect(hasEffect(justBefore.effects, "arm-timer")).toBe(false);
    });

    it("readyState >= 3: stall deadline escalates at exact boundary", () => {
        const base = playingSnap({ lastProgressAt: NOW });
        const atBoundary = tr(base, {
            type: "tick",
            currentTime: base.currentTime,
            readyState: 4,
            paused: false,
            hidden: false,
            now: NOW + RECOVERY.stallDeadlineMs,
        });
        expect(atBoundary.snapshot.status).toBe("recovering");
        expect(atBoundary.snapshot.rung).toBe("nudge-wait");
    });

    it("readyState >= 3: just before stall deadline does not escalate", () => {
        const base = playingSnap({ lastProgressAt: NOW });
        const justBefore = tr(base, {
            type: "tick",
            currentTime: base.currentTime,
            readyState: 4,
            paused: false,
            hidden: false,
            now: NOW + RECOVERY.stallDeadlineMs - 1,
        });
        expect(justBefore.snapshot.status).not.toBe("recovering");
        expect(hasEffect(justBefore.effects, "arm-timer")).toBe(false);
    });

    it("native-stalled (not an input) has no effect -- native-waiting triggers buffering", () => {
        // The policy has no stalled event type. Confirm waiting -> buffering only from "playing".
        const base = playingSnap();
        const { snapshot } = tr(base, { type: "native-waiting", now: NOW });
        expect(snapshot.status).toBe("buffering");
    });
});

// ---------------------------------------------------------------------------
// Attempts budget
// ---------------------------------------------------------------------------

describe("attempts budget", () => {
    it("play-1s/stall loop does NOT reset budget", () => {
        // Simulate: tick with 1s progress, then stall, repeat until attempts exhaust.
        let cur = playingSnap({ lastProgressAt: NOW });
        // Progress 1s.
        const r1 = tr(cur, {
            type: "tick",
            currentTime: cur.currentTime + 1,
            readyState: 4,
            paused: false,
            hidden: false,
            now: NOW + 1000,
        });
        cur = r1.snapshot;
        expect(cur.attempts).toBe(0);
        // Immediately stall for stall deadline.
        const r2 = tr(cur, {
            type: "tick",
            currentTime: cur.currentTime,
            readyState: 4,
            paused: false,
            hidden: false,
            now: NOW + 1000 + RECOVERY.stallDeadlineMs,
        });
        cur = r2.snapshot;
        // Should have escalated (attempts 1, not reset to 0).
        expect(cur.attempts).toBe(1);
        expect(cur.status).toBe("recovering");
    });

    it("60s continuous progress resets attempts budget", () => {
        const base = playingSnap({
            attempts: 3,
            progressStreakStartedAt: NOW,
            lastProgressAt: NOW,
        });
        const { snapshot } = tr(base, {
            type: "tick",
            currentTime: base.currentTime + 1,
            readyState: 4,
            paused: false,
            hidden: false,
            now: NOW + RECOVERY.budgetResetAfterMs,
        });
        expect(snapshot.attempts).toBe(0);
    });

    it("59s continuous progress does NOT reset attempts budget", () => {
        const base = playingSnap({
            attempts: 3,
            progressStreakStartedAt: NOW,
            lastProgressAt: NOW,
        });
        const { snapshot } = tr(base, {
            type: "tick",
            currentTime: base.currentTime + 1,
            readyState: 4,
            paused: false,
            hidden: false,
            now: NOW + RECOVERY.budgetResetAfterMs - 1,
        });
        expect(snapshot.attempts).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// Ladder exhaustion
// ---------------------------------------------------------------------------

describe("ladder exhaustion -> error 99 exactly once", () => {
    function runLadderToExhaustion(): {
        finalSnap: EngineSnapshot;
        errorEmits: number;
    } {
        let cur = playingSnap({ lastProgressAt: NOW, attempts: 0 });
        let errorEmits = 0;
        let iterations = 0;
        const MAX_ITER = 50;

        while (cur.status !== "error" && iterations < MAX_ITER) {
            iterations++;
            if (cur.status === "playing" || cur.status === "buffering") {
                // Stall past the deadline.
                cur = tr(cur, {
                    type: "tick",
                    currentTime: cur.currentTime,
                    readyState: 4,
                    paused: false,
                    hidden: false,
                    now: cur.lastProgressAt + RECOVERY.stallDeadlineMs + 100,
                }).snapshot;
            } else if (cur.status === "recovering" && cur.rung === "nudge-wait") {
                // Fire nudge-settle.
                const r = tr(cur, {
                    type: "timer-fired",
                    timer: "nudge-settle",
                    now: NOW + iterations * 5000,
                });
                if (hasEffect(r.effects, "emit-error")) errorEmits++;
                cur = r.snapshot;
            } else if (cur.status === "recovering" && cur.rung === "reload-wait") {
                // Fire reload-settle.
                const r = tr(cur, {
                    type: "timer-fired",
                    timer: "reload-settle",
                    now: NOW + iterations * 5000,
                });
                if (hasEffect(r.effects, "emit-error")) errorEmits++;
                cur = r.snapshot;
            } else {
                break;
            }
        }

        return { finalSnap: cur, errorEmits };
    }

    it("reaches error state with code 99 and message 'Playback stalled repeatedly'", () => {
        const { finalSnap } = runLadderToExhaustion();
        expect(finalSnap.status).toBe("error");
        expect(finalSnap.error?.code).toBe(99);
        expect(finalSnap.error?.message).toBe("Playback stalled repeatedly");
    });

    it("emit-error fires exactly once", () => {
        const { errorEmits } = runLadderToExhaustion();
        expect(errorEmits).toBe(1);
    });

    it("attempts does not exceed maxAttempts after exhaustion", () => {
        const { finalSnap } = runLadderToExhaustion();
        expect(finalSnap.attempts).toBeLessThanOrEqual(RECOVERY.maxAttempts);
    });
});

// ---------------------------------------------------------------------------
// Park policy
// ---------------------------------------------------------------------------

describe("park policy: hidden reload rung -> paused(system)+resumeOnForeground", () => {
    it("hidden when reload rung starts -> paused system, resumeOnForeground, no call-play", () => {
        const base = playingSnap({
            lastKnownHidden: true,
            attempts: 0,
            rung: "nudge-wait",
        });
        // Fire nudge-settle to trigger reload rung.
        const { snapshot, effects } = tr(base, {
            type: "timer-fired",
            timer: "nudge-settle",
            now: NOW,
        });
        expect(snapshot.status).toBe("paused");
        expect(snapshot.pauseClass).toBe("system");
        expect(snapshot.resumeOnForeground).toBe(true);
        expect(hasEffect(effects, "call-play")).toBe(false);
    });

    it("foreground after park -> blocked (one-tap affordance), never call-play", () => {
        const parked = snap({
            status: "paused",
            intent: "play",
            resumeOnForeground: true,
            src: "http://x.com/a.mp3",
            generation: 1,
        });
        const { snapshot, effects } = tr(parked, {
            type: "foreground",
            now: NOW,
        });
        expect(snapshot.status).toBe("blocked");
        expect(snapshot.resumeOnForeground).toBe(false);
        expect(hasEffect(effects, "call-play")).toBe(false);
    });

    it("foreground without resumeOnForeground -> only claim-session", () => {
        const s = snap({
            status: "playing",
            intent: "play",
            resumeOnForeground: false,
        });
        const { snapshot, effects } = tr(s, { type: "foreground", now: NOW });
        expect(snapshot.status).toBe("playing");
        expect(hasEffect(effects, "call-play")).toBe(false);
        expect(hasEffect(effects, "claim-session")).toBe(true);
    });

    it("hidden escalation during tick -> park, not reload with call-play", () => {
        const base = playingSnap({
            lastKnownHidden: false,
            attempts: 0,
            lastProgressAt: NOW,
        });
        // First tick updates hidden to true.
        const r1 = tr(base, {
            type: "tick",
            currentTime: base.currentTime,
            readyState: 4,
            paused: false,
            hidden: true,
            now: NOW + 1000,
        });
        // Now stall to deadline with hidden=true.
        const r2 = tr(r1.snapshot, {
            type: "tick",
            currentTime: base.currentTime,
            readyState: 4,
            paused: false,
            hidden: true,
            now: NOW + RECOVERY.stallDeadlineMs + 100,
        });
        // Nudge rung started; then nudge-settle fires.
        if (r2.snapshot.status === "recovering" && r2.snapshot.rung === "nudge-wait") {
            const r3 = tr(r2.snapshot, {
                type: "timer-fired",
                timer: "nudge-settle",
                now: NOW + RECOVERY.stallDeadlineMs + RECOVERY.nudgeSettleMs + 200,
            });
            expect(r3.snapshot.status).toBe("paused");
            expect(r3.snapshot.pauseClass).toBe("system");
            expect(r3.snapshot.resumeOnForeground).toBe(true);
            expect(hasEffect(r3.effects, "call-play")).toBe(false);
        } else {
            // Some paths reach parked state directly -- still should not call-play.
            expect(hasEffect(r2.effects, "call-play")).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// Truncated ended -> recovery; honest ended -> emit-ended
// ---------------------------------------------------------------------------

describe("native-ended: truncated vs honest", () => {
    it("truncated delivery escalates recovery (no emit-ended)", () => {
        const base = playingSnap({ currentTime: 50, duration: 200 });
        const { snapshot, effects } = tr(base, {
            type: "native-ended",
            currentTime: 50,
            duration: 200,
            now: NOW,
        });
        expect(snapshot.status).not.toBe("paused");
        expect(hasEffect(effects, "emit-ended")).toBe(false);
        // Should have escalated to recovering or error.
        expect(["recovering", "error"]).toContain(snapshot.status);
    });

    it("honest ended (currentTime at duration) emits ended", () => {
        const base = playingSnap({ currentTime: 200, duration: 200 });
        const { snapshot, effects } = tr(base, {
            type: "native-ended",
            currentTime: 200,
            duration: 200,
            now: NOW,
        });
        expect(snapshot.status).toBe("paused");
        expect(hasEffect(effects, "emit-ended")).toBe(true);
        expect(hasEffect(effects, "emit-error")).toBe(false);
    });

    it("honest ended within tolerance (currentTime = duration - 2) emits ended", () => {
        const base = playingSnap({ currentTime: 198, duration: 200 });
        const { snapshot, effects } = tr(base, {
            type: "native-ended",
            currentTime: 198,
            duration: 200,
            now: NOW,
        });
        expect(snapshot.status).toBe("paused");
        expect(hasEffect(effects, "emit-ended")).toBe(true);
    });

    it("truncated: currentTime at duration - tolerance - 1 escalates", () => {
        const base = playingSnap({ currentTime: 196, duration: 200 });
        const { snapshot, effects } = tr(base, {
            type: "native-ended",
            currentTime: 196,
            duration: 200,
            now: NOW,
        });
        expect(hasEffect(effects, "emit-ended")).toBe(false);
        expect(["recovering", "error"]).toContain(snapshot.status);
    });
});

// ---------------------------------------------------------------------------
// native-ended: server-reported duration as a second "honest end" signal (R1.1)
// ---------------------------------------------------------------------------

describe("native-ended: expectedDurationS honesty (VBR-MP3 unreliable element duration)", () => {
    it("wrong element duration (Infinity) but expectedDurationS reached -> paused + emit-ended", () => {
        const base = playingSnap({ currentTime: 200, expectedDurationS: 200 });
        const { snapshot, effects } = tr(base, {
            type: "native-ended",
            currentTime: 200,
            duration: Infinity,
            now: NOW,
        });
        expect(snapshot.status).toBe("paused");
        expect(hasEffect(effects, "emit-ended")).toBe(true);
        expect(hasEffect(effects, "emit-error")).toBe(false);
    });

    it("wrong element duration (0) but expectedDurationS reached within tolerance -> paused + emit-ended", () => {
        const base = playingSnap({ currentTime: 198, expectedDurationS: 200 });
        const { snapshot, effects } = tr(base, {
            type: "native-ended",
            currentTime: 198,
            duration: 0,
            now: NOW,
        });
        expect(snapshot.status).toBe("paused");
        expect(hasEffect(effects, "emit-ended")).toBe(true);
    });

    it("genuinely truncated: both element duration and expectedDurationS far ahead -> still escalates", () => {
        const base = playingSnap({ currentTime: 50, expectedDurationS: 200 });
        const { snapshot, effects } = tr(base, {
            type: "native-ended",
            currentTime: 50,
            duration: 200,
            now: NOW,
        });
        expect(hasEffect(effects, "emit-ended")).toBe(false);
        expect(["recovering", "error"]).toContain(snapshot.status);
    });

    it("no expectedDurationS set (audiobook/podcast path): falls back to element-only honesty", () => {
        const base = playingSnap({ currentTime: 200, expectedDurationS: null });
        const { snapshot, effects } = tr(base, {
            type: "native-ended",
            currentTime: 200,
            duration: 200,
            now: NOW,
        });
        expect(snapshot.status).toBe("paused");
        expect(hasEffect(effects, "emit-ended")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// load: expectedDurationS is set per-load and reset (not carried across)
// ---------------------------------------------------------------------------

describe("load: expectedDurationS threading", () => {
    it("load with expectedDurationS sets it on the snapshot", () => {
        const base = snap();
        const { snapshot } = tr(base, {
            type: "load",
            src: "http://x.com/a.mp3",
            autoplay: true,
            expectedDurationS: 245,
            now: NOW,
        });
        expect(snapshot.expectedDurationS).toBe(245);
    });

    it("load without expectedDurationS resets it to null (not carried across loads)", () => {
        const base = snap({ expectedDurationS: 245 });
        const { snapshot } = tr(base, {
            type: "load",
            src: "http://x.com/b.mp3",
            autoplay: true,
            now: NOW,
        });
        expect(snapshot.expectedDurationS).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Stale play-rejected ignored; not-allowed -> blocked
// ---------------------------------------------------------------------------

describe("play-rejected", () => {
    it("stale generation: ignored entirely (no state change)", () => {
        const base = playingSnap({ generation: 5 });
        const { snapshot, effects } = tr(base, {
            type: "play-rejected",
            reason: "not-allowed",
            generation: 4,
            now: NOW,
        });
        expect(snapshot.status).toBe("playing");
        expect(snapshot.generation).toBe(5);
        expect(effects).toHaveLength(0);
    });

    it("not-allowed current generation -> blocked, intent unchanged", () => {
        const base = playingSnap({ generation: 3, intent: "play" });
        const { snapshot, effects } = tr(base, {
            type: "play-rejected",
            reason: "not-allowed",
            generation: 3,
            now: NOW,
        });
        expect(snapshot.status).toBe("blocked");
        expect(snapshot.intent).toBe("play");
        expect(hasEffect(effects, "call-play")).toBe(false);
    });

    it("abort current generation -> reload rung (single attempt)", () => {
        const base = playingSnap({ generation: 2, attempts: 0 });
        const { snapshot } = tr(base, {
            type: "play-rejected",
            reason: "abort",
            generation: 2,
            now: NOW,
        });
        // Should start reload rung.
        expect(["recovering", "paused", "error"]).toContain(snapshot.status);
        if (snapshot.status === "recovering") {
            expect(snapshot.rung).toBe("reload-wait");
        }
    });

    it("abort while already recovering -> let ladder continue (no state change)", () => {
        const base = playingSnap({
            status: "recovering",
            rung: "nudge-wait",
            generation: 2,
        });
        const { snapshot } = tr(base, {
            type: "play-rejected",
            reason: "abort",
            generation: 2,
            now: NOW,
        });
        expect(snapshot.status).toBe("recovering");
        expect(snapshot.rung).toBe("nudge-wait");
    });

    it("other reason -> error with emit-error", () => {
        const base = playingSnap({ generation: 1 });
        const { snapshot, effects } = tr(base, {
            type: "play-rejected",
            reason: "other",
            generation: 1,
            now: NOW,
        });
        expect(snapshot.status).toBe("error");
        expect(hasEffect(effects, "emit-error")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// load supersedes recovery cleanly
// ---------------------------------------------------------------------------

describe("load supersedes recovery cleanly", () => {
    it("load during recovery: generation bumped, timers cancelled, rung reset", () => {
        const base = playingSnap({
            status: "recovering",
            rung: "nudge-wait",
            generation: 3,
            attempts: 2,
        });
        const { snapshot, effects } = tr(base, {
            type: "load",
            src: "http://x.com/new.mp3",
            autoplay: true,
            now: NOW,
        });
        expect(snapshot.generation).toBe(4);
        expect(snapshot.status).toBe("loading");
        expect(snapshot.rung).toBe("none");
        expect(snapshot.attempts).toBe(0);
        expect(hasEffect(effects, "cancel-timer")).toBe(true);
        const cancelEffects = effectsOf(effects, "cancel-timer");
        const timerIds = cancelEffects.map(
            (e) => (e as { kind: "cancel-timer"; timer: string }).timer,
        );
        expect(timerIds).toContain("nudge-settle");
        expect(timerIds).toContain("reload-settle");
    });

    it("load with seekTo sets pendingSeek", () => {
        const base = playingSnap();
        const { snapshot } = tr(base, {
            type: "load",
            src: "http://x.com/b.mp3",
            autoplay: false,
            seekTo: 42,
            now: NOW,
        });
        expect(snapshot.pendingSeek).toBe(42);
    });

    it("load without seekTo clears pendingSeek", () => {
        const base = playingSnap({ pendingSeek: 99 });
        const { snapshot } = tr(base, {
            type: "load",
            src: "http://x.com/c.mp3",
            autoplay: false,
            now: NOW,
        });
        expect(snapshot.pendingSeek).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Code-2 native-error message mapping
// ---------------------------------------------------------------------------

describe("native-error code-2 message mapping", () => {
    it("code 2 in terminal state -> 'Network error -- tap to retry'", () => {
        const base = playingSnap({ attempts: RECOVERY.maxAttempts });
        const { snapshot } = tr(base, {
            type: "native-error",
            code: 2,
            message: "some server message",
            now: NOW,
        });
        expect(snapshot.status).toBe("error");
        expect(snapshot.error?.code).toBe(2);
        expect(snapshot.error?.message).toBe("Network error -- tap to retry");
    });

    it("code 4 in terminal state -> uses provided message", () => {
        const base = playingSnap({ attempts: RECOVERY.maxAttempts });
        const { snapshot } = tr(base, {
            type: "native-error",
            code: 4,
            message: "format unsupported",
            now: NOW,
        });
        expect(snapshot.status).toBe("error");
        expect(snapshot.error?.message).toBe("format unsupported");
    });

    it("code 2 first attempt -> escalates to reload (not immediately terminal)", () => {
        const base = playingSnap({ attempts: 0 });
        const { snapshot } = tr(base, {
            type: "native-error",
            code: 2,
            message: "network error",
            now: NOW,
        });
        expect(snapshot.status).not.toBe("error");
        expect(["recovering", "paused"]).toContain(snapshot.status);
    });
});

// ---------------------------------------------------------------------------
// native-canplay: pendingSeek applied, reload-wait rung resolved
// ---------------------------------------------------------------------------

describe("native-canplay semantics", () => {
    it("applies pendingSeek and clears it", () => {
        const base = snap({
            status: "loading",
            intent: "play",
            src: "http://x.com/a.mp3",
            generation: 1,
            pendingSeek: 55,
        });
        const { snapshot, effects } = tr(base, {
            type: "native-canplay",
            duration: 300,
            now: NOW,
        });
        expect(snapshot.pendingSeek).toBeNull();
        const seekEffects = effectsOf(effects, "seek");
        expect(seekEffects).toHaveLength(1);
        expect((seekEffects[0] as { kind: "seek"; time: number }).time).toBe(55);
    });

    it("no pendingSeek -> no seek effect", () => {
        const base = snap({
            status: "loading",
            intent: "play",
            src: "http://x.com/a.mp3",
            generation: 1,
            pendingSeek: null,
        });
        const { effects } = tr(base, {
            type: "native-canplay",
            duration: 300,
            now: NOW,
        });
        expect(hasEffect(effects, "seek")).toBe(false);
    });

    it("reload-wait rung resolved: cancel reload-settle timer", () => {
        const base = snap({
            status: "recovering",
            intent: "play",
            src: "http://x.com/a.mp3",
            generation: 1,
            rung: "reload-wait",
            attempts: 1,
        });
        const { snapshot, effects } = tr(base, {
            type: "native-canplay",
            duration: 200,
            now: NOW,
        });
        expect(snapshot.rung).toBe("none");
        const cancelEffects = effectsOf(effects, "cancel-timer");
        const timerIds = cancelEffects.map(
            (e) => (e as { kind: "cancel-timer"; timer: string }).timer,
        );
        expect(timerIds).toContain("reload-settle");
    });

    it("intent=pause during loading -> status paused", () => {
        const base = snap({
            status: "loading",
            intent: "pause",
            src: "http://x.com/a.mp3",
            generation: 1,
        });
        const { snapshot } = tr(base, {
            type: "native-canplay",
            duration: 200,
            now: NOW,
        });
        expect(snapshot.status).toBe("paused");
    });
});

// ---------------------------------------------------------------------------
// native-playing semantics
// ---------------------------------------------------------------------------

describe("native-playing", () => {
    it("sets status playing, clears pauseClass, cancels timers", () => {
        const base = snap({
            status: "recovering",
            intent: "play",
            src: "http://x.com/a.mp3",
            generation: 1,
            rung: "reload-wait",
            pauseClass: "system",
            attempts: 1,
        });
        const { snapshot, effects } = tr(base, {
            type: "native-playing",
            now: NOW,
        });
        expect(snapshot.status).toBe("playing");
        expect(snapshot.pauseClass).toBeNull();
        expect(snapshot.rung).toBe("none");
        expect(hasEffect(effects, "cancel-timer")).toBe(true);
    });

    it("progressStreakStartedAt initialized if null", () => {
        const base = snap({
            status: "loading",
            intent: "play",
            progressStreakStartedAt: null,
        });
        const { snapshot } = tr(base, { type: "native-playing", now: NOW + 5000 });
        expect(snapshot.progressStreakStartedAt).toBe(NOW + 5000);
    });

    it("progressStreakStartedAt preserved if already set", () => {
        const base = snap({
            status: "playing",
            intent: "play",
            progressStreakStartedAt: NOW - 10000,
        });
        const { snapshot } = tr(base, { type: "native-playing", now: NOW });
        expect(snapshot.progressStreakStartedAt).toBe(NOW - 10000);
    });
});

// ---------------------------------------------------------------------------
// play-requested from error/blocked: fresh retry
// ---------------------------------------------------------------------------

describe("play-requested from error/blocked: fresh retry", () => {
    it("from error with src -> loading, attempts 0, pendingSeek set if currentTime > 0", () => {
        const base = snap({
            status: "error",
            src: "http://x.com/a.mp3",
            generation: 2,
            attempts: 4,
            currentTime: 33,
            error: { message: "err", code: 99 },
        });
        const { snapshot, effects } = tr(base, {
            type: "play-requested",
            now: NOW,
        });
        expect(snapshot.status).toBe("loading");
        expect(snapshot.attempts).toBe(0);
        expect(snapshot.pendingSeek).toBe(33);
        expect(hasEffect(effects, "set-src-and-load")).toBe(true);
        expect(hasEffect(effects, "claim-session")).toBe(true);
    });

    it("from blocked -> loading", () => {
        const base = snap({
            status: "blocked",
            src: "http://x.com/a.mp3",
            generation: 1,
            currentTime: 0,
        });
        const { snapshot } = tr(base, { type: "play-requested", now: NOW });
        expect(snapshot.status).toBe("loading");
    });
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

describe("cleanup", () => {
    it("returns initial snapshot with timers cancelled", () => {
        const base = playingSnap({
            status: "recovering",
            rung: "nudge-wait",
            attempts: 3,
        });
        const { snapshot, effects } = tr(base, { type: "cleanup", now: NOW });
        const initial = initialSnapshot();
        expect(snapshot.status).toBe(initial.status);
        expect(snapshot.src).toBe(initial.src);
        expect(snapshot.rung).toBe(initial.rung);
        expect(snapshot.attempts).toBe(initial.attempts);
        expect(hasEffect(effects, "cancel-timer")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// initialSnapshot
// ---------------------------------------------------------------------------

describe("initialSnapshot", () => {
    it("has expected shape", () => {
        const s = initialSnapshot();
        expect(s.status).toBe("idle");
        expect(s.intent).toBe("pause");
        expect(s.src).toBeNull();
        expect(s.generation).toBe(0);
        expect(s.attempts).toBe(0);
        expect(s.rung).toBe("none");
        expect(s.pendingSeek).toBeNull();
        expect(s.resumeOnForeground).toBe(false);
        expect(s.lastKnownHidden).toBe(false);
        expect(s.error).toBeNull();
        expect(s.expectedDurationS).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// tick: progress recovery, buffering to playing transition
// ---------------------------------------------------------------------------

describe("tick: progress causes buffering/recovering to return to playing", () => {
    it("buffering + readyState>=3 + progress -> playing", () => {
        const base = snap({
            status: "buffering",
            intent: "play",
            src: "http://x.com/a.mp3",
            currentTime: 10,
            lastProgressAt: NOW - 5000,
            progressStreakStartedAt: null,
        });
        const { snapshot } = tr(base, {
            type: "tick",
            currentTime: 11,
            readyState: 3,
            paused: false,
            hidden: false,
            now: NOW,
        });
        expect(snapshot.status).toBe("playing");
    });

    it("recovering + readyState>=3 + progress -> playing", () => {
        const base = snap({
            status: "recovering",
            rung: "nudge-wait",
            intent: "play",
            src: "http://x.com/a.mp3",
            currentTime: 10,
            lastProgressAt: NOW - 3000,
            progressStreakStartedAt: null,
        });
        const { snapshot, effects } = tr(base, {
            type: "tick",
            currentTime: 11,
            readyState: 4,
            paused: false,
            hidden: false,
            now: NOW,
        });
        expect(snapshot.status).toBe("playing");
        expect(snapshot.rung).toBe("none");
        expect(hasEffect(effects, "cancel-timer")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// tick: paused=true -> no-op
// ---------------------------------------------------------------------------

describe("tick with paused=true", () => {
    it("does not escalate even if long since progress", () => {
        const base = playingSnap({
            lastProgressAt: NOW - RECOVERY.stallDeadlineMs * 10,
        });
        const { effects } = tr(base, {
            type: "tick",
            currentTime: base.currentTime,
            readyState: 4,
            paused: true,
            hidden: false,
            now: NOW,
        });
        // Should not escalate (defensive: paused=true is treated as no-op for ladder).
        expect(hasEffect(effects, "set-src-and-load")).toBe(false);
        expect(hasEffect(effects, "arm-timer")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// error/blocked: tick does not escalate from them
// ---------------------------------------------------------------------------

describe("error/blocked are terminal until user action", () => {
    it("tick from error does not escalate", () => {
        const base = snap({
            status: "error",
            src: "http://x.com/a.mp3",
            generation: 1,
            error: { message: "e", code: 99 },
            lastProgressAt: NOW - 100_000,
            currentTime: 10,
        });
        const { snapshot, effects } = tr(base, {
            type: "tick",
            currentTime: 10,
            readyState: 4,
            paused: false,
            hidden: false,
            now: NOW,
        });
        expect(snapshot.status).toBe("error");
        expect(hasEffect(effects, "set-src-and-load")).toBe(false);
    });

    it("tick from blocked does not escalate", () => {
        const base = snap({
            status: "blocked",
            src: "http://x.com/a.mp3",
            generation: 1,
            lastProgressAt: NOW - 100_000,
            currentTime: 10,
        });
        const { snapshot } = tr(base, {
            type: "tick",
            currentTime: 10,
            readyState: 4,
            paused: false,
            hidden: false,
            now: NOW,
        });
        expect(snapshot.status).toBe("blocked");
    });
});

// ---------------------------------------------------------------------------
// intent semantics
// ---------------------------------------------------------------------------

describe("intent semantics", () => {
    it("load with autoplay=true sets intent=play", () => {
        const base = snap({ intent: "pause" });
        const { snapshot } = tr(base, {
            type: "load",
            src: "http://x.com/a.mp3",
            autoplay: true,
            now: NOW,
        });
        expect(snapshot.intent).toBe("play");
    });

    it("load with autoplay=false preserves existing intent", () => {
        const base = snap({ intent: "play" });
        const { snapshot } = tr(base, {
            type: "load",
            src: "http://x.com/a.mp3",
            autoplay: false,
            now: NOW,
        });
        expect(snapshot.intent).toBe("play");
    });

    it("pause-requested with cls=user sets intent=pause", () => {
        const base = playingSnap({ intent: "play" });
        const { snapshot } = tr(base, {
            type: "pause-requested",
            cls: "user",
            now: NOW,
        });
        expect(snapshot.intent).toBe("pause");
    });

    it("pause-requested with cls=system leaves intent unchanged", () => {
        const base = playingSnap({ intent: "play" });
        const { snapshot } = tr(base, {
            type: "pause-requested",
            cls: "system",
            now: NOW,
        });
        expect(snapshot.intent).toBe("play");
    });

    it("native-pause leaves intent unchanged", () => {
        const base = playingSnap({ intent: "play" });
        const { snapshot } = tr(base, { type: "native-pause", now: NOW });
        expect(snapshot.intent).toBe("play");
    });
});

// ---------------------------------------------------------------------------
// native-ended: intent unchanged (spec says "intent stays")
// ---------------------------------------------------------------------------

describe("native-ended: intent preserved", () => {
    it("honest ended preserves intent", () => {
        const base = playingSnap({ intent: "play", currentTime: 100, duration: 100 });
        const { snapshot } = tr(base, {
            type: "native-ended",
            currentTime: 100,
            duration: 100,
            now: NOW,
        });
        expect(snapshot.status).toBe("paused");
        expect(snapshot.intent).toBe("play");
    });
});

// ---------------------------------------------------------------------------
// native-waiting: only transitions from "playing"
// ---------------------------------------------------------------------------

describe("native-waiting", () => {
    it("from playing -> buffering", () => {
        const base = playingSnap();
        const { snapshot } = tr(base, { type: "native-waiting", now: NOW });
        expect(snapshot.status).toBe("buffering");
    });

    it("from buffering -> stays buffering (no-op)", () => {
        const base = playingSnap({ status: "buffering" });
        const { snapshot } = tr(base, { type: "native-waiting", now: NOW });
        expect(snapshot.status).toBe("buffering");
    });

    it("from paused -> stays paused (no-op)", () => {
        const base = snap({ status: "paused" });
        const { snapshot } = tr(base, { type: "native-waiting", now: NOW });
        expect(snapshot.status).toBe("paused");
    });
});

// ---------------------------------------------------------------------------
// nudge rung: seek effect is issued
// ---------------------------------------------------------------------------

describe("nudge rung: seek effect issued with current time", () => {
    it("escalation to nudge rung issues seek(currentTime)", () => {
        const base = playingSnap({
            currentTime: 77,
            lastProgressAt: NOW,
        });
        const { snapshot, effects } = tr(base, {
            type: "tick",
            currentTime: 77,
            readyState: 4,
            paused: false,
            hidden: false,
            now: NOW + RECOVERY.stallDeadlineMs,
        });
        expect(snapshot.status).toBe("recovering");
        expect(snapshot.rung).toBe("nudge-wait");
        const seekEffects = effectsOf(effects, "seek");
        expect(seekEffects).toHaveLength(1);
        expect((seekEffects[0] as { kind: "seek"; time: number }).time).toBe(77);
    });
});

// ---------------------------------------------------------------------------
// foreground with resumeOnForeground=false and intent=pause -> no blocked
// ---------------------------------------------------------------------------

describe("foreground: resumeOnForeground=false -> claim-session only, no blocked", () => {
    it("intent=pause, resumeOnForeground=false -> stay in same status", () => {
        const base = snap({
            status: "paused",
            intent: "pause",
            resumeOnForeground: false,
        });
        const { snapshot, effects } = tr(base, { type: "foreground", now: NOW });
        expect(snapshot.status).toBe("paused");
        expect(snapshot.resumeOnForeground).toBe(false);
        expect(hasEffect(effects, "claim-session")).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// silent-playback-detected: running-but-silent safety net (C3)
// ---------------------------------------------------------------------------

describe("silent-playback-detected", () => {
    it("from playing -> blocked, timers cancelled", () => {
        const base = playingSnap({ generation: 3, intent: "play" });
        const { snapshot, effects } = tr(base, {
            type: "silent-playback-detected",
            now: NOW,
        });
        expect(snapshot.status).toBe("blocked");
        expect(snapshot.rung).toBe("none");
        expect(snapshot.progressStreakStartedAt).toBeNull();
        expect(hasEffect(effects, "cancel-timer")).toBe(true);
        expect(effectsOf(effects, "cancel-timer")).toHaveLength(3);
    });

    it("non-playing status -> no-op (guarded like native-waiting)", () => {
        const nonPlayingStatuses: EngineStatus[] = [
            "idle",
            "loading",
            "buffering",
            "paused",
            "recovering",
            "blocked",
            "error",
        ];
        for (const status of nonPlayingStatuses) {
            const base = snap({ status, generation: 3, intent: "play" });
            const { snapshot, effects } = tr(base, {
                type: "silent-playback-detected",
                now: NOW,
            });
            expect(snapshot).toBe(base);
            expect(snapshot.status).toBe(status);
            expect(effects).toHaveLength(0);
        }
    });
});

// ---------------------------------------------------------------------------
// gapless-swapped: dual-element boundary swap bookkeeping (Phase 2B)
// ---------------------------------------------------------------------------

describe("gapless-swapped", () => {
    it("transitions to playing, increments generation, takes duration/expectedDurationS from the event, and only cancels timers (no set-src-and-load/call-play)", () => {
        const base = playingSnap({
            generation: 3,
            duration: 200,
            currentTime: 150,
            expectedDurationS: 200,
            attempts: 2,
            rung: "none",
            pendingSeek: 10,
        });
        const { snapshot, effects } = tr(base, {
            type: "gapless-swapped",
            src: "http://example.com/next.mp3",
            durationS: 210,
            expectedDurationS: 215,
            now: NOW + 1000,
        });

        expect(snapshot.status).toBe("playing");
        expect(snapshot.generation).toBe(4);
        expect(snapshot.src).toBe("http://example.com/next.mp3");
        expect(snapshot.currentTime).toBe(0);
        expect(snapshot.duration).toBe(210);
        expect(snapshot.expectedDurationS).toBe(215);
        expect(snapshot.attempts).toBe(0);
        expect(snapshot.rung).toBe("none");
        expect(snapshot.pendingSeek).toBeNull();
        expect(snapshot.lastProgressAt).toBe(NOW + 1000);

        expect(effects.length).toBeGreaterThan(0);
        expect(hasEffect(effects, "set-src-and-load")).toBe(false);
        expect(hasEffect(effects, "call-play")).toBe(false);
        for (const e of effects) {
            expect(e.kind).toBe("cancel-timer");
        }
    });

    it("defaults duration to 0 and expectedDurationS to null when not provided by the event", () => {
        const base = playingSnap({ duration: 999, expectedDurationS: 999 });
        const { snapshot } = tr(base, {
            type: "gapless-swapped",
            src: "http://example.com/next.mp3",
            now: NOW,
        });
        expect(snapshot.duration).toBe(0);
        expect(snapshot.expectedDurationS).toBeNull();
    });

    it("is pure: does not mutate the input snapshot", () => {
        const base = playingSnap({ generation: 1 });
        const frozen = { ...base };
        tr(base, {
            type: "gapless-swapped",
            src: "http://example.com/next.mp3",
            durationS: 100,
            now: NOW,
        });
        expect(base).toEqual(frozen);
    });

    it("resets a stale resumeOnForeground/pauseClass left by the native-pause that always precedes ended (FIX 2)", () => {
        // A native `pause` fires immediately before every `ended` and sets
        // these via the native-pause transition -- gapless-swapped must clear
        // them or a later `foreground` would force a spurious "blocked" onto
        // genuinely-playing audio.
        const base = playingSnap({
            pauseClass: "system",
            resumeOnForeground: true,
        });
        const { snapshot } = tr(base, {
            type: "gapless-swapped",
            src: "http://example.com/next.mp3",
            durationS: 100,
            now: NOW,
        });
        expect(snapshot.pauseClass).toBeNull();
        expect(snapshot.resumeOnForeground).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// play-rejected must not resurrect audio the user already paused
// ---------------------------------------------------------------------------

describe("play-rejected against an already-paused snapshot", () => {
    // A pause can land while a play() call is still in flight. pause-requested
    // flips status to "paused" synchronously, so a rejection arriving after that
    // is reporting on an attempt the user has already superseded. Acting on it
    // reverted the pause -- audio came back after an explicit stop.
    it("is ignored entirely, leaving the pause standing", () => {
        const base = snap({
            status: "paused",
            src: "http://x.com/a.mp3",
            generation: 3,
            pauseClass: "user",
        });

        const { snapshot, effects } = tr(base, {
            type: "play-rejected",
            reason: "not-allowed",
            generation: 3,
            now: NOW,
        });

        expect(snapshot.status).toBe("paused");
        expect(snapshot.pauseClass).toBe("user");
        expect(effects).toEqual([]);
    });

    it("is ignored for the abort reason too", () => {
        const base = snap({ status: "paused", src: "http://x.com/a.mp3", generation: 1 });

        const { snapshot, effects } = tr(base, {
            type: "play-rejected",
            reason: "abort",
            generation: 1,
            now: NOW,
        });

        expect(snapshot.status).toBe("paused");
        expect(effects).toEqual([]);
    });

    it("still handles a rejection when the user has NOT paused", () => {
        // The guard must not swallow the real case it was built around: a
        // not-allowed rejection while the engine believes it is playing.
        const base = snap({ status: "playing", src: "http://x.com/a.mp3", generation: 2 });

        const { snapshot } = tr(base, {
            type: "play-rejected",
            reason: "not-allowed",
            generation: 2,
            now: NOW,
        });

        expect(snapshot.status).toBe("blocked");
    });
});
