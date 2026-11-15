/**
 * What `withLock` throws when it cannot run its callback, and what a lost lease aborts with. They live apart from the lock so a caller can tell
 * the two apart without loading the Redis client, and a test that mocks the lock can keep them real.
 */

/** Someone else holds the lock: the work is theirs to do. */
export class LockHeldError extends Error {
    constructor(key: string) {
        super(`Lock is held: ${key}`);
        this.name = "LockHeldError";
    }
}

/** The reason a lease's signal aborts with: the lock expired or another holder took it while the work ran. */
export class LockLostError extends Error {
    constructor(key: string) {
        super(`Lock was lost while held: ${key}`);
        this.name = "LockLostError";
    }
}

/** Redis could not be asked: whether anyone holds the lock is not known. */
export class LockUnavailableError extends Error {
    constructor(key: string, cause?: unknown) {
        super(`Lock unavailable, Redis could not be reached: ${key}`, { cause });
        this.name = "LockUnavailableError";
    }
}
