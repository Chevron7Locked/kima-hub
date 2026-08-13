/**
 * Sets required environment variables for tests before any module is loaded.
 * Must be CJS -- runs in the Jest worker process via setupFiles.
 *
 * Every assignment below is `??=`-style (only fills in a value the
 * environment didn't already set), not `=`. This file used to hardcode
 * DATABASE_URL/REDIS_URL unconditionally, which overrode whatever the
 * environment provided -- so the ~40 integration tests that need a real
 * Postgres were welded to one specific machine's Docker setup and could
 * never fail for the absence of a database, including in CI, no matter what
 * DATABASE_URL a runner set. The values on the right of each `??=` are only
 * the LOCAL DEV fallback (shared with test-global-setup.cjs via
 * test-db-defaults.cjs, so the two can't drift apart), so a developer's plain
 * `npm test` keeps working unchanged -- CI (or anyone else) supplies its own
 * and this file gets out of the way.
 */
const { DATABASE_URL_FALLBACK, REDIS_URL_FALLBACK } = require('./test-db-defaults.cjs');
const { workerDatabaseUrl } = require('./test-worker-db.cjs');

process.env.JWT_SECRET ??= 'test-jwt-secret-for-testing-purposes-only-32chars';
process.env.SESSION_SECRET ??= 'test-session-secret-for-testing-purposes-only';
process.env.DATABASE_URL ??= DATABASE_URL_FALLBACK;
process.env.REDIS_URL ??= REDIS_URL_FALLBACK;
// Required by utils/encryption at module load. Tests that transitively import the
// encryption chain (e.g. audiobookshelf via routes) fail to load without it.
process.env.SETTINGS_ENCRYPTION_KEY ??= '/pqt6ujDwltWiWSK1uSkpQOfwXQpORT0CWScZ8m66Kg=';
// Required by config.ts's zod env validation (which process.exit(1)s if missing).
process.env.MUSIC_PATH ??= '/music';

// Per-worker database isolation. Deliberately NOT `??=`: CI (and the ??=
// above) supply the SERVER connection -- host/port/creds/base db name -- but
// every worker still has to be redirected onto its OWN database, every run,
// even when DATABASE_URL was already set by the environment. `JEST_WORKER_ID`
// is set by Jest itself in every mode, including `--runInBand` (confirmed
// empirically: `--runInBand` still sets it to "1", not undefined), so this
// never falls through to the shared base database by accident.
// `test-global-setup.cjs` is what actually CREATES `<base>_w<id>` -- see that
// file (including its top comment on WHY this exists) -- this only ever
// points at one, never creates one.
if (process.env.JEST_WORKER_ID) {
    process.env.DATABASE_URL = workerDatabaseUrl(process.env.DATABASE_URL, process.env.JEST_WORKER_ID);
}
