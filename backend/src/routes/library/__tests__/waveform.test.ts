/**
 * Waveform route tests -- peak math (computeWaveformPeaks) and route contract. Real router, database and Redis;
 * only ffmpeg is stood in for, so no audio file is needed.
 */

/* Mocks are hoisted above the imports. waveform.ts clears its `inFlight` map
 * in a `finally`, so nothing leaks between tests. */

// -- child_process (spawn): the ffmpeg run --
jest.mock("child_process", () => ({
    ...jest.requireActual("child_process"),
    spawn: jest.fn(),
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
import { computeWaveformPeaks, PEAK_COUNT } from "../waveform";
import { expectLog } from "../../../__tests__/helpers/expectedLogs";

const P = "wavef";

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

/** Reference peaks computed straight from the samples, used as the exact expected output. */
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

/** A fake ffmpeg process: stdout emits `dataChunks`, then 'close' with `exitCode`. */
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

        makeFakeProcess([pcm]);

        const peaks = await computeWaveformPeaks("/music/test.mp3");
        expect(peaks).toHaveLength(PEAK_COUNT);
    });

    it("all values are within [0.0, 1.0]", async () => {
        const samples = Array.from({ length: 4000 }, () => 32767);
        const pcm = makePcm(samples);

        makeFakeProcess([pcm]);

        const peaks = await computeWaveformPeaks("/music/test.mp3");
        for (const v of peaks) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
    });

    it("all-zero PCM yields all-zero peaks", async () => {
        const samples = Array.from({ length: 4000 }, () => 0);
        const pcm = makePcm(samples);

        makeFakeProcess([pcm]);

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

        makeFakeProcess([pcm]);

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

        makeFakeProcess([pcm]);

        const peaks = await computeWaveformPeaks("/music/test.mp3");
        expect(peaks).toHaveLength(PEAK_COUNT);
    });

    it("carry byte across chunk boundaries yields identical peaks to whole-buffer", async () => {
        // Values vary per mini-block so a shifted straddling sample changes the result.
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
        makeFakeProcess([], 1);

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
    let modified: Date;

    /** The cache entry the route reads and writes for a seeded track (its key embeds the stored mtime). */
    const cacheKey = (id: string) => `waveform:${id}:${modified.getTime()}`;

    async function cleanup() {
        await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
        await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
        await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    }

    async function seedTrack(id: string, filePath: string) {
        await prisma.track.create({
            data: { id: `${P}_${id}`, albumId: `${P}_alb`, title: `${P} ${id}`, trackNo: 1, duration: 100, filePath, fileModified: modified, fileSize: 10 },
        });
        await redisClient.del(cacheKey(`${P}_${id}`));
        return `${P}_${id}`;
    }

    beforeAll(async () => {
        await cleanup();
        // Whole seconds, so the column's millisecond precision cannot change the cache key built from what it hands back.
        modified = new Date(Math.floor(Date.now() / 1000) * 1000);
        await prisma.artist.create({ data: { id: `${P}_art`, name: `${P} artist`, identityKey: `${P}_ik` } });
        await prisma.album.create({
            data: { id: `${P}_alb`, rgMbid: `${P}_rg`, artistId: `${P}_art`, title: `${P} album`, primaryType: "Album", location: "LIBRARY" },
        });
        app = makeApp();
    });

    afterAll(async () => {
        const rows = await prisma.track.findMany({ where: { id: { startsWith: P } }, select: { id: true } });
        await Promise.all(rows.map((r) => redisClient.del(cacheKey(r.id))));
        await cleanup();
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns 404 when track not found", async () => {
        const res = await request(app).get("/api/library/tracks/unknown-id/waveform");
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Track not found");
    });

    it("returns 404 when the stored path leaves the music folder", async () => {
        expectLog("warn");
        // The schema keeps filePath and fileModified non-null, so a path that climbs out is how a
        // song's audio is "unavailable" here.
        const id = await seedTrack("escape", "../../etc/passwd");

        const res = await request(app).get(`/api/library/tracks/${id}/waveform`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Track audio file unavailable");
        expect(spawn).not.toHaveBeenCalled();
    });

    it("returns 200 with { peaks: number[], count: 400 } on success", async () => {
        const id = await seedTrack("ok", "Artist/Album/ok.mp3");

        // A simple PCM buffer (4000 samples = 40 mini-blocks).
        const samples = Array.from({ length: 4000 }, () => 32767);
        makeFakeProcess([makePcm(samples)]);

        const res = await request(app).get(`/api/library/tracks/${id}/waveform`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("peaks");
        expect(res.body).toHaveProperty("count");
        expect(res.body.peaks).toHaveLength(PEAK_COUNT);
        expect(res.body.count).toBe(PEAK_COUNT);
        // Verify the Cache-Control header is set.
        expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    });

    it("Redis cache-HIT returns cached payload without spawning ffmpeg", async () => {
        const id = await seedTrack("hit", "Artist/Album/hit.mp3");
        const cachedPayload = {
            peaks: Array.from({ length: PEAK_COUNT }, (_, i) =>
                Math.round((i / PEAK_COUNT) * 10000) / 10000,
            ),
            count: PEAK_COUNT,
        };
        await redisClient.setex(cacheKey(id), 60, JSON.stringify(cachedPayload));

        const res = await request(app).get(`/api/library/tracks/${id}/waveform`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual(cachedPayload);

        // Verify that spawn was NOT called (cache hit path).
        expect(spawn).not.toHaveBeenCalled();
    });

    it("Redis cache-MISS computes and caches peaks", async () => {
        const id = await seedTrack("miss", "Artist/Album/miss.mp3");
        const samples = Array.from({ length: 4000 }, () => 32767);
        makeFakeProcess([makePcm(samples)]);

        const res = await request(app).get(`/api/library/tracks/${id}/waveform`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("peaks");
        expect(res.body).toHaveProperty("count");

        // The entry written on a miss is the payload that was served.
        const stored = await redisClient.get(cacheKey(id));
        expect(JSON.parse(stored!)).toEqual(res.body);
    });

    it("returns 500 on ffmpeg failure", async () => {
        expectLog("error");
        const id = await seedTrack("fail", "Artist/Album/fail.mp3");

        // A fake process that exits with an error.
        makeFakeProcess([], 1);

        const res = await request(app).get(`/api/library/tracks/${id}/waveform`);
        expect(res.status).toBe(500);
        expect(res.body.error).toBe("Failed to compute waveform");
        // Nothing is cached for a failed run.
        expect(await redisClient.get(cacheKey(id))).toBeNull();
    });
});
