/**
 * CJS mock for p-limit (pure ESM package; it imports yocto-queue, also ESM, so
 * it cannot be require()d by Jest's CJS runner). Mirrors the p-queue mock:
 * the returned limiter executes each task immediately -- no concurrency limiting
 * in tests (a performance concern, not a correctness one for unit tests).
 */
function pLimit(concurrency) {
    const limit = (fn, ...args) => Promise.resolve().then(() => fn(...args));
    limit.activeCount = 0;
    limit.pendingCount = 0;
    limit.clearQueue = () => {};
    limit.concurrency = concurrency;
    return limit;
}

module.exports = pLimit;
module.exports.default = pLimit;
