/**
 * Shared local-dev fallback values for DATABASE_URL/REDIS_URL.
 *
 * Both test-env.cjs (loaded per Jest worker via `setupFiles`) and
 * test-global-setup.cjs (run ONCE by Jest in a separate process via
 * `globalSetup`, which never loads `setupFiles`) need to know the same "if
 * nothing else is configured, assume local dev" values. Factored out here so
 * the two can't drift apart into disagreeing about what "local dev" means.
 */
module.exports = {
    DATABASE_URL_FALLBACK: 'postgresql://test:test@localhost:5433/test',
    REDIS_URL_FALLBACK: 'redis://localhost:6379',
};
