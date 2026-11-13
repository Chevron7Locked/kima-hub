/**
 * Listens go to ListenBrainz in its documented submit format
 * (https://listenbrainz.readthedocs.io/en/latest/users/json.html).
 */

const mockPost = jest.fn();
jest.mock("axios", () => ({
    create: () => ({ get: jest.fn(), post: (...a: unknown[]) => mockPost(...a) }),
}));
jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), setex: jest.fn() },
}));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../rateLimiter", () => ({
    rateLimiter: { execute: (_key: string, fn: () => unknown) => fn() },
}));

import { listenBrainzService } from "../listenBrainz";

beforeEach(() => {
    mockPost.mockReset().mockResolvedValue({ status: 200 });
    jest.spyOn(listenBrainzService, "getUserToken").mockResolvedValue("token");
});

describe("submitListens", () => {
    it("sends one listen as a single listen with track_metadata", async () => {
        await expect(
            listenBrainzService.submitListens("u1", [{ artist: "Yiruma", track: "River Flows in You", release: "First Love", listenedAt: 1700000000 }]),
        ).resolves.toBe(true);
        const [url, body, opts] = mockPost.mock.calls[0];
        expect(url).toBe("/1/submit-listens");
        expect(opts.headers.Authorization).toBe("Token token");
        expect(body).toEqual({
            listen_type: "single",
            payload: [{
                listened_at: 1700000000,
                track_metadata: {
                    artist_name: "Yiruma",
                    track_name: "River Flows in You",
                    release_name: "First Love",
                    additional_info: { media_player: "kima", submission_client: "kima" },
                },
            }],
        });
    });

    it("sends several listens as an import", async () => {
        await listenBrainzService.submitListens("u1", [
            { artist: "A", track: "One", listenedAt: 1 },
            { artist: "B", track: "Two", listenedAt: 2 },
        ]);
        const body = mockPost.mock.calls[0][1];
        expect(body.listen_type).toBe("import");
        expect(body.payload.map((p: { track_metadata: { track_name: string } }) => p.track_metadata.track_name)).toEqual(["One", "Two"]);
    });
});
