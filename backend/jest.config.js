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
    },
};
