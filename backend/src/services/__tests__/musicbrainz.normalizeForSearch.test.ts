/**
 * normalizeForSearch makes a title comparable to a release-group title: brackets and edition notes after a dash are
 * gone (the shared rule, utils/normalization stripEditionNote), a real subtitle stays.
 */
jest.mock("axios", () => ({ create: () => ({ get: jest.fn() }) }));
jest.mock("../../utils/redis", () => ({ redisClient: { get: jest.fn(), set: jest.fn(), setex: jest.fn() } }));
jest.mock("../../services/rateLimiter", () => ({ rateLimiter: { execute: async (_s: string, fn: () => Promise<unknown>) => fn() } }));
jest.mock("../../services/sourcePauseController", () => ({
    sourcePauseController: { handleRateLimit: jest.fn(), getPause: jest.fn() },
}));
jest.mock("../../config", () => ({
    USER_AGENT: "KimaTest/1.0 (test@kima.local)",
    config: { musicbrainzBaseUrl: "https://musicbrainz.org/ws/2" },
}));
jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { musicBrainzService } from "../musicbrainz";

describe("musicBrainzService.normalizeForSearch", () => {
    it.each([
        ["Discovery (Deluxe Edition)", "Discovery"],
        ["Discovery - Deluxe Edition", "Discovery"],
        ["Discovery - 2011 Remaster", "Discovery"],
        ["Discovery – Remastered", "Discovery"],
        ["Discovery [Explicit] - 2011", "Discovery"],
    ])("cuts the markers of %s", (title, expected) => {
        expect(musicBrainzService.normalizeForSearch(title)).toBe(expected);
    });

    it("keeps a subtitle that only begins like a marker", () => {
        expect(musicBrainzService.normalizeForSearch("Songs - Live and Let Die")).toBe("Songs - Live and Let Die");
    });
});
