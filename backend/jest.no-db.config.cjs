// Runs DB-independent (fully mocked) route tests without the Postgres-based
// globalSetup. Usage:
//   npx jest --config jest.no-db.config.cjs src/routes/__tests__/playlists.cover.route.test.ts
const base = require('./jest.config.js');

module.exports = {
    ...base,
    globalSetup: '<rootDir>/jest-global-setup.noop.cjs',
};
