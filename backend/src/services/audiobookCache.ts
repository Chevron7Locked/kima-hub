import { audiobookshelfService } from "./audiobookshelf";
import { buildSections, resolveMetaTags } from "./audiobookSections";
import { artistSortName } from "./artistIdentity";
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

class AudiobookCacheService {
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
                    const synced = await this.syncAudiobook(book);
                    if (synced) {
                        result.synced++;
                        const metadata = book.media?.metadata || book;
                        const title = metadata.title || book.title || "Unknown Title";
                        const author = metadata.authorName || metadata.author || book.author || "Unknown Author";
                        logger.debug(`  Synced: ${title} by ${author}`);
                    } else {
                        result.skipped++;
                    }
                } catch (error: any) {
                    result.failed++;
                    const metadata = book.media?.metadata || book;
                    const title = metadata.title || book.title || "Unknown Title";
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
    private async syncAudiobook(book: any): Promise<boolean> {
        const metadata = book.media?.metadata || book;
        const title = metadata.title || book.title;

        if (!title) {
            logger.warn(`  Skipping audiobook ${book.id} - missing title`);
            return false;
        }

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
        // Expanded ABS items carry a tracks array but may omit numTracks; derive
        // it from the array length so play-adjacent cache fills don't leave NULL.
        const numTracks: number | null =
            book.media?.numTracks != null
                ? (book.media.numTracks as number)
                : Array.isArray(book.media?.tracks) && book.media.tracks.length > 0
                  ? (book.media.tracks.length as number)
                  : null;
        const size = book.media?.size ? BigInt(book.media.size) : null;
        const libraryId = book.libraryId || null;

        const coverPath = book.media?.coverPath || null;
        const coverUrl = coverPath ? `items/${book.id}/cover` : null;

        // Parse series name and sequence from seriesName string (e.g. "Series Name #2")
        let series: string | null = null;
        let seriesSequence: string | null = null;

        if (metadata.seriesName && typeof metadata.seriesName === "string") {
            const seriesStr = metadata.seriesName.trim();

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

        if (series) {
            logger.debug(
                `    [Series] "${title}" -> "${series}" #${
                    seriesSequence || "?"
                }`
            );
        }

        // Pull expanded data when present (chapters, tracks, audioFiles come from ?expanded=1 fetch).
        const rawChapters: any[] = Array.isArray(book.media?.chapters) ? book.media.chapters : [];
        const rawTracks: any[] = Array.isArray(book.media?.tracks) ? book.media.tracks : [];
        const rawAudioFiles: any[] = Array.isArray(book.media?.audioFiles) ? book.media.audioFiles : [];
        const firstFileMeta: Record<string, string> | null = rawAudioFiles[0]?.metaTags ?? null;

        const {
            narrator: resolvedNarrator,
            genres: resolvedGenres,
            publishedYear: resolvedPublishedYear,
        } = resolveMetaTags(narrator, genres, publishedYear, firstFileMeta);

        // Only persist track map when the expanded response carries tracks.
        const tracksJson: { index: number; startOffset: number; duration: number }[] | null =
            rawTracks.length > 0
                ? rawTracks.map((t: any) => ({
                      index: t.index as number,
                      startOffset: (t.startOffset ?? 0) as number,
                      duration: (t.duration ?? 0) as number,
                  }))
                : null;

        // Only compute sections when we have expanded data; null means "not computed yet".
        const isExpanded = rawTracks.length > 0 || rawChapters.length > 0 || rawAudioFiles.length > 0;
        const sectionsJson: { index: number; title: string; start: number }[] | null = isExpanded
            ? buildSections({
                  duration: duration ?? 0,
                  chapters: rawChapters,
                  tracks: rawTracks.map((t: any) => ({
                      startOffset: (t.startOffset ?? 0) as number,
                      name: rawAudioFiles.find((af: any) => af.index === t.index)?.metadata?.filename as string | undefined,
                  })),
              })
            : null;

        let localCoverPath: string | null = null;
        if (coverUrl) {
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
                // Recomputed on every sync, same as `title` itself already is
                // (both branches set it unconditionally, not just on create) --
                // a sort key derived from a field that keeps refreshing has to
                // refresh with it, or it silently goes stale the first time
                // this book's title changes upstream.
                sortName: artistSortName(title),
                author,
                narrator: resolvedNarrator,
                description,
                publishedYear: resolvedPublishedYear,
                publisher,
                series,
                seriesSequence,
                duration,
                numTracks,
                size,
                isbn,
                asin,
                language,
                genres: resolvedGenres,
                tags,
                localCoverPath,
                coverUrl,
                audioUrl: book.id,
                libraryId,
                lastSyncedAt: new Date(),
                ...(tracksJson !== null && { tracksJson }),
                ...(sectionsJson !== null && { sectionsJson }),
            },
            update: {
                title,
                sortName: artistSortName(title),
                author,
                narrator: resolvedNarrator,
                description,
                publishedYear: resolvedPublishedYear,
                publisher,
                series,
                seriesSequence,
                duration,
                numTracks,
                size,
                isbn,
                asin,
                language,
                genres: resolvedGenres,
                tags,
                localCoverPath: localCoverPath || undefined,
                coverUrl,
                audioUrl: book.id,
                libraryId,
                lastSyncedAt: new Date(),
                ...(tracksJson !== null && { tracksJson }),
                ...(sectionsJson !== null && { sectionsJson }),
            },
        });

        return true;
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
                signal: AbortSignal.timeout(10_000),
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

        // Sync when missing, stale (> 7 days), or sectionsJson not yet populated (backfill).
        if (
            !audiobook ||
            audiobook.lastSyncedAt < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) ||
            audiobook.sectionsJson === null
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

// Singleton instance
export const audiobookCacheService = new AudiobookCacheService();
