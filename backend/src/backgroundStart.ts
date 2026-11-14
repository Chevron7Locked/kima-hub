/**
 * The catch-up work after start-up: the audiobook sync, the one-time Discover sort, the artist counts and the image
 * backfill. Each is a start step that logs its own failure, so one that fails does not stop the next. The long ones
 * (the sync, the counts, the backfill) are handed `shutdownHasBegun` and stop quietly between batches once the server
 * is shutting down, so none of them touches the database after it has closed.
 */

import { prisma } from "./utils/db";
import { logger } from "./utils/logger";
import type { StartStep } from "./startup";

export function backgroundStartSteps(shutdownHasBegun: () => boolean): StartStep[] {
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

    return [
        { name: "audiobook auto-sync", run: syncAudiobooksIfEmpty },
        { name: "sorting albums filed as Discover", run: sortAlbumsFiledAsDiscover },
        { name: "artist counts backfill", run: backfillArtistCounts },
        { name: "image backfill", run: backfillImages },
    ];
}
