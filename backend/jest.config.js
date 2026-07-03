// Pin the timezone for the whole worker process BEFORE any Date/Intl is
// initialized. Setting process.env.TZ from inside a test file is a no-op --
// V8 caches the local zone at startup -- so date-fns' startOfWeek would resolve
// in the host zone (America/Chicago on the dev box) and emit non-midnight,
// occasionally day-shifted weekStarts. This runs in the parent before workers
// spawn; workers inherit the env, making the suite host-independent.
process.env.TZ = 'UTC';

/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/src/__mocks__/test-env.cjs'],
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    clearMocks: true,
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
    transformIgnorePatterns: [
        'node_modules/(?!(p-queue|eventemitter3)/)',
    ],
    moduleNameMapper: {
        // p-queue is pure ESM and cannot be required() by Jest's CJS runner.
        // Map it to a minimal CJS mock that executes functions immediately.
        '^p-queue$': '<rootDir>/src/__mocks__/p-queue.cjs',
        // p-limit (and its yocto-queue dep) are pure ESM too; same treatment.
        '^p-limit$': '<rootDir>/src/__mocks__/p-limit.cjs',
        // music-metadata is pure ESM with no CJS entry point; map to a CJS stub.
        '^music-metadata$': '<rootDir>/__mocks__/music-metadata.js',
    },
};
