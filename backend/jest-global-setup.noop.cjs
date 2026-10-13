/**
 * No-op globalSetup for running individual mocked-out route tests in
 * environments without a test database (the real global setup clones the
 * DB per worker and requires Postgres + pgvector + Redis).
 *
 *   npx jest --globalSetup=./jest-global-setup.noop.cjs <test file>
 */
module.exports = async () => {};
