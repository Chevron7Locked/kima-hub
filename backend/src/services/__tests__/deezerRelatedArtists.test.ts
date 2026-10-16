/**
 * Unit tests for deezerService.getRelatedArtists — HTTP is mocked at the
 * httpClient boundary (rateLimitedGet), so no live Deezer calls and no
 * Redis (CacheWrapper is stubbed to always miss).
 */

const mockRateLimitedGet = jest.fn();

jest.mock("../httpClient", () => ({
    // Only the network is stood in for: the reply check runs on the body as the real helper runs it.
    rateLimitedGet: async (...args: unknown[]) => {
        const body = await mockRateLimitedGet(...args);
        (args[3] as ((b: unknown) => void) | undefined)?.(body);
        return body;
    },
}));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../../utils/cacheWrapper", () => ({
    CacheWrapper: class {
        async get() {
            return null; // always miss — exercise the request path
        }
        async set() {
            /* no-op */
        }
    },
}));

import { deezerService } from "../deezer";

const SEED_ID = 123;

beforeEach(() => {
    jest.resetAllMocks();
});

/** Route the two Deezer calls: /search/artist first, then /artist/{id}/related. */
function mockDeezerFlow(searchBody: unknown, relatedBody: unknown) {
    mockRateLimitedGet.mockImplementation(async (_key: string, url: string) => {
        if (url.includes("/search/artist")) return searchBody;
        if (url.includes("/related")) return relatedBody;
        throw new Error(`unexpected url ${url}`);
    });
}

describe("deezerService.getRelatedArtists", () => {
    it("maps the related list to the SimilarArtist shape", async () => {
        mockDeezerFlow(
            { data: [{ id: SEED_ID, name: "Seed Artist" }] },
            {
                data: [
                    { id: 1, name: "Rel One", nb_fan: 90000, link: "https://www.deezer.com/artist/1" },
                    { id: 2, name: "Rel Two", nb_fan: 50000, link: "https://www.deezer.com/artist/2" },
                    { id: 3, name: "Rel Three", nb_fan: 10000, link: "https://www.deezer.com/artist/3" },
                ],
            }
        );

        const result = await deezerService.getRelatedArtists("Seed Artist", 3);

        expect(result.map((r) => r.name)).toEqual(["Rel One", "Rel Two", "Rel Three"]);
        // Rank-position match: first 0.9, last 0.5, linear between.
        expect(result[0].match).toBe(0.9);
        expect(result[1].match).toBeCloseTo(0.7, 5);
        expect(result[2].match).toBe(0.5);
        expect(result[0].url).toBe("https://www.deezer.com/artist/1");
        // Deezer carries no MBIDs — the shape must not invent one.
        expect(result[0].mbid).toBeUndefined();
    });

    it("excludes the seed artist when Deezer lists it among its own related artists", async () => {
        mockDeezerFlow(
            { data: [{ id: SEED_ID, name: "Seed Artist" }] },
            {
                data: [
                    { id: SEED_ID, name: "Seed Artist", nb_fan: 90000 },
                    { id: 2, name: "Rel Two", nb_fan: 50000 },
                ],
            }
        );

        const result = await deezerService.getRelatedArtists("Seed Artist", 5);
        expect(result.map((r) => r.name)).toEqual(["Rel Two"]);
    });

    it("falls back to the constructed Deezer link when an entry has no link", async () => {
        mockDeezerFlow(
            { data: [{ id: SEED_ID, name: "Seed Artist" }] },
            { data: [{ id: 7, name: "No Link", nb_fan: 100 }] }
        );

        const result = await deezerService.getRelatedArtists("Seed Artist", 5);
        expect(result[0].url).toBe("https://www.deezer.com/artist/7");
    });

    it("returns [] when the artist search finds nothing", async () => {
        mockDeezerFlow({ data: [] }, { data: [] });

        const result = await deezerService.getRelatedArtists("Nobody", 5);
        expect(result).toEqual([]);
        // Never even fetched a related list.
        expect(mockRateLimitedGet).toHaveBeenCalledTimes(1);
    });

    it("returns [] when the related list is empty", async () => {
        mockDeezerFlow(
            { data: [{ id: SEED_ID, name: "Seed Artist" }] },
            { data: [] }
        );

        const result = await deezerService.getRelatedArtists("Seed Artist", 5);
        expect(result).toEqual([]);
    });

    it("rejects when the search request fails, so a failed source is not read as no related artists", async () => {
        mockRateLimitedGet.mockRejectedValue(new Error("network down"));

        await expect(deezerService.getRelatedArtists("Seed Artist", 5)).rejects.toThrow("network down");
    });

    it("rejects when the related request fails", async () => {
        mockRateLimitedGet.mockImplementation(async (_key: string, url: string) => {
            if (url.includes("/search/artist")) return { data: [{ id: SEED_ID, name: "Seed Artist" }] };
            throw new Error("related endpoint down");
        });

        await expect(deezerService.getRelatedArtists("Seed Artist", 5)).rejects.toThrow("related endpoint down");
    });
});