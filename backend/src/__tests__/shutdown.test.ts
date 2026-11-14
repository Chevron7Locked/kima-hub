/**
 * The shutdown sequence: new work stops first, what is running drains, resources close, and the process always
 * exits, even when a step hangs. The process exit is a parameter, so nothing here ends the test process.
 */

import { createShutdown, ShutdownPlan } from "../shutdown";
import { expectLog } from "./helpers/expectedLogs";

const never = () => new Promise<void>(() => {});
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A plan whose every step records its name in `order`, with `overrides` replacing steps. */
function plan(order: string[], overrides: Partial<ShutdownPlan> = {}) {
    const exits: number[] = [];
    const steps: ShutdownPlan = {
        stopAccepting: [() => void order.push("close the server"), () => void order.push("stop reconciliation")],
        drain: async () => {
            await tick(10);
            order.push("drain");
        },
        close: [() => void order.push("workers"), async () => void order.push("redis"), () => void order.push("database")],
        deadlineMs: 2000,
        exit: (code) => void exits.push(code),
        ...overrides,
    };
    return { steps, exits };
}

describe("createShutdown", () => {
    it("stops new work, then drains, then closes in order, and exits 0", async () => {
        const order: string[] = [];
        const { steps, exits } = plan(order);

        await createShutdown(steps)("SIGTERM");

        expect(order).toEqual(["close the server", "stop reconciliation", "drain", "workers", "redis", "database"]);
        expect(exits).toEqual([0]);
    });

    it("exits 1 after a clean run when a crash started the shutdown, so a restart policy sees it", async () => {
        const order: string[] = [];
        const { steps, exits } = plan(order);

        await createShutdown(steps)("uncaughtException", { failed: true });

        expect(order).toEqual(["close the server", "stop reconciliation", "drain", "workers", "redis", "database"]);
        expect(exits).toEqual([1]);
    });

    it("has stopped accepting work before the drain starts", async () => {
        const order: string[] = [];
        const { steps } = plan(order, {
            drain: async () => {
                order.push(`drain sees ${order.length} stopped`);
            },
        });

        await createShutdown(steps)("SIGTERM");

        expect(order).toContain("drain sees 2 stopped");
    });

    it("still drains and closes when a stop step throws, and says so", async () => {
        const order: string[] = [];
        const logged = expectLog("error");
        const { steps, exits } = plan(order, {
            stopAccepting: [
                () => {
                    throw new Error("server was never listening");
                },
                () => void order.push("stop reconciliation"),
            ],
        });

        await createShutdown(steps)("SIGTERM");

        expect(order).toEqual(["stop reconciliation", "drain", "workers", "redis", "database"]);
        expect(exits).toEqual([0]);
        expect(logged).toHaveBeenCalled();
    });

    it("runs every close step when one throws, and exits 1", async () => {
        const order: string[] = [];
        const logged = expectLog("error");
        const { steps, exits } = plan(order, {
            close: [
                () => void order.push("workers"),
                async () => {
                    throw new Error("enrichment state would not disconnect");
                },
                async () => void order.push("redis"),
                () => void order.push("database"),
            ],
        });

        await createShutdown(steps)("SIGTERM");

        expect(order).toEqual(["close the server", "stop reconciliation", "drain", "workers", "redis", "database"]);
        expect(exits).toEqual([1]);
        expect(logged.mock.calls.flat().join(" ")).toContain("enrichment state would not disconnect");
    });

    it("exits 1 when several close steps throw, and still reaches the last", async () => {
        const order: string[] = [];
        expectLog("error");
        const fail = (message: string) => () => {
            throw new Error(message);
        };
        const { steps, exits } = plan(order, {
            close: [fail("first"), fail("second"), () => void order.push("database")],
        });

        await createShutdown(steps)("SIGTERM");

        expect(order).toContain("database");
        expect(exits).toEqual([1]);
    });

    it("exits 1 when a crash arrives after a stop signal began a shutdown that would have exited 0", async () => {
        const order: string[] = [];
        let release!: () => void;
        const slow = new Promise<void>((resolve) => (release = resolve));
        const { steps, exits } = plan(order, { drain: () => slow });
        const shutdown = createShutdown(steps);

        const done = shutdown("SIGTERM");
        await shutdown("uncaughtException", { failed: true });
        expect(exits).toEqual([]);

        release();
        await done;
        expect(order).toEqual(["close the server", "stop reconciliation", "workers", "redis", "database"]);
        expect(exits).toEqual([1]);
    });

    it("still exits 0 when the later call is no failure", async () => {
        const order: string[] = [];
        let release!: () => void;
        const slow = new Promise<void>((resolve) => (release = resolve));
        const { steps, exits } = plan(order, { drain: () => slow });
        const shutdown = createShutdown(steps);

        const done = shutdown("SIGTERM");
        await shutdown("SIGINT");
        release();
        await done;

        expect(exits).toEqual([0]);
    });

    it("still closes the resources when the drain throws, and exits 1", async () => {
        const order: string[] = [];
        expectLog("error");
        const { steps, exits } = plan(order, {
            drain: async () => {
                throw new Error("drain broke");
            },
        });

        await createShutdown(steps)("SIGTERM");

        expect(order).toEqual(["close the server", "stop reconciliation", "workers", "redis", "database"]);
        expect(exits).toEqual([1]);
    });

    it("exits 1 at the deadline when a step never finishes, and says which signal started it", async () => {
        const order: string[] = [];
        const logged = expectLog("error");
        const { steps, exits } = plan(order, { close: [never, () => void order.push("database")], deadlineMs: 60 });

        const started = Date.now();
        void createShutdown(steps)("SIGTERM");
        await tick(250);

        expect(exits).toEqual([1]);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(order).not.toContain("database");
        expect(logged.mock.calls.flat().join(" ")).toContain("SIGTERM");
    });

    it("exits once: a step that finishes after the deadline does not exit again", async () => {
        const order: string[] = [];
        expectLog("error");
        let release!: () => void;
        const slow = new Promise<void>((resolve) => (release = resolve));
        const { steps, exits } = plan(order, { drain: () => slow, deadlineMs: 40 });

        const done = createShutdown(steps)("SIGTERM");
        await tick(120);
        expect(exits).toEqual([1]);

        release();
        await done;
        expect(exits).toEqual([1]);
    });

    it("does not fire the deadline after a clean exit", async () => {
        const order: string[] = [];
        const { steps, exits } = plan(order, { deadlineMs: 50 });

        await createShutdown(steps)("SIGTERM");
        await tick(150);

        expect(exits).toEqual([0]);
    });

    it("runs once: a second signal while shutting down starts nothing", async () => {
        const order: string[] = [];
        const { steps, exits } = plan(order);
        const shutdown = createShutdown(steps);

        await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

        expect(order.filter((step) => step === "drain")).toHaveLength(1);
        expect(exits).toEqual([0]);
    });
});
