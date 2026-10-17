/**
 * CJS mock for p-queue (pure ESM package incompatible with Jest's CJS runner).
 * Provides the minimal PQueue API used by rateLimiter.ts.
 * Functions are executed immediately -- no rate limiting in tests.
 */
class PQueue {
    constructor(opts = {}) {
        this.concurrency = opts.concurrency ?? Infinity;
        this.pending = 0;
        this.size = 0;
    }

    async add(fn) {
        return fn();
    }

    // Nothing ever waits here, so there is nothing to move.
    setPriority() {}

    onIdle() {
        return Promise.resolve();
    }

    clear() {
        this.size = 0;
    }
}

module.exports = PQueue;
module.exports.default = PQueue;
