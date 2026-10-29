/**
 * Factories for the mocks the daily-rotation tests share. Each is reached from a hoisted `jest.mock` as
 * `jest.mock(path, () => require("./helpers/rotationMocks").<name>())`.
 */

/** The discovery generators spelled out: automocking the module loads the similar-artist lookup, whose client keeps Jest from exiting. */
export const discoveryMixesMock = () => ({
    generateTopTracksMix: jest.fn(),
    generateRediscoverMix: jest.fn(),
    generateArtistSimilarMix: jest.fn(),
    generateRandomDiscoveryMix: jest.fn(),
});

export const moodBucketServiceMock = () => ({ moodBucketService: { getUserMoodMix: jest.fn(async () => null) } });

export const loggerMock = () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
});
