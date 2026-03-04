/**
 * Artist Counts Service
 *
 * Maintains denormalized counts on the Artist model for fast filtering.
 * These counts enable O(1) library filtering instead of expensive JOINs.
 *
 * Counts maintained:
 * - libraryAlbumCount: Albums with location=LIBRARY that have tracks
 * - discoveryAlbumCount: Albums with location=DISCOVER that have tracks
 * - totalTrackCount: Total tracks across all albums
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 50;

interface ArtistCounts {
  libraryAlbumCount: number;
  discoveryAlbumCount: number;
  totalTrackCount: number;
}

/**
 * Calculate counts for a single artist
 */
async function calculateArtistCounts(
  artistId: string
): Promise<ArtistCounts> {
  const [libraryAlbums, discoveryAlbums, trackCount] = await Promise.all([
    prisma.album.count({
      where: {
        artistId,
        location: "LIBRARY",
        tracks: { some: {} },
      },
    }),
    prisma.album.count({
      where: {
        artistId,
        location: "DISCOVER",
        tracks: { some: {} },
      },
    }),
    prisma.track.count({
      where: {
        album: { artistId },
      },
    }),
  ]);

  return {
    libraryAlbumCount: libraryAlbums,
    discoveryAlbumCount: discoveryAlbums,
    totalTrackCount: trackCount,
  };
}

/**
 * Update counts for a single artist
 */
export async function updateArtistCounts(artistId: string): Promise<void> {
  try {
    const counts = await calculateArtistCounts(artistId);

    await prisma.artist.update({
      where: { id: artistId },
      data: {
        ...counts,
        countsLastUpdated: new Date(),
      },
    });
  } catch (error) {
    logger.error(`[ArtistCounts] Failed to update counts for ${artistId}:`, error);
    throw error;
  }
}

// Track backfill state
let isBackfillRunning = false;
let backfillProgress = { processed: 0, total: 0, errors: 0 };

/**
 * Check if backfill is currently running
 */
export function isBackfillInProgress(): boolean {
  return isBackfillRunning;
}

/**
 * Backfill counts for all artists in batches
 * Safe to run on live systems - processes in small batches with delays
 */
export async function backfillAllArtistCounts(
  onProgress?: (processed: number, total: number) => void
): Promise<{ processed: number; errors: number }> {
  if (isBackfillRunning) {
    logger.warn("[ArtistCounts] Backfill already in progress, skipping");
    return { processed: 0, errors: 0 };
  }

  isBackfillRunning = true;
  backfillProgress = { processed: 0, total: 0, errors: 0 };

  try {
    const total = await prisma.artist.count();
    backfillProgress.total = total;
    let cursor: string | undefined;

    logger.info(`[ArtistCounts] Starting backfill for ${total} artists`);

    while (true) {
      // Fetch batch of artists using cursor pagination
      const artists = await prisma.artist.findMany({
        take: BATCH_SIZE,
        skip: cursor ? 1 : 0,
        cursor: cursor ? { id: cursor } : undefined,
        orderBy: { id: "asc" },
        select: { id: true, name: true },
      });

      if (artists.length === 0) break;

      // Process batch
      for (const artist of artists) {
        try {
          await updateArtistCounts(artist.id);
          backfillProgress.processed++;
        } catch (error) {
          logger.error(
            `[ArtistCounts] Failed to update ${artist.name} (${artist.id}):`,
            error
          );
          backfillProgress.errors++;
        }
      }

      cursor = artists[artists.length - 1].id;

      if (onProgress) {
        onProgress(backfillProgress.processed, total);
      }

      // Log progress every 500 artists
      if (backfillProgress.processed % 500 === 0) {
        logger.info(
          `[ArtistCounts] Progress: ${backfillProgress.processed}/${total} (${Math.round((backfillProgress.processed / total) * 100)}%)`
        );
      }

      // Small delay to avoid overwhelming the database
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    logger.info(
      `[ArtistCounts] Backfill complete: ${backfillProgress.processed} processed, ${backfillProgress.errors} errors`
    );

    return {
      processed: backfillProgress.processed,
      errors: backfillProgress.errors,
    };
  } finally {
    isBackfillRunning = false;
  }
}

/**
 * Check if backfill is needed (any artist has null countsLastUpdated)
 */
export async function isBackfillNeeded(): Promise<boolean> {
  const unprocessed = await prisma.artist.count({
    where: { countsLastUpdated: null },
  });
  return unprocessed > 0;
}

/**
 * Get backfill progress
 */
export async function getBackfillProgress(): Promise<{
  processed: number;
  total: number;
  percent: number;
  isRunning: boolean;
  errors: number;
}> {
  if (isBackfillRunning) {
    return {
      processed: backfillProgress.processed,
      total: backfillProgress.total,
      percent:
        backfillProgress.total > 0
          ? Math.round(
              (backfillProgress.processed / backfillProgress.total) * 100
            )
          : 0,
      isRunning: true,
      errors: backfillProgress.errors,
    };
  }

  const [processed, total] = await Promise.all([
    prisma.artist.count({ where: { countsLastUpdated: { not: null } } }),
    prisma.artist.count(),
  ]);

  return {
    processed,
    total,
    percent: total > 0 ? Math.round((processed / total) * 100) : 100,
    isRunning: false,
    errors: 0,
  };
}

