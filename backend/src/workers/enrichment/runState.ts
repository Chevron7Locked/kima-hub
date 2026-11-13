/**
 * The enrichment scheduler's run state.
 *
 * One mode, changed only through the moves below, replaces the seven flags the scheduler used to flip from the
 * control channel, the start and stop calls, the cycle's admission and the phase loop:
 *
 *   running   cycles are admitted and run to the end
 *   paused    an operator's pause: no cycle starts and a running one halts at its next phase
 *   stopping  a stop is asked and not yet seen by a cycle; the next look at the run state settles it
 *   stopped   a stop was seen: only a wake request or an operator's start lets a cycle through
 *
 * A stop is never lost: wherever it is seen (admission, a phase boundary, the stored state), it settles to
 * `stopped`, so a stop that lands mid-cycle holds against the next timer tick.
 *
 * Beside the mode are four facts that are not modes: whether a cycle is in flight, whether a wake request is
 * waiting, whether the stop warning was already given, and whether the worker is closed (the latch that ends the
 * timer chain). The module holds no Redis, timers or workers; the scheduler does the talking and asks here which
 * move to make.
 */

export type RunMode = "running" | "paused" | "stopping" | "stopped";

export interface RunState {
    mode(): RunMode;
    /** A cycle of this process is between `beginCycle` and `endCycle`. */
    cycleInFlight(): boolean;
    /** A trigger asked for a cycle now and no cycle has taken the request yet. */
    wakeRequested(): boolean;
    /** The stop warning was given for the current stop. */
    stopWarned(): boolean;
    /** The worker was closed and has not been opened again: the timer chain must end. */
    isClosed(): boolean;

    // Moves from the control channel (another process asks).
    /** running -> paused. Never lifts or cancels a stop. */
    pause(): void;
    /** paused -> running. Never lifts or cancels a stop. */
    resume(): void;
    /** Any mode -> stopping. */
    stop(): void;

    // Moves the scheduler makes when it sees the stored state.
    /** The stored state says paused, and this process missed the message: running -> paused. */
    adoptPause(): void;
    /** A stop was seen and acted on (admission, a phase boundary, or the stored state): any mode -> stopped. */
    settleStop(): void;

    // Moves from an operator's start and the worker's own lifetime.
    /** An operator's start lifts a stop or a pause: any mode -> running, and the stop warning is re-armed. */
    start(): void;
    /** The worker opens: running, or paused when a stored operator pause is being honoured. Reopens a closed worker. */
    open(options: { paused: boolean }): void;
    /** The worker closes: the timer chain ends. The mode is left as it was. */
    close(): void;

    // Wake requests (a trigger asks for one cycle now, past the minimum interval and a stop).
    requestWake(): void;
    takeWake(): void;

    // One cycle at a time in this process.
    /** Claims the in-flight slot; false when a cycle already holds it. */
    beginCycle(): boolean;
    endCycle(): void;

    // Questions the cycle asks.
    /** Whether a cycle may go past the stop check: not while stopped, unless it is a full run or was woken. */
    admitsCycle(options: { fullMode: boolean }): boolean;
    /** Whether a cycle that is running should stop its work now: any mode but running. */
    haltRequested(): boolean;
    /** Periodic cleanup runs only while the worker runs, never during a pause or stop. */
    mayDoHousekeeping(): boolean;

    markStopWarned(): void;
}

export function createRunState(): RunState {
    let mode: RunMode = "running";
    let inFlight = false;
    let wake = false;
    let warned = false;
    let closed = false;

    return {
        mode: () => mode,
        cycleInFlight: () => inFlight,
        wakeRequested: () => wake,
        stopWarned: () => warned,
        isClosed: () => closed,

        pause() {
            if (mode === "running") mode = "paused";
        },
        resume() {
            if (mode === "paused") mode = "running";
        },
        stop() {
            mode = "stopping";
        },

        adoptPause() {
            if (mode === "running") mode = "paused";
        },
        settleStop() {
            // A stop already settled has its warning; a new stop gets its own.
            if (mode !== "stopped") warned = false;
            // The stop wins over a request still waiting: left set, it would run a cycle past the stop at the next tick.
            wake = false;
            mode = "stopped";
        },

        start() {
            mode = "running";
            warned = false;
        },
        open({ paused }) {
            closed = false;
            mode = paused ? "paused" : "running";
            warned = false;
        },
        close() {
            closed = true;
        },

        requestWake() {
            wake = true;
        },
        takeWake() {
            wake = false;
        },

        beginCycle() {
            if (inFlight) return false;
            inFlight = true;
            return true;
        },
        endCycle() {
            inFlight = false;
        },

        admitsCycle({ fullMode }) {
            return mode !== "stopped" || fullMode || wake;
        },
        haltRequested: () => mode !== "running",
        mayDoHousekeeping: () => mode === "running",

        markStopWarned() {
            warned = true;
        },
    };
}
