/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    clearMocks: true,
    collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
    transformIgnorePatterns: [
        'node_modules/(?!(p-queue|eventemitter3)/)',
    ],
};
