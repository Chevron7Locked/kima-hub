import { audiobookshelfService } from "./audiobookshelf";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import fs from "fs/promises";
import path from "path";
import { config } from "../config";

/**
 * Service to sync audiobooks from Audiobookshelf and cache them locally
 * This allows us to serve audiobook metadata from our database instead of hitting
 * the Audiobookshelf API every time, dramatically improving performance
 */

interface SyncResult {
    synced: number;
    failed: number;
    skipped: number;
    errors: string[];
}

export class AudiobookCacheService {
    private coverCacheDir: string;
    private coverCacheAvailable: boolean = false;

    constructor() {
        // Store covers in: <MUSIC_PATH>/cover-cache/audiobooks/
        this.coverCacheDir = path.join(
            config.music.musicPath,
            "cover-cache",
            "audiobooks"
        );
    }

    /**
     * Try to ensure cover cache directory exists
     * Returns true if available, false if not (permissions issue)
     */
    private async ensureCoverCacheDir(): Promise<boolean> {
        try {
            await fs.mkdir(this.coverCacheDir, { recursive: true });
            this.coverCacheAvailable = true;
            return true;
        } catch (error: any) {
            logger.warn(`[AUDIOBOOK] Cover cache directory unavailable: ${error.message}`);
            logger.warn("[AUDIOBOOK] Covers will be served directly from Audiobookshelf");
            this.coverCacheAvailable = false;
            return false;
        }
    }

    /**
     * Sync all audiobooks from Audiobookshelf to our database
     */
    async syncAll(): Promise<SyncResult> {
        const result: SyncResult = {
            synced: 0,
            failed: 0,
            skipped: 0,
            errors: [],
        };

        try {
            logger.debug(" Starting audiobook sync from Audiobookshelf...");

            // Try to ensure cover cache directory exists (non-fatal if it fails)
            await this.ensureCoverCacheDir();

            // Fetch all audiobooks from Audiobookshelf
            const audiobooks = await audiobookshelfService.getAllAudiobooks();

            logger.debug(
                `[AUDIOBOOK] Found ${audiobooks.length} audiobooks in Audiobookshelf`
            );

            for (const book of audiobooks) {
                try {
                    await this.syncAudiobook(book);
                    result.synced++;
                    // Extract title and author from nested structure for logging
                    const metadata = book.media?.metadata || book;
                    const title =
                        metadata.title || book.title || "Unknown Title";
                    const author =
                        metadata.authorName ||
                        metadata.author ||
                        book.author ||
                        "Unknown Author";
                    logger.debug(`  Synced: ${title} by ${author}`);
                } catch (error: any) {
                    result.failed++;
                    const metadata = book.media?.metadata || book;
                    const title =
                        metadata.title || book.title || "Unknown Title";
                    const errorMsg = `Failed to sync ${title}: ${error.message}`;
                    result.errors.push(errorMsg);
                    logger.error(` ${errorMsg}`);
                }
            }

            logger.debug("\nSync Summary:");
            logger.debug(`  Synced: ${result.synced}`);
            logger.debug(`   Failed: ${result.failed}`);
            logger.debug(`    Skipped: ${result.skipped}`);

            if (result.errors.length > 0) {
                logger.debug("\n[ERRORS]:");
                result.errors.forEach((err) => logger.debug(`  - ${err}`));
            }

            return result;
        } catch (error: any) {
            logger.error(" Audiobook sync failed:", error);
            throw error;
        }
    }

    /**
     * Sync a single audiobook
     */
    private async syncAudiobook(book: any): Promise<void> {
        // Extract metadata from Audiobookshelf API response structure
        // The API returns: { id, media: { metadata: { title, author, ... } } }
        const metadata = book.media?.metadata || book;
        const title = metadata.title || book.title;

        // Skip if no title (invalid audiobook data)
        if (!title) {
            logger.warn(`  Skipping audiobook ${book.id} - missing title`);
            return;
        }

        // Extract additional fields from API response
        const author = metadata.authorName || metadata.author || null;
        const narrator = metadata.narratorName || metadata.narrator || null;
        const description = metadata.description || null;
        const publishedYear = metadata.publishedYear
            ? parseInt(metadata.publishedYear)
            : null;
        const publisher = metadata.publisher || null;
        const isbn = metadata.isbn || null;
        const asin = metadata.asin || null;
        const language = metadata.language || null;
        const genres = metadata.genres || [];
        const tags = book.tags || [];
        const duration = book.media?.duration || null;
        const numTracks = book.media?.numTracks || null;
        const numChapters = book.media?.numChapters || null;
        const size = book.size ? BigInt(book.size) : null;
        const libraryId = book.libraryId || null;

        // Get cover path - Audiobookshelf uses media.coverPath
        const coverPath = book.media?.coverPath || null;

        // Build full cover URL for download (needs to be absolute URL with base)
        const coverUrl = coverPath ? `items/${book.id}/cover` : null;

        // Series info - Audiobookshelf returns seriesName as a string like "Series Name #2"
        // We need to parse this to extract the series name and sequence number
        let series: string | null = null;
        let seriesSequence: string | null = null;

        if (metadata.seriesName && typeof metadata.seriesName === "string") {
            const seriesStr = metadata.seriesName.trim();

            // Try to extract sequence from patterns like:
            // "Series Name #1", "Series Name #2", "Series Name Book 1", "Series Name, Book 1"
            const sequencePatterns = [
                /^(.+?)\s*#(\d+(?:\.\d+)?)\s*$/, // "Series Name #1" or "Series Name #1.5"
                /^(.+?)\s*,?\s*Book\s*(\d+(?:\.\d+)?)\s*$/i, // "Series Name Book 1" or "Series Name, Book 1"
                /^(.+?)\s*,?\s*Vol\.?\s*(\d+(?:\.\d+)?)\s*$/i, // "Series Name Vol 1" or "Series Name, Vol. 1"
                /^(.+?)\s*\((\d+(?:\.\d+)?)\)\s*$/, // "Series Name (1)"
            ];

            let matched = false;
            for (const pattern of sequencePatterns) {
                const match = seriesStr.match(pattern);
                if (match) {
                    series = match[1].trim();
                    seriesSequence = match[2];
                    matched = true;
                    break;
                }
            }

            // If no sequence pattern matched, use the whole string as series name
            if (!matched && seriesStr) {
                series = seriesStr;
                seriesSequence = null;
            }
        }

        // Fallback: check metadata.series array/object format
        if (!series) {
            if (Array.isArray(metadata.series) && metadata.series.length > 0) {
                series = metadata.series[0]?.name || null;
                seriesSequence =
                    metadata.series[0]?.sequence?.toString() || null;
            } else if (
                typeof metadata.series === "object" &&
                metadata.series !== null
            ) {
                series = metadata.series.name || null;
                seriesSequence = metadata.series.sequence?.toString() || null;
            }
        }

        // Log series info for debugging (only for first few books)
        if (series) {
            logger.debug(
                `    [Series] "${title}" -> "${series}" #${
                    seriesSequence || "?"
                }`
            );
        }

        // Download cover image if available - need to construct full URL
        let localCoverPath: string | null = null;
        if (coverUrl) {
            // Get the Audiobookshelf base URL from the service
            const fullCoverUrl = await this.getFullCoverUrl(coverUrl);
            if (fullCoverUrl) {
                localCoverPath = await this.downloadCover(
                    book.id,
                    fullCoverUrl
                );
            }
        }

        // Upsert to database
        await prisma.audiobook.upsert({
            where: { id: book.id },
            create: {
                id: book.id,
                title,
                author,
                narrator,
                description,
                publishedYear,
                publisher,
                series,
                seriesSequence,
                duration,
                numTracks,
                numChapters,
                size,
                isbn,
                asin,
                language,
                genres,
                tags,
                localCoverPath,
                coverUrl,
                audioUrl: book.id,
                libraryId,
                lastSyncedAt: new Date(),
            },
            update: {
                title,
                author,
                narrator,
                description,
                publishedYear,
                publisher,
                series,
                seriesSequence,
                duration,
                numTracks,
                numChapters,
                size,
                isbn,
                asin,
                language,
                genres,
                tags,
                localCoverPath: localCoverPath || undefined,
                coverUrl,
                audioUrl: book.id,
                libraryId,
                lastSyncedAt: new Date(),
            },
        });
    }

    /**
     * Get full Audiobookshelf cover URL by prepending base URL
     */
    private async getFullCoverUrl(
        relativePath: string
    ): Promise<string | null> {
        try {
            const { getSystemSettings } = await import(
                "../utils/systemSettings"
            );
            const settings = await getSystemSettings();

            if (settings?.audiobookshelfUrl) {
                const baseUrl = settings.audiobookshelfUrl.replace(/\/$/, "");
                return `${baseUrl}/api/${relativePath}`;
            }

            return null;
        } catch (error: any) {
            logger.error(
                "Failed to get Audiobookshelf base URL:",
                error.message
            );
            return null;
        }
    }

    /**
     * Download a cover image and save it locally
     * Returns null if cover caching is not available (permissions issue)
     */
    private async downloadCover(
        audiobookId: string,
        coverUrl: string
    ): Promise<string | null> {
        // Skip cover download if cache directory is not available
        if (!this.coverCacheAvailable) {
            return null;
        }

        try {
            // Get API key for authentication
            const { getSystemSettings } = await import(
                "../utils/systemSettings"
            );
            const settings = await getSystemSettings();

            if (!settings?.audiobookshelfApiKey) {
                throw new Error("Audiobookshelf API key not configured");
            }

            const response = await fetch(coverUrl, {
                headers: {
                    Authorization: `Bearer ${settings.audiobookshelfApiKey}`,
                },
            });

            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status}: ${response.statusText}`
                );
            }

            const buffer = await response.arrayBuffer();
            const fileName = `${audiobookId}.jpg`;
            const filePath = path.join(this.coverCacheDir, fileName);

            await fs.writeFile(filePath, Buffer.from(buffer));

            return filePath;
        } catch (error: any) {
            logger.error(
                `Failed to download cover for ${audiobookId}:`,
                error.message
            );
            return null;
        }
    }

    /**
     * Get a single audiobook from cache or sync it
     */
    async getAudiobook(audiobookId: string): Promise<any> {
        // Try to get from database first
        let audiobook = await prisma.audiobook.findUnique({
            where: { id: audiobookId },
        });

        // If not in cache or stale (> 7 days), try to sync it
        if (
            !audiobook ||
            audiobook.lastSyncedAt <
                new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        ) {
            logger.debug(
                `[AUDIOBOOK] Audiobook ${audiobookId} not cached or stale, syncing...`
            );
            try {
                const book = await audiobookshelfService.getAudiobook(
                    audiobookId
                );
                await this.syncAudiobook(book);
                audiobook = await prisma.audiobook.findUnique({
                    where: { id: audiobookId },
                });
            } catch (syncError: any) {
                logger.warn(
                    `  Failed to sync audiobook ${audiobookId} from Audiobookshelf:`,
                    syncError.message
                );
                // If we have stale cached data, return it anyway
                if (audiobook) {
                    logger.debug(
                        `   Using stale cached data for ${audiobookId}`
                    );
                } else {
                    // No cached data and sync failed - throw error
                    throw new Error(
                        `Audiobook not found in cache and sync failed: ${syncError.message}`
                    );
                }
            }
        }

        return audiobook;
    }

    /**
     * Clean up old cached covers that are no longer in database
     */
    async cleanupOrphanedCovers(): Promise<number> {
        // Ensure cache directory is available
        const available = await this.ensureCoverCacheDir();
        if (!available) {
            logger.warn("[AUDIOBOOK] Cannot cleanup covers - cache directory unavailable");
            return 0;
        }

        const audiobooks = await prisma.audiobook.findMany({
            select: { localCoverPath: true },
        });

        const validCoverPaths = new Set(
            audiobooks
                .filter((a) => a.localCoverPath)
                .map((a) => path.basename(a.localCoverPath!))
        );

        let deleted = 0;
        try {
            const files = await fs.readdir(this.coverCacheDir);

            for (const file of files) {
                if (!validCoverPaths.has(file)) {
                    await fs.unlink(path.join(this.coverCacheDir, file));
                    deleted++;
                    logger.debug(`  [DELETE] Deleted orphaned cover: ${file}`);
                }
            }
        } catch (error: any) {
            logger.warn(`[AUDIOBOOK] Failed to read cover cache directory: ${error.message}`);
        }

        return deleted;
    }
}

// Export singleton instance
export const audiobookCacheService = new AudiobookCacheService();
