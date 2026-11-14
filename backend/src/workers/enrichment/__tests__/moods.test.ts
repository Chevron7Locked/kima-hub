/**
 * The mood step, tried without the scheduler: the scheduler's progress read and Redis are stood in by plain
 * objects, the mood scoring and tag writing by mocks. What matters here is when the step runs, what it
 * drops and what it keeps owed.
 */

const mockBuildMoods = jest.fn();
const mockWriteMoodTags = jest.fn();
jest.mock("../../../services/moods/state", () => ({
    buildMoods: () => mockBuildMoods(),
}));
jest.mock("../../../services/moods/tags", () => ({
    writeMoodTags: () => mockWriteMoodTags(),
}));
jest.mock("../../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { createMoodStep, soundInputsSettled, type SoundInputs } from "../moods";
import { logger } from "../../../utils/logger";

const OWED = "enrichment:mood-mixes-owed";

const settled: SoundInputs = {
    audioAnalysis: { pending: 0, processing: 0, failed: 0 },
    clapEmbeddings: { pending: 0, processing: 0, retrying: 0 },
};
const vectorInFlight: SoundInputs = { ...settled, clapEmbeddings: { ...settled.clapEmbeddings, processing: 1 } };

/** A small in-memory Redis: notes and `mixes:` keys, with scan answered in two batches. */
function fakeRedis(mixKeys: string[] = []) {
    const notes = new Map<string, string>();
    const dropped: string[] = [];
    return {
        notes,
        dropped,
        get: jest.fn(async (k: string) => notes.get(k) ?? null),
        set: jest.fn(async (k: string, v: string) => (notes.set(k, v), "OK")),
        del: jest.fn(async (...ks: string[]) => {
            let n = 0;
            for (const k of ks) {
                if (notes.delete(k)) n++;
                else if (mixKeys.includes(k)) (dropped.push(k), n++);
            }
            return n;
        }),
        scan: jest.fn(async (cursor: string) =>
            cursor === "0" ? ["7", mixKeys.slice(0, 1)] : ["0", mixKeys.slice(1)],
        ),
    };
}

function stepOver(redis: ReturnType<typeof fakeRedis>, inputs: () => SoundInputs = () => settled) {
    return createMoodStep({ readProgress: async () => inputs(), redis: () => redis as never });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockBuildMoods.mockResolvedValue({ scored: 0, stateChanged: false });
    mockWriteMoodTags.mockResolvedValue(0);
});

describe("when the moods' inputs have settled", () => {
    it.each([
        ["an analysis is waiting", { ...settled, audioAnalysis: { ...settled.audioAnalysis, pending: 1 } }],
        ["an analysis is in flight", { ...settled, audioAnalysis: { ...settled.audioAnalysis, processing: 1 } }],
        ["an analysis is due a retry", { ...settled, audioAnalysis: { ...settled.audioAnalysis, failed: 1 } }],
        ["a sound vector is waiting", { ...settled, clapEmbeddings: { ...settled.clapEmbeddings, pending: 1 } }],
        ["a sound vector is in flight", vectorInFlight],
        ["a sound vector is due a retry", { ...settled, clapEmbeddings: { ...settled.clapEmbeddings, retrying: 1 } }],
    ])("is not so while %s", (_what, inputs) => {
        expect(soundInputsSettled(inputs)).toBe(false);
    });

    it("is so when nothing is owed", () => {
        expect(soundInputsSettled(settled)).toBe(true);
    });
});

describe("the mood step", () => {
    it.each([
        ["new scores", { scored: 3, stateChanged: true }],
        ["new statistics alone", { scored: 0, stateChanged: true }],
    ])("drops every cached mix after %s", async (_what, result) => {
        mockBuildMoods.mockResolvedValue(result);
        const redis = fakeRedis(["mixes:u1", "mixes:u2"]);

        expect(await stepOver(redis)()).toBe(result.scored);

        expect(redis.scan).toHaveBeenCalledWith("0", "MATCH", "mixes:*", "COUNT", 100);
        expect(redis.dropped).toEqual(["mixes:u1", "mixes:u2"]);
        expect(redis.notes.has(OWED)).toBe(false);
    });

    it("keeps the cached mixes when nothing changed", async () => {
        const redis = fakeRedis(["mixes:u1"]);
        expect(await stepOver(redis)()).toBe(0);
        expect(redis.scan).not.toHaveBeenCalled();
        expect(redis.del).not.toHaveBeenCalled();
    });

    it("drops only the cached mix lists, not the familiarity results, scan locks or the energy band", async () => {
        mockBuildMoods.mockResolvedValue({ scored: 1, stateChanged: false });
        const redis = fakeRedis([
            "mixes:u1", "mixes:familiar:u1", "mixes:familiar-lock:u1", "mixes:energy-band", "mixes:u2",
        ]);
        await stepOver(redis)();
        expect(redis.dropped).toEqual(["mixes:u1", "mixes:u2"]);
    });

    it("scores nothing and writes no tags while analysis or sound vectors are still being made", async () => {
        const redis = fakeRedis();
        expect(await stepOver(redis, () => vectorInFlight)()).toBe(0);
        expect(mockBuildMoods).not.toHaveBeenCalled();
        expect(mockWriteMoodTags).not.toHaveBeenCalled();
        expect(redis.scan).not.toHaveBeenCalled();
    });

    it("keeps a drop owed while inputs are unsettled, and makes it once they settle", async () => {
        mockBuildMoods.mockResolvedValue({ scored: 3, stateChanged: true });
        const redis = fakeRedis(["mixes:u1"]);
        // The step's own gate sees the inputs settled; by the time of the drop a vector is in flight again.
        const reads = jest.fn().mockResolvedValueOnce(settled).mockResolvedValueOnce(vectorInFlight);
        const step = createMoodStep({ readProgress: reads, redis: () => redis as never });
        await step();
        expect(redis.notes.get(OWED)).toBe("1");
        expect(redis.dropped).toEqual([]);

        reads.mockResolvedValue(settled);
        mockBuildMoods.mockResolvedValue({ scored: 0, stateChanged: false });
        await step();
        expect(redis.dropped).toEqual(["mixes:u1"]);
        expect(redis.notes.has(OWED)).toBe(false);
    });

    it("writes down a drop it cannot make, and makes it after a restart", async () => {
        mockBuildMoods.mockResolvedValue({ scored: 3, stateChanged: true });
        const redis = fakeRedis(["mixes:u1"]);
        redis.scan.mockRejectedValueOnce(new Error("redis busy"));
        await stepOver(redis)();
        expect(redis.set).toHaveBeenCalledWith(OWED, "1");
        expect(redis.del).not.toHaveBeenCalledWith(OWED);

        // The server restarts: a new step holds nothing in memory, only the note in Redis is left.
        mockBuildMoods.mockResolvedValue({ scored: 0, stateChanged: false });
        await stepOver(redis)();
        expect(redis.dropped).toEqual(["mixes:u1"]);
        expect(redis.del).toHaveBeenCalledWith(OWED);
    });

    it("still writes the mood tags when Redis fails, and logs that the drop is owed", async () => {
        mockBuildMoods.mockResolvedValue({ scored: 2, stateChanged: true });
        mockWriteMoodTags.mockResolvedValue(1);
        const redis = fakeRedis(["mixes:u1"]);
        redis.set.mockRejectedValueOnce(new Error("redis down"));
        const step = stepOver(redis);
        expect(await step()).toBe(2);
        expect(mockWriteMoodTags).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("the drop is still owed"),
            expect.objectContaining({ message: "redis down" }),
        );

        // Redis is back on a cycle that changed nothing: the note that could not be written is written now.
        mockBuildMoods.mockResolvedValue({ scored: 0, stateChanged: false });
        await step();
        expect(redis.set).toHaveBeenLastCalledWith(OWED, "1");
        expect(redis.dropped).toEqual(["mixes:u1"]);
    });

    it("rewrites the mood tags on every pass, after the scores and statistics", async () => {
        mockWriteMoodTags.mockResolvedValue(4);
        const redis = fakeRedis(["mixes:u1"]);
        expect(await stepOver(redis)()).toBe(0);
        expect(mockWriteMoodTags).toHaveBeenCalledTimes(1);
        expect(mockBuildMoods.mock.invocationCallOrder[0]).toBeLessThan(mockWriteMoodTags.mock.invocationCallOrder[0]);
        // No mix reads the tags, so changed tags alone keep the cached mixes.
        expect(redis.scan).not.toHaveBeenCalled();
    });

    it("logs a failure to score and writes no tags", async () => {
        const refused = new Error("[Moods] arousal_mean has no value over 3 eligible tracks");
        mockBuildMoods.mockRejectedValue(refused);
        expect(await stepOver(fakeRedis())()).toBe(0);
        expect(logger.error).toHaveBeenCalledWith("[Enrichment] Mood step failed; the cycle goes on without it:", refused);
        expect(mockWriteMoodTags).not.toHaveBeenCalled();
    });

    it("logs a failure to write the tags and returns", async () => {
        mockWriteMoodTags.mockRejectedValue(new Error("connection lost"));
        expect(await stepOver(fakeRedis())()).toBe(0);
        expect(logger.error).toHaveBeenCalledWith(
            "[Enrichment] Mood step failed; the cycle goes on without it:",
            expect.objectContaining({ message: "connection lost" }),
        );
    });
});
