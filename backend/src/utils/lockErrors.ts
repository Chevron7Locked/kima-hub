/**
 * What `withLock` throws when it cannot run its callback. They live apart from the lock so a caller can tell
 * the two apart without loading the Redis client, and a test that mocks the lock can keep them real.
 */

/** Someone else holds the lock: the work is theirs to do. */
export class LockHeldError extends Error {
    constructor(readonly key: string) {
        super(`Lock is held: ${key}`);
        this.name = "LockHeldError";
    }
}

/** Redis could not be asked: whether anyone holds the lock is not known. */
export class LockUnavailableError extends Error {
    constructor(readonly key: string, cause?: unknown) {
        super(`Lock unavailable, Redis could not be reached: ${key}`, { cause });
        this.name = "LockUnavailableError";
    }
}
