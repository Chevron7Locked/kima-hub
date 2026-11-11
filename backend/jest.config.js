// V8 reads the zone once at startup, so TZ is pinned here, before workers spawn
// and inherit it. Set inside a test file it does nothing, and week starts would
// follow the host's zone.
process.env.TZ = 'UTC';

// Outside production the logger defaults to debug, which buries a run's failures under thousands of lines.
// Set here, before Prisma copies backend/.env (often LOG_LEVEL=debug) into the environment during global setup.
// Warnings and errors still print; LOG_LEVEL=debug on the command line brings the rest back for one run.
process.env.LOG_LEVEL ||= 'warn';

/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    // Node's environment, closing each file's Prisma clients after the file's own cleanup.
    testEnvironment: '<rootDir>/src/__mocks__/test-environment.cjs',
    setupFiles: ['<rootDir>/src/__mocks__/test-env.cjs'],
    // Closes every ioredis client at each file boundary so the run can exit.
    setupFilesAfterEnv: ['<rootDir>/src/__mocks__/clientReaper.cjs'],
    // Runs once, in its own process, before any worker starts.
    globalSetup: '<rootDir>/src/__mocks__/test-global-setup.cjs',
    // Runs once after the last worker: releases the run's lock on the test database.
    globalTeardown: '<rootDir>/src/__mocks__/test-global-teardown.cjs',
    // Each worker takes one of Redis's 16 databases (test-env.cjs), so at most 15.
    maxWorkers: Math.min(15, Math.max(1, require('os').availableParallelism() - 1)),
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    clearMocks: true,
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
    // `@noble/ciphers` is ESM only. Node loads it, but Jest's own registry does
    // not, so it is transformed to CJS rather than mocked: the encryption tests
    // must run the real cipher.
    transformIgnorePatterns: [
        'node_modules/(?!@noble/)',
    ],
    // The ts-jest preset only claims .ts/.tsx; the second entry is what actually
    // transforms the ESM above. Scoped to .js/.mjs so nothing else changes.
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {}],
        '^.+\\.m?js$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs' } }],
    },
    moduleNameMapper: {
        // p-queue is pure ESM and cannot be required() by Jest's CJS runner.
        // Map it to a minimal CJS mock that executes functions immediately.
        '^p-queue$': '<rootDir>/src/__mocks__/p-queue.cjs',
        // p-limit (and its yocto-queue dep) are pure ESM too; same treatment.
        '^p-limit$': '<rootDir>/src/__mocks__/p-limit.cjs',
        // music-metadata is pure ESM with no CJS entry point; map to a CJS stub.
        '^music-metadata$': '<rootDir>/__mocks__/music-metadata.js',
        // One server per test app instead of one per request.
        '^supertest$': '<rootDir>/src/__mocks__/supertest.cjs',
        // ioredis with every client registered for the reaper, in every module registry (clientReaper.cjs).
        '^ioredis$': '<rootDir>/src/__mocks__/ioredis.cjs',
    },
};
