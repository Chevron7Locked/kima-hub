/**
 * Soulseek's result ranking gives the artist bonus only to files that name the artist, in any script: a name outside
 * English letters must not earn every file the bonus. The real ranking runs; only the blocked-user lookup in Redis is
 * stood in for (nobody is blocked).
 */

jest.mock("../../utils/redis", () => ({ redisClient: { get: jest.fn().mockResolvedValue(null) } }));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { soulseekService, type SearchResult } from "../soulseek";

const file = (user: string, path: string): SearchResult => ({
    user, file: path, size: 30 * 1024 * 1024, slots: true, bitrate: 320, speed: 2_000_000,
});

const rank = (results: SearchResult[], artist: string, title: string) =>
    (soulseekService as unknown as {
        rankAllResults(r: SearchResult[], a: string, t: string): Promise<Array<{ username: string; score: number }>>;
    }).rankAllResults(results, artist, title);

describe("Soulseek result ranking", () => {
    it("ranks the file by the asked-for Japanese artist above an equal file by someone else", async () => {
        const ranked = await rank(
            [file("other", "Music/椎名林檎/無罪モラトリアム/01 道.flac"), file("right", "Music/宇多田ヒカル/Fantôme/02 道.flac")],
            "宇多田ヒカル",
            "道",
        );
        expect(ranked[0].username).toBe("right");
        expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });

    it("still ranks an English artist's file first", async () => {
        const ranked = await rank(
            [file("other", "Music/Muse/Absolution/01 Hysteria.mp3"), file("right", "Music/Radiohead/OK Computer/01 Airbag.mp3")],
            "Radiohead",
            "Airbag",
        );
        expect(ranked[0].username).toBe("right");
    });
});
