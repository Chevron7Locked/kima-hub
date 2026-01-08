import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import fs from "fs/promises";
import path from "path";
import { config } from "../config";

/**
 * Service to cache podcast cover images locally
 * Podcasts are already stored in database (from RSS feeds)
 * This service adds cover image caching to avoid repeated downloads
 */

interface CoverSyncResult {
    synced: number;
    failed: number;
    skipped: number;
    errors: string[];
}

export class PodcastCacheService {
    private coverCacheDir: string;

    constructor() {
        // Store covers in: <MUSIC_PATH>/cover-cache/podcasts/
        this.coverCacheDir = path.join(
            config.music.musicPath,
            "cover-cache",
            "podcasts"
        );
    }

    /**
     * Sync cover images for all podcasts
     */
    async syncAllCovers(): Promise<CoverSyncResult> {
        const result: CoverSyncResult = {
            synced: 0,
            failed: 0,
            skipped: 0,
            errors: [],
        };

        try {
            logger.debug(" Starting podcast cover sync...");

            // Ensure cover cache directory exists
            await fs.mkdir(this.coverCacheDir, { recursive: true });

            // Fetch all podcasts from database
            const podcasts = await prisma.podcast.findMany({
                where: {
                    localCoverPath: null, // Only sync podcasts without local covers
                    imageUrl: { not: null },
                },
            });

            logger.debug(
                `[PODCAST] Found ${podcasts.length} podcasts needing cover sync`
            );

            for (const podcast of podcasts) {
                try {
                    if (podcast.imageUrl) {
                        const localPath = await this.downloadCover(
                            podcast.id,
                            podcast.imageUrl,
                            "podcast"
                        );

                        if (localPath) {
                            await prisma.podcast.update({
                                where: { id: podcast.id },
                                data: { localCoverPath: localPath },
                            });
                            result.synced++;
                            logger.debug(`  Synced cover for: ${podcast.title}`);
                        } else {
                            result.skipped++;
                        }
                    }
                } catch (error: any) {
                    result.failed++;
                    const errorMsg = `Failed to sync cover for ${podcast.title}: ${error.message}`;
                    result.errors.push(errorMsg);
                    logger.error(` ${errorMsg}`);
                }
            }

            logger.debug("\nPodcast Cover Sync Summary:");
            logger.debug(`  Synced: ${result.synced}`);
            logger.debug(`   Failed: ${result.failed}`);
            logger.debug(`    Skipped: ${result.skipped}`);

            return result;
        } catch (error: any) {
            logger.error(" Podcast cover sync failed:", error);
            throw error;
        }
    }

    /**
     * Sync cover images for all podcast episodes (if they have unique covers)
     */
    async syncEpisodeCovers(): Promise<CoverSyncResult> {
        const result: CoverSyncResult = {
            synced: 0,
            failed: 0,
            skipped: 0,
            errors: [],
        };

        try {
            logger.debug(" Starting podcast episode cover sync...");

            await fs.mkdir(this.coverCacheDir, { recursive: true });

            // Fetch episodes with unique covers (different from podcast cover)
            const episodes = await prisma.podcastEpisode.findMany({
                where: {
                    localCoverPath: null,
                    imageUrl: { not: null },
                },
                include: {
                    podcast: {
                        select: {
                            imageUrl: true,
                        },
                    },
                },
            });

            // Filter to only episodes with unique covers
            const uniqueEpisodes = episodes.filter(
                (ep) => ep.imageUrl !== ep.podcast.imageUrl
            );

            logger.debug(
                `[PODCAST] Found ${uniqueEpisodes.length} episodes with unique covers`
            );

            for (const episode of uniqueEpisodes) {
                try {
                    if (episode.imageUrl) {
                        const localPath = await this.downloadCover(
                            episode.id,
                            episode.imageUrl,
                            "episode"
                        );

                        if (localPath) {
                            await prisma.podcastEpisode.update({
                                where: { id: episode.id },
                                data: { localCoverPath: localPath },
                            });
                            result.synced++;
                            logger.debug(
                                `  Synced cover for episode: ${episode.title}`
                            );
                        } else {
                            result.skipped++;
                        }
                    }
                } catch (error: any) {
                    result.failed++;
                    const errorMsg = `Failed to sync cover for episode ${episode.title}: ${error.message}`;
                    result.errors.push(errorMsg);
                    logger.error(` ${errorMsg}`);
                }
            }

            logger.debug("\nEpisode Cover Sync Summary:");
            logger.debug(`  Synced: ${result.synced}`);
            logger.debug(`   Failed: ${result.failed}`);
            logger.debug(`    Skipped: ${result.skipped}`);

            return result;
        } catch (error: any) {
            logger.error(" Episode cover sync failed:", error);
            throw error;
        }
    }

    /**
     * Download a cover image and save it locally
     */
    private async downloadCover(
        id: string,
        imageUrl: string,
        type: "podcast" | "episode"
    ): Promise<string | null> {
        try {
            const response = await fetch(imageUrl);

            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status}: ${response.statusText}`
                );
            }

            const buffer = await response.arrayBuffer();
            const fileName = `${type}_${id}.jpg`;
            const filePath = path.join(this.coverCacheDir, fileName);

            await fs.writeFile(filePath, Buffer.from(buffer));

            return filePath;
        } catch (error: any) {
            logger.error(
                `Failed to download cover for ${type} ${id}:`,
                error.message
            );
            return null;
        }
    }

    /**
     * Clean up orphaned covers
     */
    async cleanupOrphanedCovers(): Promise<number> {
        const podcasts = await prisma.podcast.findMany({
            select: { localCoverPath: true },
        });

        const episodes = await prisma.podcastEpisode.findMany({
            select: { localCoverPath: true },
        });

        const validCoverPaths = new Set([
            ...podcasts
                .filter((p) => p.localCoverPath)
                .map((p) => path.basename(p.localCoverPath!)),
            ...episodes
                .filter((e) => e.localCoverPath)
                .map((e) => path.basename(e.localCoverPath!)),
        ]);

        let deleted = 0;
        const files = await fs.readdir(this.coverCacheDir);

        for (const file of files) {
            if (!validCoverPaths.has(file)) {
                await fs.unlink(path.join(this.coverCacheDir, file));
                deleted++;
                logger.debug(`  [DELETE] Deleted orphaned podcast cover: ${file}`);
            }
        }

        return deleted;
    }
}

// Export singleton instance
export const podcastCacheService = new PodcastCacheService();
