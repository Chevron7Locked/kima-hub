/**
 * Denormalised Artist counts for filtering without joins: libraryAlbumCount (library albums with a playable song),
 * discoveryAlbumCount (Discover albums with songs), and totalTrackCount (playable songs; Discover songs are not the
 * library's). The scan recounts the artists whose songs it moved (musicScanner.ts), so a file that goes missing or comes
 * back moves them.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { PLAYABLE_ALBUM_WHERE } from "./libraryFilters";
import { PLAYABLE_SONG } from "../utils/playableSong";
import type { StopCheck } from "../utils/stopCheck";

const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 50;
const PROGRESS_EVERY = 500;

/** Whether going from `before` to `after` artists attempted passed a multiple of 500: a progress line is due once per mark, however the batches fall. */
export function crossedProgressMark(before: number, after: number): boolean {
  return Math.floor(after / PROGRESS_EVERY) > Math.floor(before / PROGRESS_EVERY);
}

/** How far a recount is, as a percent: artists attempted (counted or failed) of the total read at the start, never past 100 (artists can arrive mid-run); nothing to recount reads as done. */
function percentAttempted(attempted: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((attempted / total) * 100)) : 100;
}

interface ArtistCounts {
  libraryAlbumCount: number;
  discoveryAlbumCount: number;
  totalTrackCount: number;
}

async function calculateArtistCounts(
  artistId: string
): Promise<ArtistCounts> {
  const [libraryAlbums, discoveryAlbums, trackCount] = await Promise.all([
    prisma.album.count({
      where: { artistId, ...PLAYABLE_ALBUM_WHERE },
    }),
    prisma.album.count({
      where: {
        artistId,
        location: "DISCOVER",
        tracks: { some: {} },
      },
    }),
    prisma.track.count({
      where: { ...PLAYABLE_SONG, album: { ...PLAYABLE_SONG.album, artistId } },
    }),
  ]);

  return {
    libraryAlbumCount: libraryAlbums,
    discoveryAlbumCount: discoveryAlbums,
    totalTrackCount: trackCount,
  };
}

export async function updateArtistCounts(artistId: string): Promise<void> {
  try {
    const counts = await calculateArtistCounts(artistId);

    // updateMany: an artist deleted since it was asked for has no counts to keep.
    await prisma.artist.updateMany({
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

// The recount under way, shared by every caller that asks while it runs. Set in the same tick as the first call, so
// two callers cannot both start one; cleared by the run itself when it ends, whether it succeeded or failed.
let currentRun: Promise<{ processed: number; errors: number }> | null = null;
// A recount asked for while one runs: the running one goes over the artists once more when it finishes.
let recountAsked = false;
// The pass being counted, from 1: a queued extra pass starts from zero under the next number, so a status read never
// sees one pass's progress go backwards.
let backfillProgress = { pass: 0, processed: 0, total: 0, errors: 0 };

export function isBackfillInProgress(): boolean {
  return currentRun !== null;
}

/**
 * `shouldStop` is asked before each batch: once it says yes the pass ends quietly with what it counted, and no extra
 * pass starts.
 *
 * Recounts every artist in small batches with pauses, so it is safe on a running server. Asked for while a recount
 * runs, it waits for that run and answers what it answers (processed, errors, over every pass): the running one goes
 * over the artists once more when it finishes, and any number of asks cost one more pass. The running call keeps its
 * own `onProgress` (artists attempted, failures included, of the total) and stop check.
 */
export function backfillAllArtistCounts(
  onProgress?: (attempted: number, total: number) => void,
  { shouldStop = () => false }: StopCheck = {}
): Promise<{ processed: number; errors: number }> {
  if (currentRun) {
    recountAsked = true;
    logger.debug("[ArtistCounts] Backfill already in progress, will run once more when it finishes");
    return currentRun;
  }

  currentRun = runPasses(onProgress, shouldStop);
  return currentRun;
}

async function runPasses(
  onProgress: ((attempted: number, total: number) => void) | undefined,
  shouldStop: () => boolean
): Promise<{ processed: number; errors: number }> {
  // Yield first, so `currentRun` is set before anything here can end the run and clear it.
  await Promise.resolve();
  const answer = { processed: 0, errors: 0 };
  let pass = 0;

  try {
    do {
      if (shouldStop()) break;
      // Cleared as the pass starts, so an ask made during it earns one more pass.
      recountAsked = false;
      pass += 1;
      const counted = await recountEveryArtist(pass, onProgress, shouldStop);
      answer.processed += counted.processed;
      answer.errors += counted.errors;
    } while (recountAsked);
    return answer;
  } finally {
    currentRun = null;
    recountAsked = false;
  }
}

async function recountEveryArtist(
  pass: number,
  onProgress: ((attempted: number, total: number) => void) | undefined,
  shouldStop: () => boolean
): Promise<{ processed: number; errors: number }> {
  backfillProgress = { pass, processed: 0, total: 0, errors: 0 };

  const total = await prisma.artist.count();
  backfillProgress.total = total;
  let cursor: string | undefined;
  let attemptedAtLastBatch = 0;

  logger.info(`[ArtistCounts] Starting backfill for ${total} artists`);

  while (true) {
    if (shouldStop()) {
      logger.info(`[ArtistCounts] Backfill stopped for shutdown: ${backfillProgress.processed}/${total} counted`);
      return { processed: backfillProgress.processed, errors: backfillProgress.errors };
    }
    // Fetch batch of artists using cursor pagination
    const artists = await prisma.artist.findMany({
      take: BATCH_SIZE,
      // After the last id seen, not from its row: the scan's pruning may delete that artist mid-run.
      where: cursor ? { id: { gt: cursor } } : undefined,
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
    // Failed artists were looked at too: progress is every artist attempted, and the failures are reported beside it.
    const attempted = backfillProgress.processed + backfillProgress.errors;
    if (onProgress) {
      onProgress(attempted, total);
    }

    if (crossedProgressMark(attemptedAtLastBatch, attempted)) {
      const percent = total > 0 ? ` (${percentAttempted(attempted, total)}%)` : "";
      logger.info(`[ArtistCounts] Progress: ${attempted}/${total}${percent}${backfillProgress.errors > 0 ? `, ${backfillProgress.errors} failed` : ""}`);
    }
    attemptedAtLastBatch = attempted;

    // Small delay to avoid overwhelming the database
    await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
  }

  logger.info(
    `[ArtistCounts] Backfill complete: ${backfillProgress.processed} processed, ${backfillProgress.errors} errors`
  );

  return { processed: backfillProgress.processed, errors: backfillProgress.errors };
}

/** Whether any artist has never been counted (countsLastUpdated null). */
export async function isBackfillNeeded(): Promise<boolean> {
  const unprocessed = await prisma.artist.count({
    where: { countsLastUpdated: null },
  });
  return unprocessed > 0;
}

export async function getBackfillProgress(): Promise<{
  processed: number;
  total: number;
  percent: number;
  isRunning: boolean;
  errors: number;
  /** The pass being counted, from 1 (a queued extra pass is the next number); 0 when nothing runs. */
  pass: number;
}> {
  if (currentRun) {
    return {
      processed: backfillProgress.processed,
      total: backfillProgress.total,
      percent: percentAttempted(
        backfillProgress.processed + backfillProgress.errors,
        backfillProgress.total
      ),
      isRunning: true,
      errors: backfillProgress.errors,
      pass: backfillProgress.pass,
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
    pass: 0,
  };
}

