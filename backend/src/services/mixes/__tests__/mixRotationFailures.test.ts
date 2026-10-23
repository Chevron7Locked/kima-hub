/**
 * One mix failing must not blank the Home page: a generator that throws (a recipe refusing a library with no spread
 * on a mood) is logged and counted as no mix, both among the day's picks and in the fallback loop that fills their
 * places. Every generator is a mock that returns a mix whose type is its own name, so the picks are seen through the
 * calls they receive; the playlist service's pick and fallback logic run for real.
 */
jest.mock("../moodMixes");
jest.mock("../genreMixes");
jest.mock("../timeMixes");
// Spelled out: generating its automock loads the similar-artist lookup, whose client keeps Jest from exiting.
jest.mock("../discoveryMixes", () => ({
    generateTopTracksMix: jest.fn(),
    generateRediscoverMix: jest.fn(),
    generateArtistSimilarMix: jest.fn(),
    generateRandomDiscoveryMix: jest.fn(),
}));
jest.mock("../../moodBucketService", () => ({ moodBucketService: { getUserMoodMix: jest.fn(async () => null) } }));
jest.mock("../../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as moodMixes from "../moodMixes";
import * as genreMixes from "../genreMixes";
import * as timeMixes from "../timeMixes";
import * as discoveryMixes from "../discoveryMixes";
import { logger } from "../../../utils/logger";
import { programmaticPlaylistService } from "../index";
import type { ProgrammaticMix } from "../helpers";

const USER = "rotation-user";

/** Every generator the rotation can call, by its exported name. */
const generators = new Map<string, jest.Mock>(
    [moodMixes, genreMixes, timeMixes, discoveryMixes].flatMap((module) =>
        Object.entries(module)
            .filter(([name, value]) => name.startsWith("generate") && jest.isMockFunction(value))
            .map(([name, value]) => [name, value as jest.Mock] as [string, jest.Mock]),
    ),
);

const mixOf = (name: string): ProgrammaticMix => ({
    id: `${name}-id`, type: name, name, description: "", trackIds: ["t"], coverUrls: [], trackCount: 1, color: "",
});

/** The generators called, in call order. */
function calledInOrder(): string[] {
    return [...generators.entries()]
        .flatMap(([name, mock]) => mock.mock.invocationCallOrder.map((order) => ({ name, order })))
        .sort((a, b) => a.order - b.order)
        .map((c) => c.name);
}

beforeEach(() => {
    for (const [name, mock] of generators) mock.mockReset().mockImplementation(async () => mixOf(name));
    (logger.error as jest.Mock).mockClear();
});

it("finds the rotation's generators", () => {
    // 38 rotation entries plus the custom mood mix, which is not in the rotation.
    expect(generators.size).toBeGreaterThanOrEqual(38);
});

it("returns the other picks and a replacement when one of the day's picks throws", async () => {
    const all = await programmaticPlaylistService.generateAllMixes(USER);
    expect(all).toHaveLength(5);
    const picks = calledInOrder();
    expect(picks).toHaveLength(5);

    const failing = picks[2];
    for (const [name, mock] of generators) {
        mock.mockReset().mockImplementation(async () => {
            if (name === failing) throw new Error("the library's calm has no spread to score against");
            return mixOf(name);
        });
    }
    const mixes = await programmaticPlaylistService.generateAllMixes(USER);

    expect(calledInOrder().slice(0, 5)).toEqual(picks);
    expect(mixes).toHaveLength(5);
    expect(mixes.map((m) => m.type)).not.toContain(failing);
    for (const name of picks.filter((p) => p !== failing)) expect(mixes.map((m) => m.type)).toContain(name);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String((logger.error as jest.Mock).mock.calls[0][0])).toContain("failed");
});

it("skips a generator that throws in the fallback loop and keeps filling", async () => {
    const quiet = async () => null;
    await programmaticPlaylistService.generateAllMixes(USER);
    const picks = calledInOrder();

    // Every pick comes back empty, so the fallback loop walks the list in order.
    for (const [name, mock] of generators) {
        mock.mockReset().mockImplementation(picks.includes(name) ? quiet : async () => mixOf(name));
    }
    const filled = await programmaticPlaylistService.generateAllMixes(USER);
    const fallbacks = calledInOrder().slice(5);
    expect(filled.map((m) => m.type)).toEqual(fallbacks.slice(0, 5));

    const failing = fallbacks[0];
    for (const [name, mock] of generators) {
        mock.mockReset().mockImplementation(
            picks.includes(name)
                ? quiet
                : async () => {
                      if (name === failing) throw new Error("the library's calm has no spread to score against");
                      return mixOf(name);
                  },
        );
    }
    const mixes = await programmaticPlaylistService.generateAllMixes(USER);
    const tried = calledInOrder().slice(5);

    // The same walk, the failing generator first, then one more in its place.
    expect(tried.slice(0, 5)).toEqual(fallbacks.slice(0, 5));
    expect(tried).toHaveLength(6);
    expect(mixes).toHaveLength(5);
    expect(mixes.map((m) => m.type)).toEqual(tried.slice(1));
    expect(logger.error).toHaveBeenCalledTimes(1);
});
