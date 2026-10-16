/**
 * Batched AcoustID lookups against a recorded live reply (fixtures/acoustid/batch-lookup-3.json:
 * three songs, one request) and the suite's real Redis: one request carries many
 * fingerprints, each reply is saved, `lookup` answers from the saved reply without a request,
 * and nothing is asked twice.
 */

import fs from "fs";
import path from "path";
import { acoustidService } from "../acoustidService";
import { redisClient, waitForRedisReady } from "../../utils/redis";

jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Pass the request straight through: the limiter's spacing is not what is tested here.
jest.mock("../../services/rateLimiter", () => ({
    rateLimiter: { execute: (_key: string, fn: () => unknown) => fn() },
}));

const mockGetSystemSettings = jest.fn().mockResolvedValue(null);
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
    invalidateSystemSettingsCache: jest.fn(),
}));

const mockIsPaused = jest.fn().mockResolvedValue(false);
const mockHandleRateLimit = jest.fn().mockResolvedValue(false);
jest.mock("../../services/sourcePauseController", () => ({
    sourcePauseController: {
        isPaused: (...args: unknown[]) => mockIsPaused(...args),
        handleRateLimit: (...args: unknown[]) => mockHandleRateLimit(...args),
        getPause: jest.fn().mockResolvedValue(null),
    },
}));

type Recorded = {
    request: { inputs: { index: number; file: string; duration: number; fingerprint: string }[] };
    reply: { status: string; fingerprints: { index: number; results: unknown[] }[] };
};
const recorded: Recorded = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures/acoustid/batch-lookup-3.json"), "utf8"),
);
const [leatherTeeth, futureClub, humanCompassion] = recorded.request.inputs;

function setupClient() {
    const post = jest.fn().mockResolvedValue({ data: recorded.reply });
    (acoustidService as any).client = { post };
    return post;
}

/** The form fields of one request body. */
function fields(body: string): Record<string, string> {
    return Object.fromEntries(body.split("&").map((p) => p.split("=").map(decodeURIComponent)));
}

async function clearSavedReplies() {
    const keys = await redisClient.keys("acoustid:lookup:*");
    if (keys.length > 0) await redisClient.del(...keys);
}

beforeAll(waitForRedisReady);

beforeEach(async () => {
    jest.clearAllMocks();
    mockIsPaused.mockResolvedValue(false);
    mockHandleRateLimit.mockResolvedValue(false);
    // A failed batch holds batches off for a minute; each test starts with none held.
    (acoustidService as any).batchesHeldUntil = 0;
    await clearSavedReplies();
});


describe("acoustidService.lookupMany", () => {
    it("asks about three songs in one request and saves each reply", async () => {
        const post = setupClient();

        const asked = await acoustidService.lookupMany(recorded.request.inputs);

        expect(asked).toBe(3);
        expect(post).toHaveBeenCalledTimes(1);
        const sent = fields(post.mock.calls[0][1]);
        expect(sent.batch).toBe("1");
        expect(sent.meta).toBe("recordings releasegroups");
        recorded.request.inputs.forEach((input, i) => {
            expect(sent[`fingerprint.${i}`]).toBe(input.fingerprint);
            expect(sent[`duration.${i}`]).toBe(String(input.duration));
        });
        expect(await redisClient.keys("acoustid:lookup:*")).toHaveLength(3);
    });

    it("answers each song afterwards from the saved reply, with no further request", async () => {
        const post = setupClient();
        await acoustidService.lookupMany(recorded.request.inputs);
        post.mockClear();

        const res = await acoustidService.lookup(futureClub.duration, futureClub.fingerprint, { title: "Future Club" });

        expect(post).not.toHaveBeenCalled();
        expect(res.kind).toBe("answered");
        if (res.kind === "answered") {
            expect(res.value.recordingMbid).toBe("ac559309-3f00-4db6-95ce-1c1dca916677");
            // Every album AcoustID lists, in its order: a compilation comes before the album itself.
            expect(res.value.releaseGroups.map((rg) => rg.title)).toEqual([
                "Discoteka 2018 Synthwave Dance Music",
                "Hotline Miami 2: Wrong Number",
                "Dangerous Days",
            ]);
            expect(res.evidence).toMatchObject({ saved: true });
        }
    });

    it("asks nothing for songs whose replies are already saved, and asks a repeated song once", async () => {
        const post = setupClient();
        await acoustidService.lookupMany([leatherTeeth, humanCompassion]);
        post.mockClear();
        post.mockResolvedValue({ data: { status: "ok", fingerprints: [{ index: 0, results: recorded.reply.fingerprints[1].results }] } });

        const asked = await acoustidService.lookupMany([leatherTeeth, futureClub, futureClub, humanCompassion]);

        expect(asked).toBe(1);
        expect(post).toHaveBeenCalledTimes(1);
        const sent = fields(post.mock.calls[0][1]);
        expect(sent["fingerprint.0"]).toBe(futureClub.fingerprint);
        expect(sent["fingerprint.1"]).toBeUndefined();
    });

    it("sends at most ten songs per request", async () => {
        const post = jest.fn().mockImplementation(async (_url: string, body: string) => {
            const count = Object.keys(fields(body)).filter((k) => k.startsWith("fingerprint.")).length;
            return { data: { status: "ok", fingerprints: Array.from({ length: count }, (_, index) => ({ index, results: [] })) } };
        });
        (acoustidService as any).client = { post };
        const songs = Array.from({ length: 23 }, (_, i) => ({ duration: 200 + i, fingerprint: `${futureClub.fingerprint}${i}` }));

        const asked = await acoustidService.lookupMany(songs);

        expect(asked).toBe(23);
        expect(post.mock.calls.map(([, body]) => Object.keys(fields(body)).filter((k) => k.startsWith("fingerprint.")).length)).toEqual([10, 10, 3]);
    });

    it("stops at a rate limit and leaves the rest for each song to ask itself", async () => {
        const post = jest.fn().mockRejectedValue({ response: { status: 429 } });
        (acoustidService as any).client = { post };
        mockHandleRateLimit.mockResolvedValue(true);
        const songs = Array.from({ length: 15 }, (_, i) => ({ duration: 200, fingerprint: `${futureClub.fingerprint}${i}` }));

        const asked = await acoustidService.lookupMany(songs);

        expect(asked).toBe(0);
        expect(post).toHaveBeenCalledTimes(1);
        expect(mockHandleRateLimit).toHaveBeenCalledWith("acoustid", expect.anything());
        expect(await redisClient.keys("acoustid:lookup:*")).toHaveLength(0);
    });

    it("a reply AcoustID did not answer 'ok' saves nothing and stops, so each song asks on its own", async () => {
        const post = jest.fn().mockResolvedValue({ data: { status: "error", error: { code: 3, message: "invalid fingerprint" } } });
        (acoustidService as any).client = { post };
        const songs = Array.from({ length: 15 }, (_, i) => ({ duration: 200, fingerprint: `${futureClub.fingerprint}${i}` }));

        expect(await acoustidService.lookupMany(songs)).toBe(0);
        expect(post).toHaveBeenCalledTimes(1);
        expect(await redisClient.keys("acoustid:lookup:*")).toHaveLength(0);
    });

    it("after a failed batch, batches wait a minute instead of failing again every round", async () => {
        const post = jest.fn().mockRejectedValue({ response: { status: 502 } });
        (acoustidService as any).client = { post };
        const songs = [{ duration: 200, fingerprint: `${futureClub.fingerprint}x` }];

        expect(await acoustidService.lookupMany(songs)).toBe(0);
        expect(await acoustidService.lookupMany(songs)).toBe(0);
        expect(post).toHaveBeenCalledTimes(1);
        expect(await acoustidService.mayAskInBatches()).toBe(false);
    });

    it("asks nothing while the source is paused", async () => {
        const post = setupClient();
        mockIsPaused.mockResolvedValue(true);

        expect(await acoustidService.lookupMany(recorded.request.inputs)).toBe(0);
        expect(post).not.toHaveBeenCalled();
    });
});
