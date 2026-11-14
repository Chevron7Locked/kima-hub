/**
 * The scheduler's run state: four modes that change only through named moves.
 * Pure state, so every move is tried from every mode.
 */

import { createRunState, type RunMode, type RunState } from "../runState";

const MODES: RunMode[] = ["running", "paused", "stopping", "stopped"];

/** A run state brought into `mode` by moves alone. */
function inMode(mode: RunMode): RunState {
    const run = createRunState();
    run.open({ paused: false });
    if (mode === "paused") run.pause();
    if (mode === "stopping") run.stop();
    if (mode === "stopped") {
        run.stop();
        run.settleStop();
    }
    expect(run.mode()).toBe(mode);
    return run;
}

describe("run state", () => {
    it("starts running, open, with nothing in flight", () => {
        const run = createRunState();
        expect(run.mode()).toBe("running");
        expect(run.cycleInFlight()).toBe(false);
        expect(run.wakeRequested()).toBe(false);
        expect(run.isClosed()).toBe(false);
    });

    describe("every move from every mode", () => {
        // The mode reached from running, paused, stopping and stopped, in that order.
        const table: Array<[string, (r: RunState) => void, RunMode[]]> = [
            ["pause", (r) => r.pause(), ["paused", "paused", "stopping", "stopped"]],
            ["resume", (r) => r.resume(), ["running", "running", "stopping", "stopped"]],
            ["stop", (r) => r.stop(), ["stopping", "stopping", "stopping", "stopping"]],
            ["settleStop", (r) => r.settleStop(), ["stopped", "stopped", "stopped", "stopped"]],
            ["adoptPause", (r) => r.adoptPause(), ["paused", "paused", "stopping", "stopped"]],
            ["start", (r) => r.start(), ["running", "running", "running", "running"]],
            ["open", (r) => r.open({ paused: false }), ["running", "running", "running", "running"]],
            ["open, honouring a stored pause", (r) => r.open({ paused: true }), ["paused", "paused", "paused", "paused"]],
        ];

        it.each(table)("%s", (_name, move, expected) => {
            MODES.forEach((from, i) => {
                const run = inMode(from);
                move(run);
                expect([from, run.mode()]).toEqual([from, expected[i]]);
            });
        });

        it("a pause or resume never lifts a stop, and a resume never cancels one in progress", () => {
            const stopping = inMode("stopping");
            stopping.resume();
            expect(stopping.mode()).toBe("stopping");

            const stopped = inMode("stopped");
            stopped.pause();
            stopped.resume();
            expect(stopped.mode()).toBe("stopped");
        });
    });

    describe("stop during a run", () => {
        it("a stop that arrives mid-cycle leaves the worker stopped once the cycle sees it", () => {
            const run = inMode("running");
            run.beginCycle();

            run.stop();
            expect(run.cycleInFlight()).toBe(true);
            // The cycle's next look at the run state: halt, and settle.
            expect(run.haltRequested()).toBe(true);
            run.settleStop();
            run.endCycle();

            expect(run.mode()).toBe("stopped");
            expect(run.cycleInFlight()).toBe(false);
            // A timer tick must not start work again.
            expect(run.admitsCycle()).toBe(false);
        });

        it("a pause mid-cycle halts the cycle without stopping the worker", () => {
            const run = inMode("running");
            run.beginCycle();
            run.pause();
            expect(run.haltRequested()).toBe(true);
            run.endCycle();
            expect(run.mode()).toBe("paused");
        });

        it("a running worker does not halt", () => {
            const run = inMode("running");
            run.beginCycle();
            expect(run.haltRequested()).toBe(false);
        });
    });

    describe("restart after a user stop", () => {
        it("an operator's start lifts the stop and re-arms the stop warning", () => {
            const run = inMode("stopped");
            run.markStopWarned();
            expect(run.stopWarned()).toBe(true);

            run.start();
            expect(run.mode()).toBe("running");
            expect(run.stopWarned()).toBe(false);
            expect(run.admitsCycle()).toBe(true);
        });

        it("a new stop re-arms the stop warning", () => {
            const run = inMode("stopped");
            run.markStopWarned();
            run.stop();
            run.settleStop();
            expect(run.stopWarned()).toBe(false);
        });

        it("closing and opening the worker again starts fresh, whatever it was doing", () => {
            const run = inMode("stopped");
            run.close();
            expect(run.isClosed()).toBe(true);

            run.open({ paused: false });
            expect(run.isClosed()).toBe(false);
            expect(run.mode()).toBe("running");
        });

        it("opening with a stored pause keeps the worker paused", () => {
            const run = createRunState();
            run.open({ paused: true });
            expect(run.mode()).toBe("paused");
            expect(run.admitsCycle()).toBe(true);
            expect(run.haltRequested()).toBe(true);
        });
    });

    describe("a wake request", () => {
        it("lets one cycle through a stopped worker, and is spent when taken", () => {
            const run = inMode("stopped");
            expect(run.admitsCycle()).toBe(false);

            run.requestWake();
            expect(run.wakeRequested()).toBe(true);
            expect(run.admitsCycle()).toBe(true);
            run.takeWake();
            expect(run.wakeRequested()).toBe(false);
            expect(run.admitsCycle()).toBe(false);
        });

        it("a stop seen by a cycle drops a waiting request: the stop wins over it", () => {
            const run = inMode("running");
            run.requestWake();
            run.stop();
            run.settleStop();
            expect(run.wakeRequested()).toBe(false);
            expect(run.admitsCycle()).toBe(false);
        });
    });

    describe("one cycle at a time", () => {
        it("holds the in-flight slot from begin to end", () => {
            const run = inMode("running");
            expect(run.cycleInFlight()).toBe(false);
            run.beginCycle();
            expect(run.cycleInFlight()).toBe(true);
            run.endCycle();
            expect(run.cycleInFlight()).toBe(false);
        });

        it("a cycle's settle promise resolves when it ends, and is resolved when none runs", async () => {
            const run = inMode("running");
            await run.cycleSettled();

            run.beginCycle();
            let settled = false;
            const waiting = run.cycleSettled().then(() => { settled = true; });
            await Promise.resolve();
            expect(settled).toBe(false);

            run.endCycle();
            await waiting;
            expect(settled).toBe(true);
            await run.cycleSettled();
        });

        it("a settle promise taken mid-cycle belongs to that cycle, not the next one", async () => {
            const run = inMode("running");
            run.beginCycle();
            const first = run.cycleSettled();
            run.endCycle();
            run.beginCycle();
            await first;
            expect(run.cycleInFlight()).toBe(true);
        });
    });

    describe("the phase a cycle is inside", () => {
        it("is none until a phase is entered, and none again once it is left", () => {
            const run = inMode("running");
            expect(run.phase()).toBeNull();
            run.beginCycle();
            run.enterPhase("analysis");
            expect(run.phase()).toBe("analysis");
            run.leavePhase("analysis");
            expect(run.phase()).toBeNull();
        });

        it("leaving a phase clears only that phase, so an abandoned cycle cannot clear the phase a reopened worker is in", () => {
            const run = inMode("running");
            run.beginCycle();
            run.enterPhase("analysis");
            // The 30 s stop gave up on this cycle; the worker reopened and a new cycle entered another phase.
            run.endCycle();
            run.beginCycle();
            run.enterPhase("embedding");
            run.leavePhase("analysis");
            expect(run.phase()).toBe("embedding");
            run.leavePhase("embedding");
            expect(run.phase()).toBeNull();
        });

        it("a cycle that ends inside a phase leaves none behind for the next one", () => {
            const run = inMode("running");
            run.beginCycle();
            run.enterPhase("embedding");
            run.endCycle();
            expect(run.phase()).toBeNull();
        });
    });

    describe("housekeeping runs only while the worker runs", () => {
        it.each([
            ["running", true],
            ["paused", false],
            ["stopping", false],
            ["stopped", false],
        ] as Array<[RunMode, boolean]>)("%s: %s", (mode, allowed) => {
            expect(inMode(mode).mayDoHousekeeping()).toBe(allowed);
        });
    });
});
