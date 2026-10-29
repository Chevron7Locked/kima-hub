/**
 * Stand-ins for the services around the library scanner, so a scan test runs the real scanner and database without
 * logging, feature probing, fingerprinting, cover art, artwork lookups or artist counts. Used as
 * `jest.mock(<module>, () => require("./helpers/scannerMocks").<name>())`.
 */

export const loggerMock = () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
});

export const featureDetectionMock = () => ({
    featureDetection: {
        getFeatures: jest.fn().mockResolvedValue({
            musicCNN: false,
            vibeEmbeddings: false,
            audiobookshelfEnabled: false,
            fpcalc: false,
        }),
    },
});

export const acoustidServiceMock = () => ({
    acoustidService: { lookup: jest.fn().mockResolvedValue(null) },
});

export const fpcalcMock = () => ({
    fpcalcService: {
        isAvailable: jest.fn().mockResolvedValue(false),
        fingerprintFile: jest.fn().mockResolvedValue(null),
    },
});

export const coverArtExtractorMock = () => ({
    CoverArtExtractor: jest.fn().mockImplementation(() => ({})),
});

export const artworkMock = () => ({
    findAlbumArtwork: jest.fn().mockResolvedValue(null),
});

export const artistCountsServiceMock = () => ({
    backfillAllArtistCounts: jest.fn().mockResolvedValue(undefined),
});

export const imageStorageMock = () => ({
    findLocalArtistImage: jest.fn().mockResolvedValue(null),
});
