/** A wait that ran out; the message says what was being waited for. */
export class TimeoutError extends Error {
    name = "TimeoutError";
}

/**
 * Reject with a labelled Error when the promise outlives the budget. Callers
 * that tolerate a timeout catch it explicitly.
 */
export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(errorMessage)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
