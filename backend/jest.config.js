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
    // Runs ONCE, in a separate process, before any worker/test file starts --
    // see test-global-setup.cjs for why the vibe-schema bootstrap has to live
    // here rather than in one test file's own beforeAll.
    globalSetup: '<rootDir>/src/__mocks__/test-global-setup.cjs',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    clearMocks: true,
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
    // `@noble/ciphers` is pure ESM with no CJS build, and `utils/encryption.ts`
    // imports it synchronously. Node 24 requires it fine -- `require(esm)` is on
    // by default there, which is what makes the compiled CJS server work -- but
    // Jest resolves modules through its own registry, not Node's, so it needs
    // the package transformed to CJS on the way in. Mocking it the way p-queue
    // is mocked is not an option: the whole point of the encryption suite is
    // that it exercises the real cipher.
    transformIgnorePatterns: [
        'node_modules/(?!(p-queue|eventemitter3|@noble)/)',
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
    },
};
