import * as fs from "fs";
import { promises as fsPromises } from "fs";
import { Request, Response } from "express";
import { logger } from "../utils/logger";
import * as path from "path";
import * as crypto from "crypto";
import { prisma } from "../utils/db";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import PQueue from "p-queue";
import { AppError, ErrorCode, ErrorCategory } from "../utils/errors";
import { parseFile } from "music-metadata";

// Set FFmpeg path to bundled binary
ffmpeg.setFfmpegPath(ffmpegPath.path);

// Quality settings
export const QUALITY_SETTINGS = {
    original: { bitrate: null, format: null }, // No transcoding
    high: { bitrate: 320, format: "mp3" },
    medium: { bitrate: 192, format: "mp3" },
    low: { bitrate: 128, format: "mp3" },
} as const;

export type Quality = keyof typeof QUALITY_SETTINGS;

interface StreamFileInfo {
    filePath: string;
    mimeType: string;
}

export class AudioStreamingService {
    private transcodeQueue = new PQueue({ concurrency: 3 });
    private musicPath: string;
    private transcodeCachePath: string;
    private transcodeCacheMaxGb: number;
    private evictionInterval: NodeJS.Timeout | null = null;

    constructor(
        musicPath: string,
        transcodeCachePath: string,
        transcodeCacheMaxGb: number
    ) {
        this.musicPath = musicPath;
        this.transcodeCachePath = transcodeCachePath;
        this.transcodeCacheMaxGb = transcodeCacheMaxGb;

        // Ensure cache directory exists
        if (!fs.existsSync(this.transcodeCachePath)) {
            fs.mkdirSync(this.transcodeCachePath, { recursive: true });
        }

        // Start cache eviction timer (every 6 hours)
        this.evictionInterval = setInterval(() => {
            this.evictCache(this.transcodeCacheMaxGb).catch((err) => {
                logger.error("Cache eviction failed:", err);
            });
        }, 6 * 60 * 60 * 1000);
    }

    /**
     * Get file path for streaming (either original or transcoded)
     */
    async getStreamFilePath(
        trackId: string,
        quality: Quality,
        sourceModified: Date,
        sourceAbsolutePath: string
    ): Promise<StreamFileInfo> {
        logger.debug(`[AudioStreaming] Request: trackId=${trackId}, quality=${quality}, source=${path.basename(sourceAbsolutePath)}`);
        
        // If original quality requested, return source file
        if (quality === "original") {
            const mimeType = this.getMimeType(sourceAbsolutePath);
            logger.debug(`[AudioStreaming] Serving original: mimeType=${mimeType}`);
            return {
                filePath: sourceAbsolutePath,
                mimeType,
            };
        }

        // Check if we have a valid cached transcode
        const cachedPath = await this.getCachedTranscode(
            trackId,
            quality,
            sourceModified
        );

        if (cachedPath) {
            logger.debug(
                `[STREAM] Using cached transcode: ${quality} (${cachedPath})`
            );
            return {
                filePath: cachedPath,
                mimeType: "audio/mpeg",
            };
        }

        // Check source file bitrate to avoid pointless upsampling
        const targetBitrate = QUALITY_SETTINGS[quality].bitrate;
        if (targetBitrate) {
            try {
                const metadata = await parseFile(sourceAbsolutePath);
                const sourceBitrate = metadata.format.bitrate
                    ? Math.round(metadata.format.bitrate / 1000)
                    : null;

                if (sourceBitrate && sourceBitrate <= targetBitrate) {
                    logger.debug(
                        `[STREAM] Source bitrate (${sourceBitrate}kbps) <= target (${targetBitrate}kbps), serving original`
                    );
                    return {
                        filePath: sourceAbsolutePath,
                        mimeType: this.getMimeType(sourceAbsolutePath),
                    };
                }
            } catch (err) {
                logger.warn(
                    `[STREAM] Failed to read source metadata, will transcode anyway:`,
                    err
                );
            }
        }

        // Need to transcode - check cache size first
        const currentSize = await this.getCacheSize();
        if (currentSize > this.transcodeCacheMaxGb * 0.9) {
            logger.debug(
                `[STREAM] Cache near full (${currentSize.toFixed(
                    2
                )}GB), evicting to 80%...`
            );
            await this.evictCache(this.transcodeCacheMaxGb * 0.8);
        }

        // Transcode to cache
        logger.debug(
            `[STREAM] Transcoding to ${quality} quality: ${sourceAbsolutePath}`
        );
        const transcodedPath = await this.transcodeToCache(
            trackId,
            quality,
            sourceAbsolutePath,
            sourceModified
        );

        return {
            filePath: transcodedPath,
            mimeType: "audio/mpeg",
        };
    }

    /**
     * Get cached transcode if it exists and is valid
     */
    private async getCachedTranscode(
        trackId: string,
        quality: Quality,
        sourceModified: Date
    ): Promise<string | null> {
        const cached = await prisma.transcodedFile.findFirst({
            where: {
                trackId,
                quality,
            },
        });

        if (!cached) return null;

        // Invalidate if source file was modified after transcode was created
        if (cached.sourceModified < sourceModified) {
            logger.debug(
                `[STREAM] Cache stale for track ${trackId}, removing...`
            );
            await prisma.transcodedFile.delete({ where: { id: cached.id } });

            // Delete file from disk
            const cachePath = path.join(
                this.transcodeCachePath,
                cached.cachePath
            );
            await fs.promises.unlink(cachePath).catch(() => {});

            return null;
        }

        // Update last accessed time
        await prisma.transcodedFile.update({
            where: { id: cached.id },
            data: { lastAccessed: new Date() },
        });

        const fullPath = path.join(this.transcodeCachePath, cached.cachePath);

        // Verify file exists
        if (!fs.existsSync(fullPath)) {
            logger.debug(`[STREAM] Cache file missing: ${fullPath}`);
            await prisma.transcodedFile.delete({ where: { id: cached.id } });
            return null;
        }

        return fullPath;
    }

    /**
     * Transcode audio file to cache
     */
    private async transcodeToCache(
        trackId: string,
        quality: Quality,
        sourcePath: string,
        sourceModified: Date
    ): Promise<string> {
        const settings = QUALITY_SETTINGS[quality];
        if (!settings.bitrate || !settings.format) {
            throw new AppError(
                ErrorCode.INVALID_CONFIG,
                ErrorCategory.FATAL,
                `Invalid quality setting: ${quality}`
            );
        }

        // Generate cache file path
        const hash = crypto
            .createHash("md5")
            .update(`${trackId}-${quality}`)
            .digest("hex");
        const cacheFileName = `${hash}.${settings.format}`;
        const cachePath = path.join(this.transcodeCachePath, cacheFileName);

        return new Promise((resolve, reject) => {
            try {
                ffmpeg(sourcePath)
                    .audioBitrate(settings.bitrate)
                    .audioCodec("libmp3lame")
                    .format(settings.format)
                    .on("error", (err) => {
                        // Check if error is due to missing FFmpeg
                        const errorMsg = err.message.toLowerCase();
                        if (
                            errorMsg.includes("ffmpeg") &&
                            errorMsg.includes("not found")
                        ) {
                            reject(
                                new AppError(
                                    ErrorCode.FFMPEG_NOT_FOUND,
                                    ErrorCategory.FATAL,
                                    "FFmpeg not installed. Please install FFmpeg to enable transcoding.",
                                    { trackId, quality }
                                )
                            );
                        } else {
                            reject(
                                new AppError(
                                    ErrorCode.TRANSCODE_FAILED,
                                    ErrorCategory.RECOVERABLE,
                                    `Transcoding failed: ${err.message}`,
                                    { trackId, quality, source: sourcePath }
                                )
                            );
                        }
                    })
                    .on("end", async () => {
                        try {
                            // Get file size
                            const stats = await fs.promises.stat(cachePath);

                            // Save to database
                            await prisma.transcodedFile.create({
                                data: {
                                    trackId,
                                    quality,
                                    cachePath: cacheFileName,
                                    cacheSize: stats.size,
                                    sourceModified,
                                    lastAccessed: new Date(),
                                },
                            });

                            logger.debug(
                                `[STREAM] Transcode complete: ${cacheFileName} (${(
                                    stats.size /
                                    1024 /
                                    1024
                                ).toFixed(2)}MB)`
                            );
                            resolve(cachePath);
                        } catch (err: any) {
                            reject(
                                new AppError(
                                    ErrorCode.DB_QUERY_ERROR,
                                    ErrorCategory.RECOVERABLE,
                                    `Failed to save transcode record: ${err.message}`,
                                    { trackId, quality }
                                )
                            );
                        }
                    })
                    .save(cachePath);
            } catch (err: any) {
                reject(
                    new AppError(
                        ErrorCode.FFMPEG_NOT_FOUND,
                        ErrorCategory.FATAL,
                        "FFmpeg not available. Please install FFmpeg to enable transcoding.",
                        { trackId, quality }
                    )
                );
            }
        });
    }

    /**
     * Get total cache size in GB
     */
    async getCacheSize(): Promise<number> {
        const cached = await prisma.transcodedFile.findMany({
            select: { cacheSize: true },
        });
        const totalBytes = cached.reduce((sum, f) => sum + f.cacheSize, 0);
        return totalBytes / (1024 * 1024 * 1024);
    }

    /**
     * Evict cache using LRU until size is below target
     */
    async evictCache(targetGb: number): Promise<void> {
        logger.debug(`[CACHE] Starting eviction, target: ${targetGb}GB`);

        let currentSize = await this.getCacheSize();
        logger.debug(`[CACHE] Current size: ${currentSize.toFixed(2)}GB`);

        if (currentSize <= targetGb) {
            logger.debug("[CACHE] Below target, no eviction needed");
            return;
        }

        // Get all cached files sorted by last accessed (oldest first)
        const cached = await prisma.transcodedFile.findMany({
            orderBy: { lastAccessed: "asc" },
        });

        let evicted = 0;
        for (const file of cached) {
            if (currentSize <= targetGb) break;

            // Delete file from disk
            const fullPath = path.join(this.transcodeCachePath, file.cachePath);
            try {
                await fs.promises.unlink(fullPath);
            } catch (err) {
                logger.warn(`[CACHE] Failed to delete ${fullPath}:`, err);
            }

            // Delete from database
            await prisma.transcodedFile.delete({ where: { id: file.id } });

            currentSize -= file.cacheSize / (1024 * 1024 * 1024);
            evicted++;
        }

        logger.debug(
            `[CACHE] Evicted ${evicted} files, new size: ${currentSize.toFixed(
                2
            )}GB`
        );
    }

    /**
     * Get MIME type from file extension
     */
    getMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
            ".mp3": "audio/mpeg",
            ".flac": "audio/flac",
            ".m4a": "audio/mp4",
            ".aac": "audio/aac",
            ".ogg": "audio/ogg",
            ".opus": "audio/opus",
            ".wav": "audio/wav",
            ".wma": "audio/x-ms-wma",
            ".ape": "audio/x-ape",
            ".wv": "audio/x-wavpack",
        };
        return mimeTypes[ext] || "audio/mpeg";
    }

    /**
     * Stream file with proper HTTP Range support (fixes Firefox FLAC issue #42/#17)
     * Manually handles Range requests to ensure compatibility with Firefox's strict
     * Content-Range header validation for large FLAC files.
     */
    async streamFileWithRangeSupport(
        req: Request,
        res: Response,
        filePath: string,
        mimeType: string
    ): Promise<void> {
        try {
            // Get file stats for size
            const stats = await fsPromises.stat(filePath);
            const fileSize = stats.size;

            // Parse Range header
            const range = req.headers.range;
            let start = 0;
            let end = fileSize - 1;

            if (range) {
                // Parse bytes=START-END or bytes=START-
                const parts = range.replace(/bytes=/, "").split("-");
                start = parseInt(parts[0], 10);
                end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

                // Validate range
                if (start >= fileSize || end >= fileSize || start > end) {
                    res.status(416).set({
                        "Content-Range": `bytes */${fileSize}`,
                    });
                    res.end();
                    return;
                }
            }

            const contentLength = end - start + 1;

            // Set response headers
            const headers: Record<string, string> = {
                "Content-Type": mimeType,
                "Accept-Ranges": "bytes",
                "Cache-Control": "public, max-age=31536000",
                "Content-Length": contentLength.toString(),
            };

            // Add CORS headers from request origin
            if (req.headers.origin) {
                headers["Access-Control-Allow-Origin"] = req.headers.origin;
                headers["Access-Control-Allow-Credentials"] = "true";
            }

            // Set status and range-specific headers
            if (range) {
                res.status(206);
                headers["Content-Range"] = `bytes ${start}-${end}/${fileSize}`;
            } else {
                res.status(200);
            }

            res.set(headers);

            // Create read stream with range
            const stream = fs.createReadStream(filePath, { start, end });

            // Handle stream errors
            stream.on("error", (err) => {
                logger.error(`[AudioStreaming] Stream error for ${filePath}:`, err);
                if (!res.headersSent) {
                    res.status(500).end();
                }
            });

            // Handle cleanup on response close
            res.on("close", () => {
                stream.destroy();
            });

            // Pipe stream to response
            stream.pipe(res);
        } catch (err) {
            logger.error(`[AudioStreaming] Failed to stream ${filePath}:`, err);
            if (!res.headersSent) {
                res.status(500).end();
            }
        }
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        if (this.evictionInterval) {
            clearInterval(this.evictionInterval);
            this.evictionInterval = null;
        }
    }
}
