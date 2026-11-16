/**
 * Image Backfill Service
 *
 * Downloads and stores images locally for existing artists/albums
 * that have external URLs in the database.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { isNativePath, stageDownloadedImage } from "./imageStorage";
import { redisClient } from "../utils/redis";
import { flushShownChanges, notePictureChange } from "./shownChanges";
import { sleepUnlessStopped, stopSignal, type StopCheck } from "../utils/stopCheck";

const PAGE_SIZE = 500;
const BATCH_SIZE = 10;
const DELAY_BETWEEN_BATCHES = 1000; // 1 second

interface BackfillCounts {
    total: number;
    processed: number;
    success: number;
    failed: number;
    skipped: number;
}

interface BackfillProgress extends BackfillCounts {
    inProgress: boolean;
}

let backfillProgress: BackfillCounts = {
    total: 0,
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
};

// Claimed by `backfillAllImages` before its first await, so two callers in the same tick cannot both run.
let running = false;

/**
 * Get current backfill progress
 */
export function getImageBackfillProgress(): BackfillProgress {
    return { ...backfillProgress, inProgress: running };
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

interface BackfillRow {
    id: string;
    label: string;
    url: string | null;
}

/**
 * One page of rows still holding an external URL, after `after` by id. A failed download keeps its URL, so the id
 * cursor (not a skip count) is what keeps a page from repeating.
 */
async function readPage(kind: BackfillKind, after: string | null): Promise<BackfillRow[]> {
    const cursor = after === null ? {} : { id: { gt: after } };
    if (kind === "artist") {
        const artists = await prisma.artist.findMany({
            where: { heroUrl: { not: null, startsWith: "http" }, ...cursor },
            select: { id: true, name: true, heroUrl: true },
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
        });
        return artists.map((a) => ({ id: a.id, label: a.name, url: a.heroUrl }));
    }
    const albums = await prisma.album.findMany({
        where: { coverUrl: { not: null, startsWith: "http" }, ...cursor },
        select: { id: true, title: true, coverUrl: true },
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
    });
    return albums.map((a) => ({ id: a.id, label: a.title, url: a.coverUrl }));
}

function countExternal(kind: BackfillKind): Promise<number> {
    return kind === "artist"
        ? prisma.artist.count({ where: { heroUrl: { not: null, startsWith: "http" } } })
        : prisma.album.count({ where: { coverUrl: { not: null, startsWith: "http" } } });
}

/**
 * One kind's pass, adding to the run's one progress object. Answers whether it went through every row: false when a
 * stop ended it first.
 */
async function backfillImages(kind: BackfillKind, stop: StopCheck, signal: AbortSignal): Promise<boolean> {
    const shouldStop = stop.shouldStop ?? (() => false);
    if (shouldStop()) return false;
    const { noun, cacheKey, cacheTtlSeconds } = BACKFILLS[kind];
    logger.info(`[ImageBackfill] Starting ${kind} ${noun} backfill...`);

    let after: string | null = null;
    for (;;) {
        // Between pages, as between batches: a stop leaves the rest for the next start.
        if (shouldStop()) return false;
        const rows = await readPage(kind, after);
        if (rows.length === 0) break;
        after = rows[rows.length - 1].id;

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            if (shouldStop()) return false;
            const batch = rows.slice(i, i + BATCH_SIZE);

            await Promise.all(
                batch.map(async (row) => {
                    const skipEdited = () => {
                        backfillProgress.skipped++;
                        backfillProgress.processed++;
                    };
                    try {
                        if (!row.url || isNativePath(row.url)) {
                            backfillProgress.skipped++;
                            backfillProgress.processed++;
                            return;
                        }

                        const staged = await stageDownloadedImage(row.url, row.id, kind, signal);

                        if (staged) {
                            const localPath = staged.address;
                            // Only where the row still holds the address that was read: one a person set during the download
                            // stands, and so does any picture stored under the same name. The row stays locked while the file is renamed
                            // into place, so no edit lands between the guard and the rename. If the commit itself then fails, the
                            // new file is in place under the old address: the picture is right, only its cache-bust version is stale.
                            let placed: { own: string | null } | null;
                            try {
                                placed = await prisma.$transaction(async (tx) => {
                                    let own: string | null;
                                    try {
                                        own =
                                            kind === "artist"
                                                ? (await tx.artist.update({ where: { id: row.id, heroUrl: row.url }, data: { heroUrl: localPath }, select: { userHeroUrl: true } })).userHeroUrl
                                                : (await tx.album.update({ where: { id: row.id, coverUrl: row.url }, data: { coverUrl: localPath }, select: { userCoverUrl: true } })).userCoverUrl;
                                    } catch (err) {
                                        // No row holds the address that was read any more.
                                        if ((err as { code?: string }).code === "P2025") return null;
                                        throw err;
                                    }
                                    await staged.publish();
                                    return { own };
                                });
                            } catch (err) {
                                await staged.discard();
                                throw err;
                            }
                            if (!placed) {
                                await staged.discard();
                                return skipEdited();
                            }
                            notePictureChange(kind, row.id, { was: row.url, now: localPath, own: placed.own });

                            // Update Redis cache
                            try {
                                await redisClient.setex(cacheKey(row.id), cacheTtlSeconds, localPath);
                            } catch {
                                // Redis errors non-critical
                            }

                            backfillProgress.success++;
                            logger.debug(`[ImageBackfill] Downloaded ${noun} for ${row.label}`);
                        } else {
                            // A download a stop cut short is neither done nor failed: the next start takes it again.
                            if (signal.aborted) return;
                            backfillProgress.failed++;
                            logger.debug(`[ImageBackfill] Failed to download ${noun} for ${row.label}`);
                        }
                    } catch (error: any) {
                        if (signal.aborted) return;
                        backfillProgress.failed++;
                        logger.debug(`[ImageBackfill] Error processing ${row.label}: ${error.message}`);
                    }

                    backfillProgress.processed++;
                })
            );

            // Delay between batches to avoid rate limiting. A stop ends the pause at once.
            if (i + BATCH_SIZE < rows.length || rows.length === PAGE_SIZE) {
                await sleepUnlessStopped(DELAY_BETWEEN_BATCHES, stop);
            }
        }

        if (rows.length < PAGE_SIZE) break;
    }

    // A download the stop cut short was not done, though no row is left to read.
    return !signal.aborted;
}

/**
 * Backfill all images (artists and albums), one run at a time: a call made while one runs does nothing. The run keeps
 * one progress object, reset when it starts and covering both kinds. `shouldStop` is asked before each page, each batch
 * of downloads and each kind, and cuts the pause between batches short: once it says yes the backfill ends with a
 * "stopped" line carrying its counts, leaving the rest for the next start.
 */
export async function backfillAllImages(stop: StopCheck = {}): Promise<void> {
    if (running) {
        logger.warn("[ImageBackfill] Backfill already in progress");
        return;
    }
    running = true;
    // The signal ends a download under way as soon as the stop comes, rather than after its own 30 s.
    const { signal, release } = stopSignal(stop);
    try {
        // Reset first, so a failed count never leaves the last run's numbers on the status page.
        backfillProgress = { total: 0, processed: 0, success: 0, failed: 0, skipped: 0 };
        const [artists, albums] = await Promise.all([countExternal("artist"), countExternal("album")]);
        backfillProgress.total = artists + albums;
        logger.info(`[ImageBackfill] Found ${artists} artists and ${albums} albums with external URLs`);

        const finished = (await backfillImages("artist", stop, signal)) && (await backfillImages("album", stop, signal));

        const { processed, total, success, failed, skipped } = backfillProgress;
        logger.info(
            finished
                ? `[ImageBackfill] Image backfill complete: ${success} success, ${failed} failed, ${skipped} skipped`
                : `[ImageBackfill] Image backfill stopped for shutdown: ${processed}/${total} done, ${success} success, ${failed} failed, ${skipped} skipped`
        );
    } finally {
        release();
        running = false;
        // The pictures this run moved to local copies reach Subsonic clients as one change of the library.
        await flushShownChanges();
    }
}
