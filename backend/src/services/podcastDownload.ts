/** Podcast episodes downloaded in the background when played, served from the cache, kept 30 days from last play. */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { config, USER_AGENT } from "../config";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import axios from "axios";
import { parseFile } from "music-metadata";
import { guardedAxios, validateUrlForFetch } from "../utils/ssrf";
import { upstreamHeaderNumber } from "../utils/upstreamHeaders";

// Episodes downloading now, so one is never fetched twice at once.
const downloadingEpisodes = new Set<string>();

// Cache and completeness checks accept a 1% size difference: some servers and
// filesystems are inconsistent at the byte level.
const SIZE_TOLERANCE = 0.01;

const getPodcastCacheDir = (): string => {
    return path.join(config.music.transcodeCachePath, "../podcast-audio");
};

/**
 * The cached file when it is complete: not empty, with a download record whose size it matches. Otherwise the file
 * and record go and null is returned. Leaves the downloading set alone, so performDownload can call it.
 */
async function validateCachedFile(episodeId: string): Promise<string | null> {
    const cachedPath = path.join(getPodcastCacheDir(), `${episodeId}.mp3`);
    const discard = async (why: string) => {
        logger.debug(`[PODCAST-DL] ${why} for ${episodeId}, deleting the cached file`);
        await fs.unlink(cachedPath).catch(() => {});
        await prisma.podcastDownload.deleteMany({ where: { episodeId } });
        return null;
    };

    try {
        const { size } = await fs.stat(cachedPath);
        if (size === 0) return null;

        // The record is written once the download is complete, with the size held.
        const record = await prisma.podcastDownload.findFirst({ where: { episodeId } });
        if (!record) return discard("No download record");
        const expected = record.fileSizeMb * 1024 * 1024;
        if (expected > 0 && Math.abs(size - expected) / expected > SIZE_TOLERANCE) {
            return discard(`Size ${size} differs from the recorded ${Math.round(expected)}`);
        }

        await prisma.podcastDownload.updateMany({
            where: { episodeId },
            data: { lastAccessedAt: new Date() },
        });
        return cachedPath;
    } catch {
        // A missing or unreadable file is no cache; the caller downloads afresh.
        return null;
    }
}

/** The complete cached file, or null while it is still downloading, missing or incomplete. */
export async function getCachedFilePath(episodeId: string): Promise<string | null> {
    // Don't return cache path if still downloading - file may be incomplete
    if (downloadingEpisodes.has(episodeId)) {
        logger.debug(`[PODCAST-DL] Episode ${episodeId} is still downloading, not using cache`);
        return null;
    }

    return validateCachedFile(episodeId);
}

/** Starts the episode's download in the background, unless one is already running. */
export function downloadInBackground(
    episodeId: string,
    audioUrl: string,
    userId: string
): void {
    // Skip if already downloading
    if (downloadingEpisodes.has(episodeId)) {
        logger.debug(`[PODCAST-DL] Already downloading episode ${episodeId}, skipping`);
        return;
    }

    // Mark as downloading
    downloadingEpisodes.add(episodeId);

    // Start download in background (don't await)
    performDownload(episodeId, audioUrl, userId)
        .catch(err => {
            logger.error(`[PODCAST-DL] Background download failed for ${episodeId}:`, err.message);
        })
        .finally(() => {
            downloadingEpisodes.delete(episodeId);
        });
}

/** Downloads to a temp file, checks it against Content-Length, then moves it in and records it; three tries. */
async function performDownload(
    episodeId: string,
    audioUrl: string,
    userId: string,
    attempt: number = 1
): Promise<void> {
    const maxAttempts = 3;
    logger.debug(`[PODCAST-DL] Starting background download for episode ${episodeId} (attempt ${attempt}/${maxAttempts})`);

    const cacheDir = getPodcastCacheDir();

    // Ensure cache directory exists
    await fs.mkdir(cacheDir, { recursive: true });

    const tempPath = path.join(cacheDir, `${episodeId}.tmp`);
    const finalPath = path.join(cacheDir, `${episodeId}.mp3`);

    try {
        // Check if already cached (and validated) without toggling the downloading set
        const existingCached = await validateCachedFile(episodeId);
        if (existingCached) {
            logger.debug(`[PODCAST-DL] Episode ${episodeId} already cached, skipping download`);
            return;
        }

        // Clean up any partial temp files from previous attempts
        await fs.unlink(tempPath).catch(() => {});

        // SSRF protection
        const ssrfError = await validateUrlForFetch(audioUrl);
        if (ssrfError) {
            throw new Error(`SSRF blocked: ${ssrfError}`);
        }

        // Download the file with longer timeout for large podcasts
        const response = await axios.get(audioUrl, {
            ...guardedAxios,
            responseType: 'stream',
            timeout: 600000, // 10 minute timeout for large files (3+ hour podcasts)
            headers: {
                'User-Agent': USER_AGENT
            },
            // Don't let axios decompress - we want raw bytes
            decompress: false
        });

        // Only the host's own Content-Length can say a download is incomplete; a feed's declared enclosure length
        // can belong to another file. Nothing is awaited before the stream's handlers attach below, or a
        // connection dropped meanwhile would never be noticed.
        const expectedBytes = upstreamHeaderNumber(response.headers["content-length"]);

        logger.debug(
            `[PODCAST-DL] Downloading ${episodeId} (${Math.round(expectedBytes / 1024 / 1024)}MB)`
        );

        const writeStream = createWriteStream(tempPath);
        let bytesDownloaded = 0;
        let lastLogTime = Date.now();

        await new Promise<void>((resolve, reject) => {
            // A failed download is rejected only once the file is closed: the temp file is deleted right after,
            // and a writer still opening or flushing would put it back.
            const fail = (err: Error) => {
                response.data.destroy();
                if (writeStream.closed) reject(err);
                else {
                    writeStream.once('close', () => reject(err));
                    writeStream.destroy();
                }
            };

            response.data.on('data', (chunk: Buffer) => {
                bytesDownloaded += chunk.length;

                // Log progress every 30 seconds for long downloads
                const now = Date.now();
                if (now - lastLogTime > 30000) {
                    const percent = expectedBytes > 0 ? Math.round((bytesDownloaded / expectedBytes) * 100) : 0;
                    logger.debug(`[PODCAST-DL] Download progress ${episodeId}: ${percent}% (${Math.round(bytesDownloaded / 1024 / 1024)}MB)`);
                    lastLogTime = now;
                }
            });

            response.data.on('end', () => {
                writeStream.end(() => resolve());
            });

            response.data.pipe(writeStream, { end: false });

            writeStream.on('error', fail);
            response.data.on('error', fail);
            response.data.on('aborted', () => fail(new Error('Download aborted by server')));
        });

        // Verify file was written and is complete
        const stats = await fs.stat(tempPath);
        if (stats.size === 0) {
            await fs.unlink(tempPath).catch(() => {});
            throw new Error('Downloaded file is empty');
        }

        // Check completeness when we know an expected size (prefer Content-Length).
        if (expectedBytes > 0) {
            const variance = Math.abs(stats.size - expectedBytes) / expectedBytes;
            if (variance > SIZE_TOLERANCE) {
                const percentComplete = Math.round((stats.size / expectedBytes) * 100);
                logger.error(`[PODCAST-DL] Incomplete download for ${episodeId}: ${stats.size}/${expectedBytes} bytes (${percentComplete}%)`);
                await fs.unlink(tempPath).catch(() => {});
                throw new Error(`Download incomplete: got ${stats.size} bytes, expected ${expectedBytes}`);
            }
        }

        // Move temp file to final location; the episode's size is now the size of the copy held.
        await fs.rename(tempPath, finalPath);
        await prisma.podcastEpisode.updateMany({ where: { id: episodeId }, data: { fileSize: stats.size } });
        await recordMeasuredLength(episodeId, finalPath);

        // Record in database
        const fileSizeMb = stats.size / 1024 / 1024;

        await prisma.podcastDownload.upsert({
            where: {
                userId_episodeId: { userId, episodeId }
            },
            create: {
                userId,
                episodeId,
                localPath: finalPath,
                fileSizeMb,
                downloadedAt: new Date(),
                lastAccessedAt: new Date()
            },
            update: {
                localPath: finalPath,
                fileSizeMb,
                downloadedAt: new Date(),
                lastAccessedAt: new Date()
            }
        });

        logger.debug(`[PODCAST-DL] Successfully cached episode ${episodeId} (${fileSizeMb.toFixed(1)}MB)`);

    } catch (error: any) {
        await fs.unlink(tempPath).catch(() => {});

        // Retry on failure
        if (attempt < maxAttempts) {
            logger.debug(`[PODCAST-DL] Download failed (attempt ${attempt}), retrying in 5s: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            return performDownload(episodeId, audioUrl, userId, attempt + 1);
        }

        throw error;
    }
}

/**
 * Store the audio's own length as the episode's. Ad networks stitch ads into the file when it is
 * fetched, so the feed's itunes:duration is the ad-free length and runs minutes short of the audio.
 * A file whose length cannot be read leaves the stored length as it was.
 */
export async function recordMeasuredLength(
    episodeId: string,
    filePath: string,
): Promise<"stored" | "unreadable" | "no-episode"> {
    try {
        const seconds = (await parseFile(filePath)).format.duration;
        if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "unreadable";
        const { count } = await prisma.podcastEpisode.updateMany({
            where: { id: episodeId },
            data: { duration: Math.round(seconds) },
        });
        return count > 0 ? "stored" : "no-episode";
    } catch (err) {
        logger.warn(`[PODCAST-DL] Could not read the length of ${filePath}: ${(err as Error).message}`);
        return "unreadable";
    }
}

/**
 * Measure every episode already in the cache: files cached before lengths were measured. Only files cached before
 * downloads measured themselves need this, so it runs once; the marker it leaves lists the files that could not be
 * read then, and later starts try only those.
 */
export async function measureCachedEpisodeLengths(): Promise<number> {
    const cacheDir = getPodcastCacheDir();
    const marker = path.join(cacheDir, ".lengths-measured");
    const left = await fs.readFile(marker, "utf8").then(
        (text) => text.split("\n").filter((line) => line.endsWith(".mp3")),
        () => null,
    );
    const files = left ?? (await fs.readdir(cacheDir).catch(() => null));
    if (!files) return 0;
    let measured = 0;
    const unreadable: string[] = [];
    for (const file of files) {
        if (!file.endsWith(".mp3")) continue;
        const filePath = path.join(cacheDir, file);
        if (!(await fs.access(filePath).then(() => true, () => false))) continue;
        const outcome = await recordMeasuredLength(path.basename(file, ".mp3"), filePath);
        if (outcome === "stored") measured++;
        if (outcome === "unreadable") unreadable.push(file);
    }
    // A marker that already lists exactly these files is left as it is.
    const unchanged = left !== null && left.length === unreadable.length;
    if (!unchanged) {
        await fs.writeFile(marker, [new Date().toISOString(), ...unreadable].join("\n") + "\n").catch((err) => {
            logger.warn(`[PODCAST-DL] Could not mark cached lengths measured: ${(err as Error).message}`);
        });
    }
    if (measured > 0) logger.info(`[PODCAST-DL] Measured the length of ${measured} cached episode(s)`);
    return measured;
}

/** Deletes cached episodes nobody played for 30 days. */
export async function cleanupExpiredCache(): Promise<{ deleted: number; freedMb: number }> {
    logger.debug('[PODCAST-DL] Starting cache cleanup...');

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Find expired downloads
    const expiredDownloads = await prisma.podcastDownload.findMany({
        where: {
            lastAccessedAt: { lt: thirtyDaysAgo }
        }
    });

    let deleted = 0;
    let freedMb = 0;

    for (const download of expiredDownloads) {
        try {
            // Delete file from disk
            await fs.unlink(download.localPath).catch(() => {});

            await prisma.podcastDownload.deleteMany({ where: { id: download.id } });

            deleted++;
            freedMb += download.fileSizeMb;

            logger.debug(`[PODCAST-DL] Deleted expired cache: ${path.basename(download.localPath)}`);
        } catch (err: any) {
            logger.error(`[PODCAST-DL] Failed to delete ${download.localPath}:`, err.message);
        }
    }

    logger.debug(`[PODCAST-DL] Cleanup complete: ${deleted} files deleted, ${freedMb.toFixed(1)}MB freed`);

    return { deleted, freedMb };
}

/** Whether the episode is downloading now. */
export function isDownloading(episodeId: string): boolean {
    return downloadingEpisodes.has(episodeId);
}

