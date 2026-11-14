/**
 * How long-running background work learns that the server is shutting down, and how the shutdown learns which work a
 * person's request started.
 *
 * Work that goes through many batches takes `{ shouldStop }` and asks it between batches: once it says yes the work ends
 * quietly with what it did, so none of it touches the database after the shutdown has closed it. A wait inside that
 * work (`sleepUnlessStopped`) and a download (`stopSignal`) end within a moment of the stop instead of running out.
 *
 * Work a person's request starts (an admin backfill, a re-file, a sync) cannot be handed the shutdown by its caller,
 * so it starts through `runAsRequestWork`: the work is handed `shutdownStop()`, which follows the running server's
 * shutdown once `index.ts` has registered it, and is counted, so the shutdown's drain (`whenRequestWorkEnded`) waits for
 * it as it does for the start-up catch-up work. Until a shutdown is registered (in a test, or a script) nothing is
 * shutting down.
 */

export interface StopCheck {
    shouldStop?: () => boolean;
}

/** How often a wait or a download asks whether the shutdown has begun. */
const POLL_MS = 50;

let shutdownHasBegun: () => boolean = () => false;

/** Registers the running server's "has a shutdown begun?" answer. Called once, where the shutdown is created. */
export function useShutdownCheck(check: () => boolean): void {
    shutdownHasBegun = check;
}

/** The stop check of work started by a request: it stops once the server's shutdown has begun. */
export function shutdownStop(): StopCheck {
    return { shouldStop: () => shutdownHasBegun() };
}

/** Waits `ms`, ending at once if the stop check says yes (asked every 50 ms) so a pause never outlasts a shutdown. */
export function sleepUnlessStopped(ms: number, { shouldStop }: StopCheck): Promise<void> {
    if (shouldStop?.()) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const end = () => {
            clearTimeout(timer);
            clearInterval(watch);
            resolve();
        };
        const timer = setTimeout(end, ms);
        const watch = shouldStop ? setInterval(() => shouldStop() && end(), Math.min(POLL_MS, ms)) : undefined;
    });
}

/**
 * A signal that aborts once the stop check says yes (asked every 50 ms), for work that waits on something else (a
 * download). `release()` ends the watching: call it when the work is done.
 */
export function stopSignal({ shouldStop }: StopCheck): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController();
    if (shouldStop?.()) {
        controller.abort();
        return { signal: controller.signal, release: () => {} };
    }
    const watch = shouldStop
        ? setInterval(() => {
              if (shouldStop()) {
                  controller.abort();
                  clearInterval(watch);
              }
          }, POLL_MS)
        : undefined;
    return { signal: controller.signal, release: () => clearInterval(watch) };
}

const requestWork = new Set<Promise<unknown>>();

/**
 * Starts work a request asked for. It is counted from this call (before the work's first await) until it ends, and it
 * is handed the shutdown's stop check. Returns the work's own promise, so the caller still sees its answer or failure.
 */
export function runAsRequestWork<T>(run: (stop: StopCheck) => Promise<T>): Promise<T> {
    const work = run(shutdownStop());
    requestWork.add(work);
    const forget = () => void requestWork.delete(work);
    work.then(forget, forget);
    return work;
}

/** Resolves when no request-started work is running, including work started while it waited. Never rejects. */
export async function whenRequestWorkEnded(): Promise<void> {
    while (requestWork.size > 0) await Promise.allSettled([...requestWork]);
}

/**
 * Runs work that is not given a stop check by its caller (a download inside an enrichment step or a cache fill) with a
 * signal that aborts once the server's shutdown has begun, so the work ends within a moment instead of running out its
 * own timeout. The watching ends with the work, whether it answers or fails.
 */
export async function withShutdownSignal<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const { signal, release } = stopSignal(shutdownStop());
    try {
        return await run(signal);
    } finally {
        release();
    }
}
