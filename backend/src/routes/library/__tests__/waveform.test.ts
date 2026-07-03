/**
 * Waveform route tests -- peak math (computeWaveformPeaks) and route contract.
 */

/* ---------------------------------------------------------------------------
 * Mocks — order matters because they are hoisted above the imports below.
 * (waveform.ts's module-level `inFlight` map self-clears in a `finally` block
 * after each computation completes, so there is no cross-test leak — and no
 * beforeEach reset of it is possible, since it isn't exported.)
 * --------------------------------------------------------------------------- */

// -- child_process (spawn) --
jest.mock("child_process", () => ({
    spawn: jest.fn(),
}));

// -- redis --
jest.mock("../../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setex: jest.fn(),
    },
}));

// -- prisma --
jest.mock("../../../utils/db", () => ({
    prisma: {
        track: {
            findUnique: jest.fn(),
        },
    },
}));

// -- logger --
jest.mock("../../../utils/logger", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

// -- config --
jest.mock("../../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
        },
    },
}));

/* ---------------------------------------------------------------------------
 * Imports (after all mocks are hoisted above).
 * --------------------------------------------------------------------------- */

import express from "express";
import request from "supertest";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { prisma } from "../../../utils/db";
import { redisClient } from "../../../utils/redis";
import { logger } from "../../../utils/logger";
import { computeWaveformPeaks, PEAK_COUNT } from "../waveform";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a synthetic s16le PCM buffer of the given length (in samples).
 * Each sample is written as a 16-bit little-endian signed integer.
 */
function makePcm(samples: number[], byteOffset = 0): Buffer {
    const buf = Buffer.alloc(samples.length * 2 + byteOffset);
    for (let i = 0; i < samples.length; i++) {
        const val = Math.round(samples[i]);
        // Clamp to int16 range
        const clamped = Math.max(-32768, Math.min(32767, val));
        buf.writeInt16LE(clamped, byteOffset + i * 2);
    }
    return buf;
}

/**
 * Independent reference implementation of the peak algorithm, computed directly
 * from the sample array (no PCM streaming / carry logic). Used as an ORACLE:
 * any mutation of computeWaveformPeaks's mini-block aggregation, bucket
 * boundary (ceil/floor), or normalisation makes its output diverge from this,
 * so an exact `toEqual` assertion catches it — unlike shape-only checks.
 */
function expectedPeaks(samples: number[]): number[] {
    const MINI_BLOCK = 100;
    const miniBlocks: number[] = [];
    for (let i = 0; i < samples.length; i += MINI_BLOCK) {
        let m = 0;
        for (let j = i; j < Math.min(i + MINI_BLOCK, samples.length); j++) {
            m = Math.max(m, Math.abs(samples[j]));
        }
        miniBlocks.push(m);
    }
    const K = miniBlocks.length;
    if (K === 0) return new Array(PEAK_COUNT).fill(0);
    let globalMax = 0;
    for (const v of miniBlocks) globalMax = Math.max(globalMax, v);
    if (globalMax === 0) globalMax = 1;
    const peaks = new Array(PEAK_COUNT).fill(0);
    for (let p = 0; p < PEAK_COUNT; p++) {
        const lo = Math.floor((p * K) / PEAK_COUNT);
        const hi = Math.ceil(((p + 1) * K) / PEAK_COUNT);
        let bucketMax = 0;
        for (let b = lo; b < hi && b < K; b++) {
            bucketMax = Math.max(bucketMax, miniBlocks[b]);
        }
        peaks[p] = Math.round((bucketMax / globalMax) * 10000) / 10000;
    }
    return peaks;
}

/**
 * Create a fake process whose stdout emits data chunks and then emits
 * 'close' with the given exit code.  This mirrors what the real ffmpeg
 * process does.
 *
 * The fake process object has `stdout` and `stderr` properties (EventEmitters)
 * so that the handler's `ff.stdout.on(...)` and `ff.stderr.on(...)` calls
 * work correctly.
 *
 * @param dataChunks  Buffers emitted via stdout 'data' events.
 * @param exitCode    The code passed to the 'close' event.
 */
function makeFakeProcess(
    dataChunks: Buffer[],
    exitCode = 0,
): {
    process: EventEmitter;
    stdout: EventEmitter;
    stderr: EventEmitter;
} {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const fakeProcess = new EventEmitter();

    // Attach stdout/stderr to the fake process so the handler can access them.
    (fakeProcess as any).stdout = stdout;
    (fakeProcess as any).stderr = stderr;

    (spawn as jest.Mock).mockImplementation(() => {
        // Simulate async data emission, then close.
        setImmediate(() => {
            for (const chunk of dataChunks) {
                stdout.emit("data", chunk);
            }
        });
        setImmediate(() => {
            fakeProcess.emit("close", exitCode);
        });
        return fakeProcess;
    });

    return { process: fakeProcess, stdout, stderr };
}

/**
 * Build an Express app that exposes the waveform router.
 * The route handler reads req.user?.id, so we inject a synthetic user.
 */
function makeApp(): express.Application {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
        req.user = { id: "user-123" };
        next();
    });
    // Import the default export (router) from waveform.ts
    const waveformRouter = require("../waveform").default;
    app.use("/api/library", waveformRouter);
    return app;
}

// ---------------------------------------------------------------------------
// Peak math tests (computeWaveformPeaks)
// ---------------------------------------------------------------------------

describe("computeWaveformPeaks", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns exactly 400 buckets", async () => {
        // 4000 samples = 40 mini-blocks of 100 samples each.
        const samples = Array.from({ length: 4000 }, () => 32767);
        const pcm = makePcm(samples);

        const { stdout: fakeStdout, process: fakeProc } = makeFakeProcess([pcm]);

        const peaks = await computeWaveformPeaks("/music/test.mp3");
        expect(peaks).toHaveLength(PEAK_COUNT);
    });

    it("all values are within [0.0, 1.0]", async () => {
        const samples = Array.from({ length: 4000 }, () => 32767);
        const pcm = makePcm(samples);

        const { stdout: fakeStdout, process: fakeProc } = makeFakeProcess([pcm]);

        const peaks = await computeWaveformPeaks("/music/test.mp3");
        for (const v of peaks) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
    });

    it("all-zero PCM yields all-zero peaks", async () => {
        const samples = Array.from({ length: 4000 }, () => 0);
        const pcm = makePcm(samples);

        const { stdout: fakeStdout, process: fakeProc } = makeFakeProcess([pcm]);

        const peaks = await computeWaveformPeaks("/music/test.mp3");
        for (const v of peaks) {
            expect(v).toBe(0);
        }
    });

    it("K < 400 redistributes peaks correctly", async () => {
        // 1000 samples = 10 mini-blocks (K=10), which should be redistributed
        // into 400 buckets.  Each output peak takes the max of the mini-blocks
        // that fall within its proportional slice.
        const samples = Array.from({ length: 1000 }, (_, i) =>
            i < 500 ? 32767 : 0,
        );
        const pcm = makePcm(samples);

        const { stdout: fakeStdout, process: fakeProc } = makeFakeProcess([pcm]);

        const peaks = await computeWaveformPeaks("/music/test.mp3");
        expect(peaks).toHaveLength(PEAK_COUNT);

        // Exact-value check against the reference oracle — catches redistribution,
        // aggregation and boundary mutations, not just shape.
        expect(peaks).toEqual(expectedPeaks(samples));
    });

    it("K > 400 redistributes peaks correctly (real K>400, exact values)", async () => {
        // 60,000 samples = 600 mini-blocks (K=600 > 400), so each output bucket
        // AGGREGATES ~1.5 mini-blocks — both the max-aggregation loop and the
        // ceil boundary matter. Values vary per mini-block so a naive single-index
        // lookup, or a floor/ceil swap on the boundary, changes the result.
        const samples = Array.from({ length: 60000 }, (_, i) => {
            const block = Math.floor(i / 100);
            return (block * 6151) % 32768; // deterministic, varies per mini-block
        });
        const pcm = makePcm(samples);

        makeFakeProcess([pcm]);

        const peaks = await computeWaveformPeaks("/music/test.mp3");
        expect(peaks).toHaveLength(PEAK_COUNT);
        // Exact values vs the oracle (this is the branch shape-only tests missed).
        expect(peaks).toEqual(expectedPeaks(samples));
        // Sanity: real variation reached (fractional peaks exist, not all 0/1).
        expect(peaks.some((v) => v > 0 && v < 1)).toBe(true);
    });

    it("handles partial mini-block at EOF", async () => {
        // 1050 samples = 10 full mini-blocks + 50 leftover samples.
        // The leftover should be flushed as a partial mini-block.
        const samples = Array.from({ length: 1050 }, (_, i) =>
            i < 500 ? 32767 : 0,
        );
        const pcm = makePcm(samples);

        const { stdout: fakeStdout, process: fakeProc } = makeFakeProcess([pcm]);

        const peaks = await computeWaveformPeaks("/music/test.mp3");
        expect(peaks).toHaveLength(PEAK_COUNT);
    });

    it("carry byte across chunk boundaries yields identical peaks to whole-buffer", async () => {
        // Values vary per mini-block so a corrupted/shifted straddling sample
        // changes the result (a constant signal would hide the bug).
        const samples = Array.from({ length: 4000 }, (_, i) =>
            (Math.floor(i / 100) * 6151) % 32768,
        );
        const pcm = makePcm(samples);

        // Whole buffer in one chunk.
        makeFakeProcess([pcm]);
        const whole = await computeWaveformPeaks("/music/test.mp3");

        // Same bytes split at an ODD offset (3 bytes = 1.5 samples), so a sample
        // straddles the chunk boundary and the carry-byte stitching must fire.
        makeFakeProcess([pcm.subarray(0, 3), pcm.subarray(3)]);
        const split = await computeWaveformPeaks("/music/test.mp3");

        // Deleting the carry-byte stitching corrupts the straddling sample and
        // shifts every sample after it — these would then diverge.
        expect(split).toEqual(whole);
        expect(whole).toEqual(expectedPeaks(samples));
    });

    it("rejects when ffmpeg exits with non-zero code and no data", async () => {
        const { process: fakeProc } = makeFakeProcess([], 1);

        await expect(computeWaveformPeaks("/music/nonexistent.mp3")).rejects.toThrow(
            "ffmpeg exited 1",
        );
    });
});

// ---------------------------------------------------------------------------
// Route tests (GET /tracks/:id/waveform)
// ---------------------------------------------------------------------------

describe("GET /tracks/:id/waveform", () => {
    let app: express.Application;

    beforeEach(() => {
        jest.clearAllMocks();
        app = makeApp();
    });

    it("returns 404 when track not found", async () => {
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get("/api/library/tracks/unknown-id/waveform");
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Track not found");
    });

    it("returns 404 when track.filePath is null", async () => {
        (prisma.track.findUnique as jest.Mock).mockResolvedValue({
            id: "track-1",
            filePath: null,
            fileModified: new Date(),
        });

        const res = await request(app).get("/api/library/tracks/track-1/waveform");
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Track audio file unavailable");
    });

    it("returns 404 when track.fileModified is null", async () => {
        (prisma.track.findUnique as jest.Mock).mockResolvedValue({
            id: "track-1",
            filePath: "Artist/Album/track.mp3",
            fileModified: null,
        });

        const res = await request(app).get("/api/library/tracks/track-1/waveform");
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Track audio file unavailable");
    });

    it("returns 200 with { peaks: number[], count: 400 } on success", async () => {
        const track = {
            id: "track-1",
            filePath: "Artist/Album/track.mp3",
            fileModified: new Date(),
        };
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(track);

        // Mock redis to return null (no cache hit), so we need to compute.
        (redisClient.get as jest.Mock).mockResolvedValue(null);

        // Create a simple PCM buffer (4000 samples = 40 mini-blocks).
        const samples = Array.from({ length: 4000 }, () => 32767);
        const pcm = makePcm(samples);

        const { stdout: fakeStdout, process: fakeProc } = makeFakeProcess([pcm]);

        const res = await request(app).get("/api/library/tracks/track-1/waveform");
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("peaks");
        expect(res.body).toHaveProperty("count");
        expect(res.body.peaks).toHaveLength(PEAK_COUNT);
        expect(res.body.count).toBe(PEAK_COUNT);
        // Verify the Cache-Control header is set.
        expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    });

    it("Redis cache-HIT returns cached payload without spawning ffmpeg", async () => {
        const cachedPayload = {
            peaks: Array.from({ length: PEAK_COUNT }, (_, i) =>
                Math.round((i / PEAK_COUNT) * 10000) / 10000,
            ),
            count: PEAK_COUNT,
        };
        const track = {
            id: "track-1",
            filePath: "Artist/Album/track.mp3",
            fileModified: new Date(),
        };
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(track);

        // Mock redis to return a cached payload.
        (redisClient.get as jest.Mock).mockResolvedValue(
            JSON.stringify(cachedPayload),
        );

        const res = await request(app).get("/api/library/tracks/track-1/waveform");
        expect(res.status).toBe(200);
        expect(res.body).toEqual(cachedPayload);

        // Verify that spawn was NOT called (cache hit path).
        expect(spawn).not.toHaveBeenCalled();

        // Verify redisClient.setex was NOT called (no write on cache hit).
        expect(redisClient.setex).not.toHaveBeenCalled();
    });

    it("Redis cache-MISS computes and caches peaks", async () => {
        const track = {
            id: "track-1",
            filePath: "Artist/Album/track.mp3",
            fileModified: new Date(),
        };
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(track);

        // Mock redis to return null (no cache hit).
        (redisClient.get as jest.Mock).mockResolvedValue(null);

        // Create a simple PCM buffer.
        const samples = Array.from({ length: 4000 }, () => 32767);
        const pcm = makePcm(samples);

        const { stdout: fakeStdout, process: fakeProc } = makeFakeProcess([pcm]);

        const res = await request(app).get("/api/library/tracks/track-1/waveform");
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("peaks");
        expect(res.body).toHaveProperty("count");

        // Verify redisClient.setex was called (cache write on miss).
        expect(redisClient.setex).toHaveBeenCalled();
    });

    it("returns 500 on ffmpeg failure", async () => {
        const track = {
            id: "track-1",
            filePath: "Artist/Album/track.mp3",
            fileModified: new Date(),
        };
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(track);

        // Mock redis to return null (no cache hit).
        (redisClient.get as jest.Mock).mockResolvedValue(null);

        // Create a fake process that exits with an error.
        const { process: fakeProc } = makeFakeProcess([], 1);

        const res = await request(app).get("/api/library/tracks/track-1/waveform");
        expect(res.status).toBe(500);
        expect(res.body.error).toBe("Failed to compute waveform");
    });
});
