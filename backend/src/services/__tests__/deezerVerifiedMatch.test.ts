/**
 * Contract tests for the "Deezer only on a verified match" rule: every
 * search-based lookup answers only when the returned name agrees with the
 * query. HTTP is mocked at the httpClient boundary; nothing hits Deezer.
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

beforeEach(() => {
    jest.resetAllMocks();
});

describe("deezerService.getAlbumCover — verified match only", () => {
    it("returns the cover when artist and title agree with the query", async () => {
        mockRateLimitedGet.mockResolvedValue({
            data: [
                {
                    title: "OK Computer",
                    artist: { name: "Radiohead" },
                    cover_xl: "https://deezer/ok.jpg",
                },
            ],
        });

        await expect(
            deezerService.getAlbumCover("Radiohead", "OK Computer")
        ).resolves.toBe("https://deezer/ok.jpg");
    });

    it("returns null when only a wrong-title hit exists (no first-hit fallback)", async () => {
        mockRateLimitedGet.mockResolvedValue({
            data: [
                {
                    title: "Pablo Honey",
                    artist: { name: "Radiohead" },
                    cover_xl: "https://deezer/pablo.jpg",
                },
            ],
        });

        await expect(
            deezerService.getAlbumCover("Radiohead", "OK Computer")
        ).resolves.toBeNull();
    });

    it("returns null when the hit's artist differs from the query", async () => {
        mockRateLimitedGet.mockResolvedValue({
            data: [
                {
                    title: "OK Computer",
                    artist: { name: "Radiohead Tribute Band" },
                    cover_xl: "https://deezer/fake.jpg",
                },
            ],
        });

        await expect(
            deezerService.getAlbumCover("Radiohead", "OK Computer")
        ).resolves.toBeNull();
    });

    it("picks the agreeing hit when the first result is a different record", async () => {
        mockRateLimitedGet.mockResolvedValue({
            data: [
                { title: "Amnesiac", artist: { name: "Radiohead" }, cover_xl: "https://deezer/amnesiac.jpg" },
                { title: "OK Computer", artist: { name: "Radiohead" }, cover_xl: "https://deezer/ok.jpg" },
            ],
        });

        await expect(
            deezerService.getAlbumCover("Radiohead", "OK Computer")
        ).resolves.toBe("https://deezer/ok.jpg");
    });
});

describe("deezerService.getArtistImage — verified match only", () => {
    it("returns null when the first search hit is a different artist", async () => {
        mockRateLimitedGet.mockResolvedValue({
            data: [{ id: 1, name: "The Only Ones", picture_xl: "https://deezer/wrong.jpg" }],
        });

        await expect(deezerService.getArtistImage("Someone Else")).resolves.toBeNull();
    });

    it("returns the picture when the search hit is the queried artist", async () => {
        mockRateLimitedGet.mockResolvedValue({
            data: [{ id: 1, name: "The Only Ones", picture_xl: "https://deezer/right.jpg" }],
        });

        await expect(deezerService.getArtistImage("The Only Ones")).resolves.toBe(
            "https://deezer/right.jpg"
        );
    });

    it("is the most-followed artist of that name, not the namesake Deezer ranks first (recorded reply)", async () => {
        const recorded = JSON.parse(
            require("fs").readFileSync(require("path").join(__dirname, "fixtures/deezer/preview-adele-hello.json"), "utf8"),
        );
        const search = recorded.replies.find((r: { path: string }) => r.path === "/search/artist").reply;
        mockRateLimitedGet.mockResolvedValue(search);
        const adele = search.data.find((a: { id: number }) => a.id === 75798);

        expect(search.data[0].id).not.toBe(75798);
        await expect(deezerService.getArtistImage("Adele")).resolves.toBe(adele.picture_xl);
    });
});

describe("deezerService.getRelatedArtists — verified seed only", () => {
    it("does not serve a mis-resolved seed's related list", async () => {
        mockRateLimitedGet.mockImplementation(async (_key: string, url: string) => {
            if (url.includes("/search/artist")) {
                return { data: [{ id: 999, name: "Someone Else" }] };
            }
            if (url.includes("/related")) {
                return { data: [{ id: 1, name: "Wrong Neighbour", link: "x" }] };
            }
            throw new Error(`unexpected url ${url}`);
        });

        await expect(deezerService.getRelatedArtists("Seed Artist", 3)).resolves.toEqual([]);
        // The related list was never fetched — the seed failed verification.
        expect(mockRateLimitedGet).toHaveBeenCalledTimes(1);
    });

    it("does not serve previews without a verified artist+title hit", async () => {
        mockRateLimitedGet.mockResolvedValue({
            data: [{ artist: { name: "Someone Else" }, title: "Song", preview: "https://deezer/p.mp3" }],
        });

        await expect(
            deezerService.getTrackPreview("Genuine Artist", "Song")
        ).resolves.toBeNull();
    });

    it("serves the preview when artist and title both verify", async () => {
        mockRateLimitedGet.mockResolvedValue({
            data: [{ artist: { name: "Genuine Artist" }, title: "Song", preview: "https://deezer/p.mp3" }],
        });

        await expect(
            deezerService.getTrackPreview("Genuine Artist", "Song")
        ).resolves.toBe("https://deezer/p.mp3");
    });
});

describe("a failed request is not a 'no'", () => {
    it("rejects instead of answering null, so artwork does not remember 'no cover'", async () => {
        mockRateLimitedGet.mockRejectedValue(new Error("timeout of 5000ms exceeded"));
        await expect(deezerService.getAlbumCover("Some Artist", "Some Album")).rejects.toThrow("timeout");
        await expect(deezerService.getArtistImage("Some Artist")).rejects.toThrow("timeout");
    });
});
