import { Router } from "express";
import { spawn } from "child_process";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { config } from "../../config";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { resolveTrackFilePath } from "./trackPath";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of amplitude buckets returned to the client. */
export const PEAK_COUNT = 400;

/**
 * Sample rate for the PCM decode pass.  4 kHz mono is more than enough for
 * waveform visualisation and keeps the data volume small (~1.8 MB for a 1-hour
 * track vs ~34 MB at 44.1 kHz).
 */
const SAMPLE_RATE = 4000;

/**
 * Mini-block size (samples).  We accumulate max-abs over blocks of this size
 * while streaming PCM, then redistribute into PEAK_COUNT buckets at the end.
 * 100 samples @ 4 kHz = 25 ms per mini-block — fine resolution before downsampling.
 */
const MINI_BLOCK = 100;

/** Redis TTL for cached waveform data (30 days).  Waveform is stable as long
 *  as the file hasn't changed; the cache key embeds the file-modified timestamp
 *  so a re-encoded file automatically busts the entry. */
const CACHE_TTL_S = 30 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WaveformPayload {
    peaks: number[];
    count: number;
}

// ---------------------------------------------------------------------------
// In-flight dedup map
// ---------------------------------------------------------------------------
// Concurrent requests for the same (trackId, mtime) pair share a single
// ffmpeg spawn so we never compute the same waveform twice in parallel.

const inFlight = new Map<string, Promise<WaveformPayload>>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redisCacheKey(trackId: string, mtime: Date): string {
    return `waveform:${trackId}:${mtime.getTime()}`;
}

function inFlightKey(trackId: string, mtime: Date): string {
    return `${trackId}:${mtime.getTime()}`;
}

/**
 * Spawn ffmpeg, decode the audio file to raw 4 kHz mono s16le PCM, and
 * return PEAK_COUNT normalised amplitude values (0.0–1.0, max-abs per bucket).
 *
 * The implementation is streaming: only the per-block maximums (one number per
 * MINI_BLOCK samples) are kept in memory, not the raw PCM.
 */
export function computeWaveformPeaks(filePath: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
        const ff = spawn(ffmpegPath.path, [
            "-hide_banner",
            "-loglevel", "error",
            "-i", filePath,
            "-ac", "1",
            "-ar", String(SAMPLE_RATE),
            "-f", "s16le",
            "pipe:1",
        ]);

        const miniBlocks: number[] = [];
        let carry: number | null = null; // leftover byte (low byte of a straddling sample)
        let blockMax = 0;
        let blockSamples = 0;

        ff.stdout.on("data", (chunk: Buffer) => {
            let start = 0;

            // Stitch the carry byte from the previous chunk into a full sample.
            if (carry !== null) {
                if (chunk.length === 0) return;
                const sample = Buffer.from([carry, chunk[0]]).readInt16LE(0);
                const abs = Math.abs(sample);
                if (abs > blockMax) blockMax = abs;
                blockSamples++;
                if (blockSamples >= MINI_BLOCK) {
                    miniBlocks.push(blockMax);
                    blockMax = 0;
                    blockSamples = 0;
                }
                carry = null;
                start = 1;
            }

            // Process complete 2-byte samples.
            const fullSamples = Math.floor((chunk.length - start) / 2);
            for (let i = 0; i < fullSamples; i++) {
                const abs = Math.abs(chunk.readInt16LE(start + i * 2));
                if (abs > blockMax) blockMax = abs;
                blockSamples++;
                if (blockSamples >= MINI_BLOCK) {
                    miniBlocks.push(blockMax);
                    blockMax = 0;
                    blockSamples = 0;
                }
            }

            // If there's a leftover byte at the end of the chunk, carry it forward.
            const consumed = start + fullSamples * 2;
            if (consumed < chunk.length) {
                carry = chunk[consumed];
            }
        });

        const stderrBuf: string[] = [];
        ff.stderr.on("data", (d: Buffer) => stderrBuf.push(d.toString()));

        ff.on("close", (code) => {
            // Flush any partial mini-block at EOF.
            if (blockSamples > 0) {
                miniBlocks.push(blockMax);
            }

            if (code !== 0 && miniBlocks.length === 0) {
                return reject(
                    new Error(
                        `ffmpeg exited ${code}: ${stderrBuf.join("").slice(0, 300)}`,
                    ),
                );
            }

            const K = miniBlocks.length;
            if (K === 0) {
                return resolve(new Array(PEAK_COUNT).fill(0));
            }

            // Dynamic normalisation: the loudest mini-block = 1.0.
            // This ensures quiet tracks still show a full-height waveform,
            // which is what the player scrubber needs.
            let globalMax = 0;
            for (const v of miniBlocks) {
                if (v > globalMax) globalMax = v;
            }
            if (globalMax === 0) globalMax = 1;

            // Redistribute K mini-blocks into exactly PEAK_COUNT buckets.
            // Each output peak takes the max-abs of the mini-blocks that fall
            // within its proportional slice.
            const peaks: number[] = new Array(PEAK_COUNT).fill(0);
            for (let p = 0; p < PEAK_COUNT; p++) {
                const lo = Math.floor((p * K) / PEAK_COUNT);
                const hi = Math.ceil(((p + 1) * K) / PEAK_COUNT);
                let bucketMax = 0;
                for (let b = lo; b < hi && b < K; b++) {
                    if (miniBlocks[b] > bucketMax) bucketMax = miniBlocks[b];
                }
                // Round to 4 decimal places to keep JSON payload compact.
                peaks[p] = Math.round((bucketMax / globalMax) * 10000) / 10000;
            }

            resolve(peaks);
        });

        ff.on("error", reject);
    });
}

/**
 * Return cached peaks if available, otherwise compute and cache them.
 * Concurrent requests for the same track share a single computation via the
 * in-flight map.
 */
async function getOrComputeWaveform(
    trackId: string,
    absoluteFilePath: string,
    fileModified: Date,
): Promise<WaveformPayload> {
    const redisKey = redisCacheKey(trackId, fileModified);
    const flyKey = inFlightKey(trackId, fileModified);

    // 1. Redis cache hit — fast path.
    try {
        const cached = await redisClient.get(redisKey);
        if (cached) {
            logger.debug(`[WAVEFORM] Cache HIT for track ${trackId}`);
            return JSON.parse(cached) as WaveformPayload;
        }
    } catch (err) {
        logger.warn("[WAVEFORM] Redis read error (proceeding without cache):", err);
    }

    // 2. Join an already-running computation for the same (trackId, mtime).
    const existing = inFlight.get(flyKey);
    if (existing) {
        logger.debug(`[WAVEFORM] Joining in-flight computation for ${flyKey}`);
        return existing;
    }

    // 3. Start a new computation.
    const computation = (async (): Promise<WaveformPayload> => {
        try {
            logger.debug(
                `[WAVEFORM] Computing peaks for track ${trackId} (${absoluteFilePath})`,
            );
            const peaks = await computeWaveformPeaks(absoluteFilePath);
            const payload: WaveformPayload = { peaks, count: peaks.length };

            try {
                await redisClient.setex(redisKey, CACHE_TTL_S, JSON.stringify(payload));
                logger.debug(
                    `[WAVEFORM] Cached ${peaks.length} peaks for track ${trackId}`,
                );
            } catch (err) {
                logger.warn("[WAVEFORM] Redis write error (result still served):", err);
            }

            return payload;
        } finally {
            inFlight.delete(flyKey);
        }
    })();

    inFlight.set(flyKey, computation);
    return computation;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const router = Router();

/**
 * GET /api/library/tracks/:id/waveform
 *
 * Returns precomputed amplitude peaks for the track's audio file.
 * Auth is applied upstream by requireAuthOrToken in the library index.
 *
 * Response: { peaks: number[], count: number }
 *   peaks  — PEAK_COUNT (400) normalised amplitude values, 0.0–1.0, start→end
 *   count  — peaks.length (always 400 for a valid track)
 */
router.get("/tracks/:id/waveform", async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const track = await prisma.track.findUnique({
            where: { id: req.params.id },
            select: { id: true, filePath: true, fileModified: true },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        if (!track.filePath || !track.fileModified) {
            return res.status(404).json({ error: "Track audio file unavailable" });
        }

        const absolutePath = resolveTrackFilePath(track.filePath);
        if (!absolutePath) {
            logger.warn(`[WAVEFORM] Rejected out-of-root path for track ${track.id}`);
            return res.status(404).json({ error: "Track audio file unavailable" });
        }

        const payload = await getOrComputeWaveform(
            track.id,
            absolutePath,
            track.fileModified,
        );

        // Allow clients and CDNs to cache the response for a day; the
        // server-side Redis entry stays warm for 30 days.
        res.setHeader("Cache-Control", "public, max-age=86400");
        return res.json(payload);
    } catch (error) {
        logger.error("[WAVEFORM] Unhandled error:", error);
        return res.status(500).json({ error: "Failed to compute waveform" });
    }
});

export default router;
