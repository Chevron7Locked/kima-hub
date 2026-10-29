/**
 * AcoustID lookups over mocked HTTP shaped like a live api.acoustid.org/v2
 * response. Every outcome is a typed Outcome: low scores, short or bare
 * matches are `absent`, network errors `transient`, bad input `permanent`
 * with no call. The settings key beats config; a passed key beats both.
 */

import { acoustidService } from "../acoustidService";
import { config } from "../../config";

// ── Mocks ────

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

// Keep the unit suite hermetic: featureDetection (via utils/redis) would
// otherwise construct a real Redis client at import time.
jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null) },
}));

jest.mock("../../services/featureDetection", () => ({
    featureDetection: { getFeatures: jest.fn().mockResolvedValue({ fpcalc: true }) },
}));

// Pass the request straight through: the real limiter's circuit breaker
// trips on the burst a full suite generates and would reject later lookups.
jest.mock("../../services/rateLimiter", () => ({
    rateLimiter: {
        execute: (_key: string, fn: () => unknown) => fn(),
    },
}));

// The service lazily imports this; the mock stands in for the encrypted SystemSettings row.
const mockGetSystemSettings = jest.fn().mockResolvedValue(null);
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
    invalidateSystemSettingsCache: jest.fn(),
}));

/**
 * The service builds its own axios instance in the constructor; tests inject
 * a mock client directly (same pattern as audiobookshelf.test.ts).
 */
function setupClient() {
    const post = jest.fn();
    (acoustidService as any).client = { post };
    return post;
}

const RECORDING = "8f6a1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b";
const ARTIST = "11111111-1111-1111-1111-111111111111";
const RG = "0e5df449-0e51-4f4f-9a33-6a17e7c6b717";

/** Live wire shape: results carry recordings; recordings carry the metadata and the length (results carry none). */
function lookupResponse(results: unknown[]) {
    return { data: { status: "ok", results } };
}

function recordingResult(overrides: Record<string, unknown> = {}, recording: Record<string, unknown> = {}) {
    return {
        id: RECORDING,
        score: 0.92,
        recordings: [
            {
                id: RECORDING,
                title: "Song",
                duration: 200,
                artists: [{ id: ARTIST, name: "Artist" }],
                releasegroups: [{ id: RG, title: "Album" }],
                ...recording,
            },
        ],
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetSystemSettings.mockResolvedValue(null);
});

describe("acoustidService.lookup", () => {
    it("answers a confident match with the full result shape", async () => {
        setupClient().mockResolvedValue(lookupResponse([recordingResult()]));
        const res = await acoustidService.lookup(200, "aqA_ fingerprint");
        expect(res.kind).toBe("answered");
        if (res.kind === "answered") {
            expect(res.value).toEqual({
                recordingMbid: RECORDING,
                artistMbid: ARTIST,
                releaseGroups: [{ id: RG, title: "Album" }],
                candidates: [RECORDING],
                // No title was given to compare, so only the length agreed.
                titleAgrees: false,
                title: "Song",
            });
            expect(res.evidence).toMatchObject({ score: 0.92 });
        }
    });

    it("skips results below the 0.5 score floor and takes the next that qualifies", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([
                recordingResult({ id: "weak", score: 0.4 }),
                recordingResult({ score: 0.7 }),
            ]),
        );
        const res = await acoustidService.lookup(200, "fp");
        if (res.kind === "answered") {
            expect(res.value.releaseGroups).toEqual([{ id: RG, title: "Album" }]);
        } else {
            throw new Error(`expected answered, got ${res.kind}`);
        }
    });

    it("answers absent when no recording has the track's length", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([recordingResult({ score: 1.0 }, { duration: 60 })]),
        );
        // The source answered, and its answer is "nothing of this length".
        expect((await acoustidService.lookup(200, "fp")).kind).toBe("absent");
    });

    it("answers a short track with a recording of its own length", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([recordingResult({ score: 0.98 }, { duration: 22.0 })]),
        );
        expect((await acoustidService.lookup(22, "fp")).kind).toBe("answered");
    });

    it("picks the recording of the track's length, not the first one listed", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([{
                id: "cluster",
                score: 0.95,
                recordings: [
                    { id: "day-6", title: "Day 6", duration: 586 },
                    { id: "day-2", title: "Day 2", duration: 515.8 },
                ],
            }]),
        );
        const res = await acoustidService.lookup(515, "fp");
        expect(res.kind === "answered" && res.value.recordingMbid).toBe("day-2");
    });

    it("among recordings of the right length, takes the one with the track's title and version", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([{
                id: "cluster",
                score: 0.95,
                recordings: [
                    { id: "live", title: "Song (Live)", duration: 200 },
                    { id: "studio", title: "Song", duration: 201 },
                ],
            }]),
        );
        const res = await acoustidService.lookup(200, "fp", { title: "Song" });
        expect(res.kind === "answered" && res.value.recordingMbid).toBe("studio");
    });

    it("skips a bare result with no recordings array (fingerprint-only match)", async () => {
        setupClient().mockResolvedValue(
            lookupResponse([{ id: RECORDING, score: 0.99 }]),
        );
        expect((await acoustidService.lookup(200, "fp")).kind).toBe("absent");
    });

    it("answers transient on network error (never throws, never looks like 'no data')", async () => {
        setupClient().mockRejectedValue(new Error("ECONNREFUSED"));
        const res = await acoustidService.lookup(200, "fp");
        expect(res.kind).toBe("transient");
        if (res.kind === "transient") {
            expect(res.error.message).toContain("ECONNREFUSED");
        }
    });

    it("answers transient when the API reports failure status", async () => {
        setupClient().mockResolvedValue({
            data: {
                status: "error",
                error: { message: "rate limit exceeded" },
            },
        });
        const res = await acoustidService.lookup(200, "fp");
        expect(res.kind).toBe("transient");
        if (res.kind === "transient") {
            expect(res.error.code).toBe("BAD_RESPONSE");
        }
    });

    it("answers absent when there are no results", async () => {
        setupClient().mockResolvedValue(lookupResponse([]));
        expect((await acoustidService.lookup(200, "fp")).kind).toBe("absent");
    });

    it("short-circuits to permanent on empty fingerprint or bad duration without any HTTP call", async () => {
        expect((await acoustidService.lookup(200, "")).kind).toBe("permanent");
        expect((await acoustidService.lookup(0, "fp")).kind).toBe("permanent");
        expect((await acoustidService.lookup(NaN, "fp")).kind).toBe("permanent");
        expect(setupClient()).not.toHaveBeenCalled();
    });

    it("sends the live-verified request shape: form-encoded, duration param, %20 meta", async () => {
        const post = setupClient();
        post.mockResolvedValue(lookupResponse([]));
        await acoustidService.lookup(123, "fp123");

        expect(post).toHaveBeenCalledTimes(1);
        const [url, body, config] = post.mock.calls[0];
        expect(url).toBe("/v2/lookup");
        expect(typeof body).toBe("string");
        expect(body).toContain("duration=123");
        expect(body).not.toContain("track=");
        expect(body).toContain("fingerprint=fp123");
        expect(body).toContain("meta=recordings%20releasegroups");
        expect(body).not.toContain("recordings%2Breleasegroups");
        expect(body).toContain("client=");
        expect(config.headers["Content-Type"]).toBe(
            "application/x-www-form-urlencoded",
        );
    });
});

describe("acoustidService key precedence", () => {
    it("sends the operator's SystemSettings key when one is stored", async () => {
        const post = setupClient();
        post.mockResolvedValue(lookupResponse([]));
        mockGetSystemSettings.mockResolvedValue({ acoustidApiKey: "operator-key" });

        await acoustidService.lookup(200, "fp");

        // The mock must be consulted: proves the service actually reads the
        // settings row (a service that ignored settings would still pass on
        // the baked config default alone).
        expect(mockGetSystemSettings).toHaveBeenCalled();
        expect(post.mock.calls[0][1]).toContain("client=operator-key");
    });

    it("falls back to the baked config default when settings hold nothing", async () => {
        const post = setupClient();
        post.mockResolvedValue(lookupResponse([]));
        mockGetSystemSettings.mockResolvedValue(null);

        await acoustidService.lookup(200, "fp");

        expect(post.mock.calls[0][1]).toContain(
            `client=${config.acoustid.clientKey}`
        );
    });

    it("falls back to the config default when the settings read throws (never propagates)", async () => {
        const post = setupClient();
        post.mockResolvedValue(lookupResponse([]));
        mockGetSystemSettings.mockRejectedValue(new Error("db gone"));

        // Empty results -> absent, but the point is it must not THROW.
        expect((await acoustidService.lookup(200, "fp")).kind).toBe("absent");
        expect(post.mock.calls[0][1]).toContain(
            `client=${config.acoustid.clientKey}`
        );
    });
});
