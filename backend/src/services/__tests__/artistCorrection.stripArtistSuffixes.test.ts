/**
 * stripArtistSuffixes takes collaboration and edition noise off an artist name before it is searched. The edition note
 * after a dash is the shared rule (utils/normalization stripEditionNote); a dash inside a name stays.
 */
jest.mock("../../utils/redis", () => ({ redisClient: { get: jest.fn(), set: jest.fn(), setex: jest.fn() } }));
jest.mock("../../utils/db", () => ({ prisma: {} }));
jest.mock("../musicbrainz", () => ({ musicBrainzService: {} }));
jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { stripArtistSuffixes } from "../artistCorrection";

describe("stripArtistSuffixes", () => {
    it.each([
        ["The Beatles [2009 Remaster]", "The Beatles"],
        ["Gun N' Roses (feat. Codex)", "Gun N' Roses"],
        ["Radiohead - Remastered", "Radiohead"],
        ["Radiohead – 2009 Remaster", "Radiohead"],
        ["Radiohead - Live", "Radiohead"],
    ])("cleans %s", (name, expected) => {
        expect(stripArtistSuffixes(name)).toBe(expected);
    });

    it.each([["Jay-Z"], ["Blink-182"], ["Sleeping - Live and Let Die"], ["Nine Inch Nails"]])("keeps %s", (name) => {
        expect(stripArtistSuffixes(name)).toBe(name);
    });
});
