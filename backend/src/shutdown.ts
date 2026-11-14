/**
 * The order the server shuts down in, apart from the resources it shuts down, so the order and the deadline can be
 * tested without ending the process.
 *
 * 1. Stop accepting work: the listener closes and the background loops stop, so nothing new starts while the rest
 *    drains. A step that throws is logged and the shutdown goes on; it must not leave the process running.
 * 2. Drain what is already running.
 * 3. Close the resources, in order. A step that throws ends the shutdown with exit code 1.
 *
 * A timer, started with the shutdown and not holding the process open, ends it with exit code 1 when any step hangs.
 * A second signal while shutting down is ignored: the deadline is what ends a shutdown that stalls.
 */

import { logger } from "./utils/logger";

export interface ShutdownPlan {
    stopAccepting: Array<() => void | Promise<void>>;
    drain: () => Promise<void>;
    close: Array<() => void | Promise<void>>;
    /** The longest the whole shutdown may take. */
    deadlineMs: number;
    exit: (code: number) => void;
}

export function createShutdown(plan: ShutdownPlan): (signal: string) => Promise<void> {
    let started = false;
    let exited = false;

    const exit = (code: number) => {
        if (exited) return;
        exited = true;
        plan.exit(code);
    };

    return async (signal) => {
        if (started) {
            logger.debug("Shutdown already in progress...");
            return;
        }
        started = true;
        logger.debug(`\nReceived ${signal}. Starting graceful shutdown...`);

        const deadline = setTimeout(() => {
            logger.error(`Shutdown after ${signal} did not finish within ${plan.deadlineMs} ms; exiting.`);
            exit(1);
        }, plan.deadlineMs);
        deadline.unref();

        try {
            for (const stop of plan.stopAccepting) {
                try {
                    await stop();
                } catch (error) {
                    logger.error("A step that stops new work failed; shutting down anyway:", error);
                }
            }
            await plan.drain();
            for (const close of plan.close) await close();
            logger.debug("Graceful shutdown complete");
            clearTimeout(deadline);
            exit(0);
        } catch (error) {
            logger.error("Error during shutdown:", error);
            clearTimeout(deadline);
            exit(1);
        }
    };
}
