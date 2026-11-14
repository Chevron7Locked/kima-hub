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
 * Download external images to local storage, one entity kind at a time.
 */
type BackfillKind = "artist" | "album";

const BACKFILLS: Record<
    BackfillKind,
    { noun: string; cacheKey: (id: string) => string; cacheTtlSeconds: number }
> = {
    artist: {
        noun: "image",
        cacheKey: (id) => `hero:${id}`,
        cacheTtlSeconds: 7 * 24 * 60 * 60,
    },
    album: {
        noun: "cover",
        cacheKey: (id) => `album-cover:${id}`,
        cacheTtlSeconds: 30 * 24 * 60 * 60,
    },
};

async function backfillImages(kind: BackfillKind, shouldStop: () => boolean): Promise<void> {
    if (backfillProgress.inProgress) {
        logger.warn("[ImageBackfill] Backfill already in progress");
        return;
    }

    if (shouldStop()) return;
    const { noun, cacheKey, cacheTtlSeconds } = BACKFILLS[kind];
    logger.info(`[ImageBackfill] Starting ${kind} ${noun} backfill...`);

    const rows =
        kind === "artist"
            ? (
                  await prisma.artist.findMany({
                      where: { heroUrl: { not: null, startsWith: "http" } },
                      select: { id: true, name: true, heroUrl: true },
                  })
              ).map((a) => ({ id: a.id, label: a.name, url: a.heroUrl }))
            : (
                  await prisma.album.findMany({
                      where: { coverUrl: { not: null, startsWith: "http" } },
                      select: { id: true, title: true, coverUrl: true },
                  })
              ).map((a) => ({ id: a.id, label: a.title, url: a.coverUrl }));

    backfillProgress = {
        total: rows.length,
        processed: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        inProgress: true,
    };

    try {
        logger.info(
            `[ImageBackfill] Found ${rows.length} ${kind}s with external URLs`
        );

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            if (shouldStop()) {
                logger.info(`[ImageBackfill] ${kind} ${noun} backfill stopped for shutdown: ${backfillProgress.processed}/${rows.length} done`);
                return;
            }
            const batch = rows.slice(i, i + BATCH_SIZE);

            await Promise.all(
                batch.map(async (row) => {
                    try {
                        if (!row.url || isNativePath(row.url)) {
                            backfillProgress.skipped++;
                            backfillProgress.processed++;
                            return;
                        }

                        const localPath = await downloadAndStoreImage(
                            row.url,
                            row.id,
                            kind
                        );

                        if (localPath) {
                            if (kind === "artist") {
                                await prisma.artist.update({
                                    where: { id: row.id },
                                    data: { heroUrl: localPath },
                                });
                            } else {
                                await prisma.album.update({
                                    where: { id: row.id },
                                    data: { coverUrl: localPath },
                                });
                            }

                            // Update Redis cache
                            try {
                                await redisClient.setex(
                                    cacheKey(row.id),
                                    cacheTtlSeconds,
                                    localPath
                                );
                            } catch {
                                // Redis errors non-critical
                            }

                            backfillProgress.success++;
                            logger.debug(
                                `[ImageBackfill] Downloaded ${noun} for ${row.label}`
                            );
                        } else {
                            backfillProgress.failed++;
                            logger.debug(
                                `[ImageBackfill] Failed to download ${noun} for ${row.label}`
                            );
                        }
                    } catch (error: any) {
                        backfillProgress.failed++;
                        logger.debug(
                            `[ImageBackfill] Error processing ${row.label}: ${error.message}`
                        );
                    }

                    backfillProgress.processed++;
                })
            );

            // Delay between batches to avoid rate limiting
            if (i + BATCH_SIZE < rows.length) {
                await new Promise((resolve) =>
                    setTimeout(resolve, DELAY_BETWEEN_BATCHES)
                );
            }
        }

        logger.info(
            `[ImageBackfill] ${kind} ${noun} backfill complete: ${backfillProgress.success} success, ${backfillProgress.failed} failed, ${backfillProgress.skipped} skipped`
        );
    } finally {
        backfillProgress.inProgress = false;
    }
}

/**
 * Backfill all images (artists and albums). `shouldStop` is asked before each batch of downloads and before each
 * kind: once it says yes the backfill ends quietly, leaving the rest for the next start.
 */
export async function backfillAllImages(
    { shouldStop = () => false }: { shouldStop?: () => boolean } = {}
): Promise<void> {
    await backfillImages("artist", shouldStop);
    await backfillImages("album", shouldStop);
}
