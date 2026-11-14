/**
 * The steps the server runs once it is listening: each starts only while no shutdown has begun, so nothing starts
 * after the workers and the database have closed. The shutdown is a real `createShutdown`, with steps that do nothing.
 */

import { createShutdown } from "../shutdown";
import { runStartSteps } from "../startup";
import { expectLog } from "./helpers/expectedLogs";

const idleShutdown = () =>
    createShutdown({ stopAccepting: [], drain: async () => {}, close: [], deadlineMs: 2000, exit: () => {} });

describe("createShutdown", () => {
    it("says whether a shutdown has begun", async () => {
        const shutdown = idleShutdown();
        expect(shutdown.hasBegun()).toBe(false);

        const done = shutdown("SIGTERM");
        expect(shutdown.hasBegun()).toBe(true);
        await done;
        expect(shutdown.hasBegun()).toBe(true);
    });
});

describe("runStartSteps", () => {
    it("runs the steps in order while no shutdown has begun", async () => {
        const shutdown = idleShutdown();
        const started: string[] = [];

        await runStartSteps(
            [
                { name: "first", run: async () => void started.push("first") },
                { name: "second", run: () => void started.push("second") },
            ],
            shutdown.hasBegun,
        );

        expect(started).toEqual(["first", "second"]);
    });

    it("does not start a step reached after a shutdown began, nor any step after it", async () => {
        const shutdown = idleShutdown();
        const started: string[] = [];

        await runStartSteps(
            [
                {
                    name: "first",
                    run: async () => {
                        started.push("first");
                        void shutdown("SIGTERM");
                    },
                },
                { name: "workers", run: () => void started.push("workers") },
                { name: "cron", run: () => void started.push("cron") },
            ],
            shutdown.hasBegun,
        );

        expect(started).toEqual(["first"]);
    });

    it("does not start anything when the shutdown began first", async () => {
        const shutdown = idleShutdown();
        void shutdown("SIGTERM");
        const run = jest.fn();

        await runStartSteps([{ name: "workers", run }], shutdown.hasBegun);

        expect(run).not.toHaveBeenCalled();
    });

    it("stops at a step that throws, naming it, and leaves the later ones unstarted", async () => {
        expectLog("error");
        const later = jest.fn();

        await runStartSteps(
            [
                {
                    name: "music config",
                    run: () => {
                        throw new Error("no settings row");
                    },
                },
                { name: "workers", run: later },
            ],
            () => false,
        );

        expect(later).not.toHaveBeenCalled();
    });
});
