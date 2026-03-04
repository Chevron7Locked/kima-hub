/**
 * Async utilities for batched processing
 * Prevents event loop blocking during long-running operations
 */

/**
 * Split array into chunks of specified size
 */
export function chunkArray<T>(array: T[], size: number): T[][] {
    if (size <= 0) throw new Error("Chunk size must be positive");
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

/**
 * Yield to the event loop - prevents blocking during long operations
 */
export function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Retry a function on transient network errors (ECONNRESET, ETIMEDOUT, AbortError)
 * with linear backoff (2s, 4s, 6s). Non-retryable errors are re-thrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 2000): Promise<T> {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err: any) {
            const isRetryable = err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.name === "AbortError";
            if (!isRetryable || i === attempts - 1) throw err;
            await new Promise(r => setTimeout(r, delayMs * (i + 1)));
        }
    }
    throw new Error("unreachable");
}

