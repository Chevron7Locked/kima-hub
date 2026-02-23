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

/**
 * Process items in batches with yielding between batches
 * Checks abort signal to support early termination
 *
 * @param items - Array of items to process
 * @param batchSize - Number of items per batch
 * @param processor - Function to process each batch
 * @param signal - Optional AbortSignal for early termination
 * @returns Flattened array of all processor results
 */
export async function processBatched<T, R>(
    items: T[],
    batchSize: number,
    processor: (batch: T[]) => Promise<R[]>,
    signal?: AbortSignal
): Promise<R[]> {
    const results: R[] = [];
    const chunks = chunkArray(items, batchSize);

    for (const chunk of chunks) {
        if (signal?.aborted) {
            break; // Exit early if operation was cancelled
        }

        const batchResults = await processor(chunk);
        results.push(...batchResults);

        await yieldToEventLoop();
    }

    return results;
}
