/**
 * Similar artists come from ListenBrainz's similarity model, ranked by its own
 * score: the artist page's list, not a radio sample ranked by one song's plays.
 */

const mockLabsGet = jest.fn();
jest.mock("axios", () => ({
    create: (opts: { baseURL: string }) =>
        opts.baseURL.includes("labs") ? { get: (...a: unknown[]) => mockLabsGet(...a) } : { get: jest.fn(), post: jest.fn() },
}));
const mockSetex = jest.fn();
const mockRedisGet = jest.fn().mockResolvedValue(null);
jest.mock("../../utils/redis", () => ({
    redisClient: { get: (...a: unknown[]) => mockRedisGet(...a), setex: (...a: unknown[]) => mockSetex(...a) },
}));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../rateLimiter", () => ({
    INTERACTIVE_PRIORITY: 10,
    rateLimiter: { execute: (_key: string, fn: () => unknown) => fn() },
}));

import { listenBrainzService } from "../listenBrainz";

const SEED = "83d91898-7763-47d7-b03b-b92132375c47";
const row = (mbid: string, name: string, score: number) => ({ artist_mbid: mbid, name, score, reference_mbid: SEED });

beforeEach(() => {
    jest.clearAllMocks();
    mockRedisGet.mockResolvedValue(null);
});

describe("similar artists", () => {
    it("asks the similarity model with the artist page's algorithm", async () => {
        mockLabsGet.mockResolvedValue({ data: [] });
        await listenBrainzService.getSimilarArtists(SEED, "Pink Floyd");
        expect(mockLabsGet).toHaveBeenCalledWith("/similar-artists/json", {
            params: {
                artist_mbids: SEED,
                algorithm: "session_based_days_7500_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30",
            },
        });
    });

    it("ranks by the model's score, leaves out the seed, and spreads scores over 0.5 to 0.95", async () => {
        mockLabsGet.mockResolvedValue({
            data: [row("b", "Led Zeppelin", 1500), row(SEED, "Pink Floyd", 9999), row("a", "The Beatles", 3000)],
        });
        const out = await listenBrainzService.getSimilarArtists(SEED, "Pink Floyd");
        expect(out.map((a) => a.name)).toEqual(["The Beatles", "Led Zeppelin"]);
        expect(out[0].match).toBeCloseTo(0.95, 6);
        expect(out[1].match).toBeCloseTo(0.5 + 0.45 * 0.5, 6);
    });

    it("remembers an artist with no data for a day; an error is passed on, never remembered", async () => {
        mockLabsGet.mockResolvedValueOnce({ data: [] });
        await listenBrainzService.getSimilarArtists(SEED, "Pink Floyd");
        expect(mockSetex).toHaveBeenCalledWith(expect.any(String), 86400, "[]");

        mockSetex.mockClear();
        mockLabsGet.mockRejectedValueOnce(new Error("503"));
        await expect(listenBrainzService.getSimilarArtists(SEED, "Pink Floyd")).rejects.toThrow("503");
        expect(mockSetex).not.toHaveBeenCalled();
    });
});
