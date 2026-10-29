/**
 * Factories for the mocks the Deezer tests share, reached from a hoisted `jest.mock` as
 * `jest.mock(path, () => require("./helpers/deezerMocks").<name>(...))`.
 */

/**
 * The network boundary: `network()` is the test's own stand-in for the request. The reply check the caller passes
 * (the fourth argument) runs on the body as the real helper runs it.
 */
export const httpClientMock = (network: () => (...args: unknown[]) => unknown) => ({
    rateLimitedGet: async (...args: unknown[]) => {
        const body = await network()(...args);
        (args[3] as ((b: unknown) => void) | undefined)?.(body);
        return body;
    },
});

/** A cache that never holds anything, so every call takes the request path. */
export const missingCacheMock = () => ({
    CacheWrapper: class {
        async get() {
            return null;
        }
        async set() {}
    },
});

/** A cache that remembers into `store`. */
export const memoryCacheMock = (store: Map<string, string>) => ({
    CacheWrapper: class {
        async get(key: string) {
            return store.get(key) ?? null;
        }
        async set(key: string, value: string) {
            store.set(key, value);
        }
    },
});
