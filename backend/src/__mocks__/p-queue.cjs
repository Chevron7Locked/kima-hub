/**
 * CJS mock for p-queue (pure ESM package incompatible with Jest's CJS runner).
 * Provides the minimal PQueue API the services use.
 * Functions start immediately -- no rate limiting in tests -- and onIdle waits for every one still running, as the
 * real queue's does.
 */
class PQueue {
    constructor(opts = {}) {
        this.concurrency = opts.concurrency ?? Infinity;
        this.pending = 0;
        this.size = 0;
        this.running = new Set();
    }

    add(fn) {
        const run = Promise.resolve().then(fn);
        const tracked = run.then(
            () => undefined,
            () => undefined,
        );
        this.running.add(tracked);
        this.pending = this.running.size;
        tracked.then(() => {
            this.running.delete(tracked);
            this.pending = this.running.size;
        });
        return run;
    }

    // Nothing ever waits here, so there is nothing to move.
    setPriority() {}

    async onIdle() {
        while (this.running.size > 0) await Promise.all([...this.running]);
    }

    clear() {
        this.size = 0;
    }
}

module.exports = PQueue;
module.exports.default = PQueue;
