/**
 * Mock factories for the modules routes/discover.ts imports at load time but a route test does not exercise.
 * Use them as `jest.mock("<path>", () => require("./helpers/discoverMocks").<factory>())`.
 */

export const discoverQueuesMock = () => ({
    discoverQueue: {
        getJob: jest.fn(),
        add: jest.fn(),
        getActive: jest.fn().mockResolvedValue([]),
        getWaiting: jest.fn().mockResolvedValue([]),
    },
    scanQueue: { add: jest.fn().mockResolvedValue(undefined) },
});

export const systemSettingsMock = () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ musicPath: "/music" }),
});

export const emptyLidarrMock = () => ({ lidarrService: {} });

/** A lock that runs the guarded body at once, with a signal that has not aborted. */
export const distributedLockMock = () => ({
    distributedLock: {
        withLock: jest.fn(async (_key: string, _ttl: number, fn: (signal: AbortSignal) => unknown) =>
            fn(new AbortController().signal),
        ),
    },
});

export const musicConfigMock = () => ({ config: { music: { musicPath: "/music" } } });
