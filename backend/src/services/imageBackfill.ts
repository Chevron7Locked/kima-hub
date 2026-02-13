/**
 * Image Backfill Service
 *
 * Downloads and stores images locally for existing artists/albums
 * that have external URLs in the database.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { downloadAndStoreImage, isNativePath } from "./imageStorage";
import { redisClient } from "../utils/redis";

const BATCH_SIZE = 10;
const DELAY_BETWEEN_BATCHES = 1000; // 1 second

interface BackfillProgress {
    total: number;
    processed: number;
    success: number;
    failed: number;
    skipped: number;
    inProgress: boolean;
}

let backfillProgress: BackfillProgress = {
    total: 0,
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    inProgress: false,
};

/**
 * Get current backfill progress
 */
export function getImageBackfillProgress(): BackfillProgress {
    return { ...backfillProgress };
}

/**
 * Check if image backfill is needed
 */
export async function isImageBackfillNeeded(): Promise<{
    needed: boolean;
    artistsWithExternalUrls: number;
    albumsWithExternalUrls: number;
}> {
    const [artistCount, albumCount] = await Promise.all([
        prisma.artist.count({
            where: {
                heroUrl: {
                    not: null,
                    startsWith: "http",
                },
            },
        }),
        prisma.album.count({
            where: {
                coverUrl: {
                    not: null,
                    startsWith: "http",
                },
            },
        }),
    ]);

    return {
        needed: artistCount > 0 || albumCount > 0,
        artistsWithExternalUrls: artistCount,
        albumsWithExternalUrls: albumCount,
    };
}

/**
 * Backfill artist images - download external URLs and store locally
 */
export async function backfillArtistImages(): Promise<void> {
    if (backfillProgress.inProgress) {
        logger.warn("[ImageBackfill] Backfill already in progress");
        return;
    }

    logger.info("[ImageBackfill] Starting artist image backfill...");

    const artistsWithExternalUrls = await prisma.artist.findMany({
        where: {
            heroUrl: {
                not: null,
                startsWith: "http",
            },
        },
        select: {
            id: true,
            name: true,
            heroUrl: true,
        },
    });

    backfillProgress = {
        total: artistsWithExternalUrls.length,
        processed: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        inProgress: true,
    };

    try {
        logger.info(
            `[ImageBackfill] Found ${artistsWithExternalUrls.length} artists with external URLs`
        );

        for (let i = 0; i < artistsWithExternalUrls.length; i += BATCH_SIZE) {
            const batch = artistsWithExternalUrls.slice(i, i + BATCH_SIZE);

            await Promise.all(
                batch.map(async (artist) => {
                    try {
                        if (!artist.heroUrl || isNativePath(artist.heroUrl)) {
                            backfillProgress.skipped++;
                            backfillProgress.processed++;
                            return;
                        }

                        const localPath = await downloadAndStoreImage(
                            artist.heroUrl,
                            artist.id,
                            "artist"
                        );

                        if (localPath) {
                            await prisma.artist.update({
                                where: { id: artist.id },
                                data: { heroUrl: localPath },
                            });

                            // Update Redis cache
                            try {
                                await redisClient.setEx(
                                    `hero:${artist.id}`,
                                    7 * 24 * 60 * 60,
                                    localPath
                                );
                            } catch {
                                // Redis errors non-critical
                            }

                            backfillProgress.success++;
                            logger.debug(
                                `[ImageBackfill] Downloaded image for ${artist.name}`
                            );
                        } else {
                            backfillProgress.failed++;
                            logger.debug(
                                `[ImageBackfill] Failed to download image for ${artist.name}`
                            );
                        }
                    } catch (error: any) {
                        backfillProgress.failed++;
                        logger.debug(
                            `[ImageBackfill] Error processing ${artist.name}: ${error.message}`
                        );
                    }

                    backfillProgress.processed++;
                })
            );

            // Delay between batches to avoid rate limiting
            if (i + BATCH_SIZE < artistsWithExternalUrls.length) {
                await new Promise((resolve) =>
                    setTimeout(resolve, DELAY_BETWEEN_BATCHES)
                );
            }
        }

        logger.info(
            `[ImageBackfill] Artist image backfill complete: ${backfillProgress.success} success, ${backfillProgress.failed} failed, ${backfillProgress.skipped} skipped`
        );
    } finally {
        backfillProgress.inProgress = false;
    }
}

/**
 * Backfill album covers - download external URLs and store locally
 */
export async function backfillAlbumCovers(): Promise<void> {
    if (backfillProgress.inProgress) {
        logger.warn("[ImageBackfill] Backfill already in progress");
        return;
    }

    logger.info("[ImageBackfill] Starting album cover backfill...");

    const albumsWithExternalUrls = await prisma.album.findMany({
        where: {
            coverUrl: {
                not: null,
                startsWith: "http",
            },
        },
        select: {
            id: true,
            title: true,
            coverUrl: true,
        },
    });

    backfillProgress = {
        total: albumsWithExternalUrls.length,
        processed: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        inProgress: true,
    };

    try {
        logger.info(
            `[ImageBackfill] Found ${albumsWithExternalUrls.length} albums with external URLs`
        );

        for (let i = 0; i < albumsWithExternalUrls.length; i += BATCH_SIZE) {
            const batch = albumsWithExternalUrls.slice(i, i + BATCH_SIZE);

            await Promise.all(
                batch.map(async (album) => {
                    try {
                        if (!album.coverUrl || isNativePath(album.coverUrl)) {
                            backfillProgress.skipped++;
                            backfillProgress.processed++;
                            return;
                        }

                        const localPath = await downloadAndStoreImage(
                            album.coverUrl,
                            album.id,
                            "album"
                        );

                        if (localPath) {
                            await prisma.album.update({
                                where: { id: album.id },
                                data: { coverUrl: localPath },
                            });

                            // Update Redis cache
                            try {
                                await redisClient.setEx(
                                    `album-cover:${album.id}`,
                                    30 * 24 * 60 * 60,
                                    localPath
                                );
                            } catch {
                                // Redis errors non-critical
                            }

                            backfillProgress.success++;
                            logger.debug(
                                `[ImageBackfill] Downloaded cover for ${album.title}`
                            );
                        } else {
                            backfillProgress.failed++;
                        }
                    } catch (error: any) {
                        backfillProgress.failed++;
                        logger.debug(
                            `[ImageBackfill] Error processing ${album.title}: ${error.message}`
                        );
                    }

                    backfillProgress.processed++;
                })
            );

            if (i + BATCH_SIZE < albumsWithExternalUrls.length) {
                await new Promise((resolve) =>
                    setTimeout(resolve, DELAY_BETWEEN_BATCHES)
                );
            }
        }

        logger.info(
            `[ImageBackfill] Album cover backfill complete: ${backfillProgress.success} success, ${backfillProgress.failed} failed, ${backfillProgress.skipped} skipped`
        );
    } finally {
        backfillProgress.inProgress = false;
    }
}

/**
 * Backfill all images (artists and albums)
 */
export async function backfillAllImages(): Promise<void> {
    await backfillArtistImages();
    await backfillAlbumCovers();
}
