/**
 * Sets required environment variables for tests before any module is loaded.
 * Must be CJS -- runs in the Jest worker process via setupFiles.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-testing-purposes-only-32chars';
process.env.SESSION_SECRET = 'test-session-secret-for-testing-purposes-only';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5433/test';
process.env.REDIS_URL = 'redis://localhost:6379';
