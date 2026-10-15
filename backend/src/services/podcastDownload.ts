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

/**
 * Background download and caching of podcast episodes when played, with range
 * support for cached files and 30-day expiry.
 */

// Track in-progress downloads to avoid duplicates
const downloadingEpisodes = new Set<string>();

// Cache and completeness checks accept a 1% size difference: some servers and
// filesystems are inconsistent at the byte level.
const SIZE_TOLERANCE = 0.01;

// Track download progress (episodeId -> { bytesDownloaded, totalBytes })
interface DownloadProgress {
    bytesDownloaded: number;
    totalBytes: number;
}
const downloadProgress = new Map<string, DownloadProgress>();

// Cache directory for podcast audio files
const getPodcastCacheDir = (): string => {
    return path.join(config.music.transcodeCachePath, "../podcast-audio");
};

/**
 * Get download progress for an episode
 * Returns { progress: 0-100, downloading: boolean } or null if not downloading
 */
export function getDownloadProgress(episodeId: string): { progress: number; downloading: boolean } | null {
    if (!downloadingEpisodes.has(episodeId)) {
        return null;
    }
    
    const progress = downloadProgress.get(episodeId);
    if (!progress || progress.totalBytes === 0) {
        return { progress: 0, downloading: true };
    }
    
    const percent = Math.round((progress.bytesDownloaded / progress.totalBytes) * 100);
    return { progress: Math.min(100, percent), downloading: true };
}

/**
 * Internal cache validation -- checks filesystem and DB without consulting
 * the downloadingEpisodes set. Used by performDownload to avoid the
 * delete-then-readd race on the in-progress set.
 */
async function validateCachedFile(episodeId: string): Promise<string | null> {
    const cacheDir = getPodcastCacheDir();
    const cachedPath = path.join(cacheDir, `${episodeId}.mp3`);

    try {
        await fs.access(cachedPath, fs.constants.F_OK);
        const stats = await fs.stat(cachedPath);

        // File must be > 0 bytes to be valid
        if (stats.size > 0) {
            // Strong validation: if we know the canonical remote file size, require the cache to match.
            try {
                const episode = await prisma.podcastEpisode.findUnique({
                    where: { id: episodeId },
                    select: { fileSize: true },
                });
                if (episode?.fileSize && episode.fileSize > 0) {
                    const expected = episode.fileSize;
                    const actual = stats.size;
                    const variance = Math.abs(actual - expected) / expected;
                    if (variance > SIZE_TOLERANCE) {
                        logger.debug(
                            `[PODCAST-DL] Episode size mismatch vs episode.fileSize for ${episodeId}: actual ${actual} vs expected ${expected} (variance ${Math.round(
                                variance * 100
                            )}%), deleting cache`
                        );
                        await fs.unlink(cachedPath).catch(() => {});
                        await prisma.podcastDownload.deleteMany({
                            where: { episodeId },
                        });
                        return null;
                    }
                }
            } catch {
                // If this check fails, fall back to prior DB-record based validation
            }

            // Check database record exists
            const dbRecord = await prisma.podcastDownload.findFirst({
                where: { episodeId }
            });

            // If no DB record, file might be incomplete or stale
            if (!dbRecord) {
                logger.debug(`[PODCAST-DL] No DB record for ${episodeId}, deleting stale cache file`);
                await fs.unlink(cachedPath).catch(() => {});
                return null;
            }

            // Validate file size matches what we recorded (allow 1% variance for filesystem differences)
            const expectedSize = dbRecord.fileSizeMb * 1024 * 1024;
            const actualSize = stats.size;
            const variance = Math.abs(actualSize - expectedSize) / expectedSize;

            if (expectedSize > 0 && variance > SIZE_TOLERANCE) {
                logger.debug(`[PODCAST-DL] Size mismatch for ${episodeId}: actual ${actualSize} vs expected ${Math.round(expectedSize)}, deleting`);
                await fs.unlink(cachedPath).catch(() => {});
                await prisma.podcastDownload.deleteMany({ where: { episodeId } });
                return null;
            }

            // Update last accessed time
            await prisma.podcastDownload.updateMany({
                where: { episodeId },
                data: { lastAccessedAt: new Date() }
            });

            logger.debug(`[PODCAST-DL] Cache valid for ${episodeId}: ${stats.size} bytes`);
            return cachedPath;
        }
        return null;
    } catch {
        // A missing or unreadable file is no cache; the caller downloads afresh.
        return null;
    }
}

/**
 * Check if a cached file exists and is valid
 * Returns null if file doesn't exist, is empty, or is still being downloaded
 */
export async function getCachedFilePath(episodeId: string): Promise<string | null> {
    // Don't return cache path if still downloading - file may be incomplete
    if (downloadingEpisodes.has(episodeId)) {
        logger.debug(`[PODCAST-DL] Episode ${episodeId} is still downloading, not using cache`);
        return null;
    }

    return validateCachedFile(episodeId);
}

/**
 * Start a background download for an episode
 * Returns immediately, download happens asynchronously
 */
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

/**
 * Perform the actual download with retry support
 */
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
            `[PODCAST-DL] Downloading ${episodeId} (${expectedBytes > 0 ? Math.round(expectedBytes / 1024 / 1024) : 0}MB)`
        );
        
        // Initialize progress tracking
        downloadProgress.set(episodeId, {
            bytesDownloaded: 0,
            totalBytes: expectedBytes || 0,
        });
        
        // Write to temp file first with progress tracking
        const writeStream = createWriteStream(tempPath);
        let bytesDownloaded = 0;
        let lastLogTime = Date.now();
        
        await new Promise<void>((resolve, reject) => {
            response.data.on('data', (chunk: Buffer) => {
                bytesDownloaded += chunk.length;
                downloadProgress.set(episodeId, { bytesDownloaded, totalBytes: expectedBytes });
                
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
            
            writeStream.on('error', (err) => {
                response.data.destroy();
                reject(err);
            });
            
            response.data.on('error', (err: Error) => {
                writeStream.destroy();
                reject(err);
            });
            
            // Handle aborted connections
            response.data.on('aborted', () => {
                writeStream.destroy();
                reject(new Error('Download aborted by server'));
            });
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
        
        // Clean up progress tracking
        downloadProgress.delete(episodeId);
        
    } catch (error: any) {
        // Clean up temp file and progress tracking on error
        await fs.unlink(tempPath).catch(() => {});
        downloadProgress.delete(episodeId);
        
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
export async function recordMeasuredLength(episodeId: string, filePath: string): Promise<boolean> {
    try {
        const seconds = (await parseFile(filePath)).format.duration;
        if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return false;
        const { count } = await prisma.podcastEpisode.updateMany({
            where: { id: episodeId },
            data: { duration: Math.round(seconds) },
        });
        return count > 0;
    } catch (err) {
        logger.warn(`[PODCAST-DL] Could not read the length of ${filePath}: ${(err as Error).message}`);
        return false;
    }
}

/** Measure every episode already in the cache: files cached before lengths were measured. */
export async function measureCachedEpisodeLengths(): Promise<number> {
    const cacheDir = getPodcastCacheDir();
    // Only files cached before downloads measured themselves need this; once they have been, startup skips it.
    const marker = path.join(cacheDir, ".lengths-measured");
    if (await fs.access(marker).then(() => true, () => false)) return 0;
    const files = await fs.readdir(cacheDir).catch(() => null);
    if (!files) return 0;
    let measured = 0;
    for (const file of files) {
        if (!file.endsWith(".mp3")) continue;
        if (await recordMeasuredLength(path.basename(file, ".mp3"), path.join(cacheDir, file))) measured++;
    }
    await fs.writeFile(marker, `${new Date().toISOString()}\n`).catch((err) => {
        logger.warn(`[PODCAST-DL] Could not mark cached lengths measured: ${(err as Error).message}`);
    });
    if (measured > 0) logger.info(`[PODCAST-DL] Measured the length of ${measured} cached episode(s)`);
    return measured;
}

/**
 * Clean up cached episodes older than 30 days
 * Should be called periodically (e.g., daily)
 */
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
            
            // Delete database record
            await prisma.podcastDownload.delete({
                where: { id: download.id }
            });
            
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


/**
 * Check if an episode is currently being downloaded
 */
export function isDownloading(episodeId: string): boolean {
    return downloadingEpisodes.has(episodeId);
}

