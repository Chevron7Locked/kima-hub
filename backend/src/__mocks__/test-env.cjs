/**
 * Sets required environment variables for tests before any module is loaded.
 * Must be CJS -- runs in the Jest worker process via setupFiles.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-testing-purposes-only-32chars';
process.env.SESSION_SECRET = 'test-session-secret-for-testing-purposes-only';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5433/test';
process.env.REDIS_URL = 'redis://localhost:6379';
// Required by utils/encryption at module load. Tests that transitively import the
// encryption chain (e.g. audiobookshelf via routes) fail to load without it.
process.env.SETTINGS_ENCRYPTION_KEY = '/pqt6ujDwltWiWSK1uSkpQOfwXQpORT0CWScZ8m66Kg=';
// Required by config.ts's zod env validation (which process.exit(1)s if missing).
process.env.MUSIC_PATH = '/music';
