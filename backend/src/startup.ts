/**
 * The work the server starts once it is listening, one step at a time. A shutdown can begin while this is still
 * going (a stop signal during a slow import), and by then the workers, Redis or the database may be closing: before
 * each step the shutdown state is read, and once a shutdown has begun no step starts, this one nor any after it.
 *
 * A step that throws is logged, and the steps after it do not run: each is built on the ones before.
 */

import { logger } from "./utils/logger";

export interface StartStep {
    name: string;
    run: () => void | Promise<void>;
}

export async function runStartSteps(steps: StartStep[], shutdownHasBegun: () => boolean): Promise<void> {
    for (const step of steps) {
        if (shutdownHasBegun()) {
            logger.debug(`[STARTUP] Shutting down; "${step.name}" and what follows it are not started`);
            return;
        }
        try {
            await step.run();
        } catch (error) {
            logger.error(`[STARTUP] "${step.name}" failed; the steps after it are not started:`, error);
            return;
        }
    }
}
