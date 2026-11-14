/**
 * The catch-up work after start-up: the cache warmup, the audiobook sync, the one-time Discover sort, the artist counts,
 * the image backfill and the one-time cover format repair. Each is a start step that logs its own failure, so one that
 * fails does not stop the next.
 * The long ones are handed `shutdownHasBegun` and stop quietly between batches once the server is shutting down.
 *
 * `whenEnded()` is what the shutdown's drain waits on before the close steps run: it resolves once the task under way
 * has ended (a batch already running finishes; the next never starts), so none of them touches the database after it
 * has closed. Work an admin's request started (the backfills, the re-file, the syncs) is awaited the same way: it is
 * tracked by `runAsRequestWork`. The wait is inside the shutdown's deadline.
 */

import { prisma } from "./utils/db";
import { logger } from "./utils/logger";
import { whenRequestWorkEnded } from "./utils/stopCheck";
import type { StartStep } from "./startup";

export interface BackgroundStart {
    /** The five catch-up steps, in order, for `runStartSteps`. */
    steps: StartStep[];
    /** Starts the Redis cache warmup without waiting for it, so the next start step goes on. */
    startCacheWarmup(): void;
    /** Resolves when no catch-up task and no request-started work is running. Never rejects. */
    whenEnded(): Promise<void>;
}

export function createBackgroundStart(shutdownHasBegun: () => boolean): BackgroundStart {
    const running = new Set<Promise<unknown>>();
    function track<T>(task: Promise<T>): Promise<T> {
        running.add(task);
        const forget = () => void running.delete(task);
        task.then(forget, forget);
        return task;
    }

    function startCacheWarmup() {
        // Populates Redis with existing artist images and album covers, so first page loads are instant instead of
        // waiting for cache population.
        track(
            import("./services/dataCache")
                .then(({ dataCacheService }) => dataCacheService.warmupCache({ shouldStop: shutdownHasBegun }))
                .catch((err) => logger.error("Cache warmup failed:", err)),
        );
    }

    async function syncAudiobooksIfEmpty() {
        // Auto-sync audiobooks on startup if cache is empty
        // This prevents "disappeared" audiobooks after container rebuilds
        try {
            const { getSystemSettings } = await import("./utils/systemSettings");
            const settings = await getSystemSettings();
            if (settings?.audiobookshelfEnabled && settings?.audiobookshelfUrl) {
                const cachedCount = await prisma.audiobook.count();
                if (cachedCount === 0) {
                    logger.debug("[STARTUP] Audiobook cache is empty - auto-syncing from Audiobookshelf...");
                    const { audiobookCacheService } = await import("./services/audiobookCache");
                    const result = await audiobookCacheService.syncAll({ shouldStop: shutdownHasBegun });
                    logger.debug(`[STARTUP] Audiobook auto-sync complete: ${result.synced} audiobooks cached`);
                } else {
                    logger.debug(`[STARTUP] Audiobook cache has ${cachedCount} entries - skipping auto-sync`);
                }
            }
        } catch (err) {
            logger.error("[STARTUP] Audiobook auto-sync failed:", err);
        }
    }

    async function sortAlbumsFiledAsDiscover() {
        // Once: albums the old scanner filed as Discover by guesswork go to the library unless Discover's records say
        // otherwise. Before the artist counts, which then count the albums where they now are. One read and one
        // transaction, so there is no batch to stop between.
        try {
            const { sortDiscoverAlbums } = await import("./services/discovery/sortDiscoverAlbums");
            await sortDiscoverAlbums();
        } catch (err) {
            logger.error("[STARTUP] Sorting the albums filed as Discover failed:", err);
        }
    }

    async function backfillArtistCounts() {
        // Auto-backfill artist counts if needed
        try {
            const { isBackfillNeeded, backfillAllArtistCounts } = await import("./services/artistCountsService");
            const needsBackfill = await isBackfillNeeded();
            if (needsBackfill) {
                logger.info("[STARTUP] Artist counts need backfilling, starting in background...");
                const result = await backfillAllArtistCounts(undefined, { shouldStop: shutdownHasBegun });
                logger.info(`[STARTUP] Artist counts backfill complete: ${result.processed} processed, ${result.errors} errors`);
            } else {
                logger.debug("[STARTUP] Artist counts already populated");
            }
        } catch (err) {
            logger.error("[STARTUP] Artist counts backfill failed:", err);
        }
    }

    async function backfillImages() {
        // Auto-backfill images if needed (download external URLs locally)
        try {
            const { isImageBackfillNeeded, backfillAllImages } = await import("./services/imageBackfill");
            const status = await isImageBackfillNeeded();
            if (status.needed) {
                logger.info(`[STARTUP] Image backfill needed: ${status.artistsWithExternalUrls} artists, ${status.albumsWithExternalUrls} albums with external URLs`);
                await backfillAllImages({ shouldStop: shutdownHasBegun });
                logger.info("[STARTUP] Image backfill complete");
            } else {
                logger.debug("[STARTUP] All images already stored locally");
            }
        } catch (err) {
            logger.error("[STARTUP] Image backfill failed:", err);
        }
    }

    async function repairCoverFormats() {
        // Once: covers saved in an older version may hold PNG or WebP bytes under a .jpg name; converted in place,
        // file by file, stopping between files at shutdown.
        try {
            const { repairCoverFormatsOnce } = await import("./services/coverFormatRepair");
            const result = await repairCoverFormatsOnce({ shouldStop: shutdownHasBegun });
            if (result && (result.converted > 0 || result.reversioned > 0 || result.notPictures > 0 || result.failed > 0)) {
                logger.info(
                    `[STARTUP] Cover format repair: ${result.converted} converted, ${result.reversioned} re-versioned, ${result.notPictures} not pictures, ` +
                        `${result.failed} failed${result.stopped ? " (stopped at shutdown)" : ""}`,
                );
            }
        } catch (err) {
            logger.error("[STARTUP] Cover format repair failed:", err);
        }
    }

    async function backfillCoverVersions() {
        // Once: covers stored before addresses carried a version get one, and the scanner's old root-folder covers are
        // filed under albums/. After it no stored value is unversioned.
        try {
            const { backfillCoverVersionsOnce } = await import("./services/coverVersionBackfill");
            const result = await backfillCoverVersionsOnce({ shouldStop: shutdownHasBegun });
            if (result && (result.versioned > 0 || result.audiobooks > 0 || result.failed > 0)) {
                logger.info(
                    `[STARTUP] Cover versions: ${result.versioned} stored covers versioned (${result.moved} filed under albums), ` +
                        `${result.audiobooks} audiobooks, ${result.missing} left (file missing), ${result.failed} failed` +
                        `${result.stopped ? " (stopped at shutdown)" : ""}`,
                );
            }
        } catch (err) {
            logger.error("[STARTUP] Cover version backfill failed:", err);
        }
    }

    const steps: StartStep[] = [
        { name: "audiobook auto-sync", run: () => track(syncAudiobooksIfEmpty()) },
        { name: "sorting albums filed as Discover", run: () => track(sortAlbumsFiledAsDiscover()) },
        { name: "artist counts backfill", run: () => track(backfillArtistCounts()) },
        { name: "image backfill", run: () => track(backfillImages()) },
        { name: "cover format repair", run: () => track(repairCoverFormats()) },
        // After the repair: a file the repair converts is versioned by it, and this versions what is left.
        { name: "cover version backfill", run: () => track(backfillCoverVersions()) },
    ];

    async function whenEnded() {
        // Work started while waiting is awaited too, so loop until both sets are empty.
        do {
            while (running.size > 0) await Promise.allSettled([...running]);
            await whenRequestWorkEnded();
        } while (running.size > 0);
    }

    return { steps, startCacheWarmup, whenEnded };
}
