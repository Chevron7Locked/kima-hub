/**
 * Test environment, set before any module loads (setupFiles, so CJS). Values
 * only fill what the environment left unset; CI supplies its own.
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
// Each worker's Prisma pool. The production default (20) times up to 15 workers is far past
// Postgres's 100 connections; 5 keeps every worker's open client (clientReaper.cjs closes each
// file's when it ends) and the global setup under it.
process.env.DATABASE_POOL_SIZE ??= '5';

// Always redirect each worker onto its own database (`<base>_w<id>`, created by
// test-global-setup.cjs) and its own Redis database (numbered by worker; Redis
// has 16, so jest.config.js runs at most 15 workers). Jest sets JEST_WORKER_ID
// in every mode, including --runInBand.
if (process.env.JEST_WORKER_ID) {
    const worker = Number(process.env.JEST_WORKER_ID);
    if (worker > 15) throw new Error(`Redis has 16 databases; worker ${worker} has none. Run at most 15 workers.`);
    process.env.DATABASE_URL = workerDatabaseUrl(process.env.DATABASE_URL, process.env.JEST_WORKER_ID);
    const redis = new URL(process.env.REDIS_URL);
    redis.pathname = `/${worker}`;
    process.env.REDIS_URL = redis.toString();
}
