/**
 * How long-running background work learns that the server is shutting down. Work that goes through many batches takes
 * `{ shouldStop }` and asks it between batches: once it says yes the work ends quietly with what it did, so none of it
 * touches the database after the shutdown has closed it.
 *
 * Work a person's request starts (an admin backfill, a re-file) cannot be handed the shutdown by its caller, so it
 * reads `shutdownStop()`, which follows the running server's shutdown once `index.ts` has registered it. Until then
 * (in a test, or a script) nothing is shutting down.
 */

export interface StopCheck {
    shouldStop?: () => boolean;
}

let shutdownHasBegun: () => boolean = () => false;

/** Registers the running server's "has a shutdown begun?" answer. Called once, where the shutdown is created. */
export function useShutdownCheck(check: () => boolean): void {
    shutdownHasBegun = check;
}

/** The stop check of work started by a request: it stops once the server's shutdown has begun. */
export function shutdownStop(): StopCheck {
    return { shouldStop: () => shutdownHasBegun() };
}
