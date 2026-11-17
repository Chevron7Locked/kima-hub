import { randomUUID } from "crypto";
import { config } from "../../config";
import { SpotifyTrack } from "../spotify";
import { logger } from "../../utils/logger";
import { deezerService } from "../deezer";
import { createPlaylistLogger } from "../../utils/playlistLogger";
import { notificationService } from "../notificationService";
import { getSystemSettings } from "../../utils/systemSettings";
import { mayAcquire } from "../../utils/acquirePermission";
import { prisma, Prisma } from "../../utils/db";
import { PLAYABLE_SONG } from "../../utils/playableSong";
import { redisClient } from "../../utils/redis";
import { distributedLock } from "../../utils/distributedLock";
import { LockLostError } from "../../utils/lockErrors";
import PQueue from "p-queue";
import { acquisitionService } from "../acquisitionService";
import * as jobMoves from "../downloads/jobs";
import { normalizeArtistName } from "../artistIdentity";
import { rankForPosition } from "../../utils/lexoRank";
import { placeFoundSongs, type FoundSong } from "../playlistService";
import { requireMusicLink, MusicPlatform } from "../musicLink";
import { eventBus } from "../eventBus";
import { announcePlaylistChange } from "../playlistEvents";
import { nameKey } from "../nameFold";
import type { ImportJob, ImportPreview, AlbumToDownload } from "./types";
import { readMusicLink, musicLinkName, M3UEntry, M3UNothingMatched } from "./reading";
import { previewOfTracklist, pendingTracksOf, matchEntries, matchM3UEntries } from "./matching";
import { failImportJob, jobLoggers, abortImportSearches, importStillOpen, trackImportSearches, untrackImportSearches, stopImportDownloadsAtSource, saveImportJob, updateImportJobFields, recordAlbumProgress, getStoredImportJob, CLOSED_IMPORT_STATES, markBuilding, publishImportJob, announceImportProgress, announceImportCounts, getImportJob, toImportJob, notifyImportFailed, HANDED_OFF_STATES, NOT_WAITING_FOR_DOWNLOADS, recordDownloadsCheck, NOT_SCANNING, newImportJobId, IMPORT_JOB_KEY, IMPORT_JOB_TTL } from "./jobState";

/** Where an import's preview waits for the worker that runs the import. */
const previewKey = (importJobId: string) => `import:preview:${importJobId}`;

/**
 * Keeps an import's preview for the worker that runs it. False, and logged, when it could not be kept: the worker would
 * then find no preview, so the caller does not queue the import.
 */
async function keepPreview(importJobId: string, preview: ImportPreview): Promise<boolean> {
  try {
    await redisClient.setex(previewKey(importJobId), IMPORT_JOB_TTL, JSON.stringify(preview));
    return true;
  } catch (e: any) {
    logger.warn(`[Spotify Import] Failed to cache preview for job ${importJobId}: ${e.message}`);
    return false;
  }
}

const IMPORT_NOT_QUEUED = "The import could not be started because it could not be queued. Try again.";
const PREVIEW_NOT_KEPT = "The import could not be started because its preview could not be saved. Try again.";

/** Thrown inside the playlist transaction when the job no longer takes a playlist, so the transaction rolls back. */
class PlaylistNotWanted extends Error {}

/**
 * A stopped import ends its work quietly, but an error that is not the stop itself (an AbortError) may be a real
 * fault met on the way out, so it is logged with the import's id.
 */
function warnOfErrorAfterStop(importJobId: string, error: unknown): void {
  const { name, code } = (error ?? {}) as { name?: string; code?: string };
  // The stop itself, as fetch, the abort signal and axios each name it.
  if (name === "AbortError" || name === "CanceledError" || code === "ERR_CANCELED") return;
  logger.warn(`[Spotify Import] Job ${importJobId}: stopped, and its work ended with an error:`, error);
}
/** One build of an import at a time, whichever process runs it. */
const IMPORT_BUILD_LOCK_KEY = (id: string) => `import-build:${id}`;
const IMPORT_BUILD_LOCK_TTL_MS = 2 * 60 * 1000;

const PREVIEW_JOB_KEY = (id: string) => `preview:job:${id}`;
const PREVIEW_JOB_TTL = 2 * 60 * 60; // 2 hours
/**
 * A show's extra tracks under another edition of one song ("Song", "SONG", "Song (Live)" apart) are one pick, not two:
 * titles compare by `nameKey`, which folds letter case, accents and apostrophe shapes, so "DON'T STOP" and "Don’t Stop" are
 * the same song. The first of each stays.
 */
export function mergeEditionTracks(tracks: SpotifyTrack[]): SpotifyTrack[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    const key = nameKey(t.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The name a playlist shows before its real name resolves.
const PLAYLIST_HINTS: Record<MusicPlatform, string> = {
  spotify: "Spotify Playlist",
  deezer: "Deezer Playlist",
  youtube: "YouTube Import",
  youtubeMusic: "YouTube Import",
  soundcloud: "SoundCloud Import",
  mixcloud: "Mixcloud Import",
};


/** A failure may still overwrite a failed import (a later, truer reason), but not one that completed or was cancelled. */
const NOT_OVERWRITTEN_BY_FAILURE: ImportJob["status"][] = ["completed", "cancelled"];

class PlaylistImportService {
  async startImport(
    userId: string,
    spotifyPlaylistId: string,
    playlistName: string,
    albumMbidsToDownload: string[],
    preview: ImportPreview,
  ): Promise<ImportJob> {
    const jobId = newImportJobId();

    const jobLogger = createPlaylistLogger(jobId);
    jobLoggers.set(jobId, jobLogger);

    jobLogger.logJobStart(playlistName, preview.summary.total, userId);
    jobLogger.info(`Playlist ID: ${spotifyPlaylistId}`);
    jobLogger.info(`Albums to download: ${albumMbidsToDownload.length}`);
    jobLogger.info(`Tracks already in library: ${preview.summary.inLibrary}`);

    const tracksFromDownloads = preview.albumsToDownload
      .filter((a) =>
        albumMbidsToDownload.includes(a.albumMbid || a.spotifyAlbumId),
      )
      .reduce((sum, a) => sum + a.tracksNeeded.length, 0);

    const pendingTracks = pendingTracksOf(preview);

    const job: ImportJob = {
      id: jobId,
      userId,
      spotifyPlaylistId,
      playlistName,
      status: "pending",
      progress: 0,
      albumsTotal: albumMbidsToDownload.length,
      albumsCompleted: 0,
      tracksMatched: preview.summary.inLibrary,
      tracksTotal: preview.summary.total,
      tracksDownloadable: tracksFromDownloads,
      createdPlaylistId: null,
      error: null,
      sourceUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      pendingTracks,
    };

    await saveImportJob(job);

    // Without its preview the worker could only fail the import later: fail it now, through the normal failure move
    // (the person is told once), and queue nothing.
    if (!(await keepPreview(job.id, preview))) {
      await failImportJob(job.id, PREVIEW_NOT_KEPT);
      return { ...job, status: "failed", error: PREVIEW_NOT_KEPT };
    }

    // Enqueue import job to BullMQ for crash-recoverable processing
    const { importQueue } = await import("../../workers/queues");
    try {
      await importQueue.add("import", {
        importJobId: job.id,
        userId: job.userId,
        albumMbidsToDownload,
      }, {
        jobId: job.id,
      });
    } catch (error) {
      // An import nobody will run is failed now, not left pending for good.
      logger.error(`[Spotify Import] Could not queue job ${job.id}:`, error);
      await failImportJob(job.id, IMPORT_NOT_QUEUED);
      return { ...job, status: "failed", error: IMPORT_NOT_QUEUED };
    }

    jobLogger.info(`[Spotify Import] Enqueued job ${job.id} to BullMQ`);

    return job;
  }

  /**
   * Process the import: download albums through AcquisitionService, then create the playlist.
   */
  private async processImport(
    job: ImportJob,
    albumMbidsToDownload: string[],
    preview: ImportPreview,
  ): Promise<void> {
    const jobLogger = jobLoggers.get(job.id);
    let abortController: AbortController | undefined;

    try {
      // Registered first, so a stop that lands from here on aborts these searches; then the stored status is read, for
      // a stop that came before (the job given here is the copy the worker read when the import was queued).
      abortController = new AbortController();
      const { signal } = abortController;
      trackImportSearches(job.id, abortController);

      try {
        const open = !signal.aborted && (await importStillOpen(job.id));
        if (!open || signal.aborted) {
          jobLogger?.info("[Spotify Import] Job was stopped before downloading started");
          return;
        }

        if (albumMbidsToDownload.length > 0) {
          // Written only while the stored import is open: a stop that landed since the check above stays.
          job.status = "downloading";
          if (!(await updateImportJobFields(job.id, { status: "downloading" }, CLOSED_IMPORT_STATES))) {
            jobLogger?.info("[Spotify Import] Job was stopped before downloading started");
            return;
          }

          jobLogger?.logAlbumDownloadStart(albumMbidsToDownload.length);

          jobLogger?.info(
            `Processing ${albumMbidsToDownload.length} albums via AcquisitionService`,
          );

          // Process albums in parallel with concurrency limit from settings
          const settings = await getSystemSettings();
          const albumQueue = new PQueue({
            concurrency: settings?.soulseekConcurrentDownloads ?? 1,
          });

          signal.addEventListener('abort', () => { albumQueue.clear(); }, { once: true });

          const albumPromises = albumMbidsToDownload.map((albumIdentifier) =>
            albumQueue.add(async () => {
              // Find ALL matching album groups - multiple Spotify album editions
              // may resolve to the same MusicBrainz MBID (e.g., "The Fall of Math"
              // and "The Fall of Math (Deluxe Edition)"). Merge their tracksNeeded.
              const matchingAlbums = preview.albumsToDownload.filter(
                (a) =>
                  a.albumMbid === albumIdentifier ||
                  a.spotifyAlbumId === albumIdentifier,
              );
              if (matchingAlbums.length === 0) return;

              let album: AlbumToDownload;
              if (matchingAlbums.length === 1) {
                album = matchingAlbums[0];
              } else {
                // Merge tracksNeeded, deduplicate by title
                const mergedTracks = mergeEditionTracks(matchingAlbums.flatMap((a) => a.tracksNeeded));
                album = {
                  ...matchingAlbums[0],
                  tracksNeeded: mergedTracks,
                  trackCount: mergedTracks.length,
                };
                jobLogger?.debug(
                  `[Spotify Import] Merged ${matchingAlbums.length} album editions for "${album.albumName}" (${mergedTracks.length} unique tracks)`,
                );
              }

              try {
                const isUnknownAlbum =
                  album.albumName === "Unknown Album";

                jobLogger?.info(
                  `Album start: ${album.artistName} - ${album.albumName}${
                    album.albumMbid
                      ? ` [MBID: ${album.albumMbid}]`
                      : " [Unknown Album]"
                  } (tracksNeeded=${album.tracksNeeded.length})`,
                );

                jobLogger?.debug(
                  `[Spotify Import] Requesting: ${album.artistName} - ${album.albumName}`,
                );

                // Acquisition context for tracking
                const context = {
                  userId: job.userId,
                  spotifyImportJobId: job.id,
                  signal,
                  stillOpen: () => importStillOpen(job.id),
                };

                let result;

                if (isUnknownAlbum) {
                  // Unknown Album: Use track-based acquisition
                  jobLogger?.debug(
                    `[Spotify Import] Unknown Album detected - using track acquisition`,
                  );

                  const trackRequests = album.tracksNeeded.map((track) => ({
                    trackTitle: track.title,
                    artistName: track.artist,
                    albumTitle: album.albumName,
                  }));

                  const trackResults = await acquisitionService.acquireTracks(
                    trackRequests,
                    context,
                  );

                  const successCount = trackResults.filter(
                    (r) => r.success,
                  ).length;
                  const successThreshold = Math.ceil(trackRequests.length * 0.5);

                  result = {
                    success: successCount >= successThreshold,
                    tracksDownloaded: successCount,
                    tracksTotal: trackRequests.length,
                  };

                  if (result.success) {
                    jobLogger?.info(
                      `Unknown Album tracks success: ${album.artistName} - ${successCount}/${trackRequests.length} tracks`,
                    );
                  }
                } else {
                  // Regular album: Use album-based acquisition
                  result = await acquisitionService.acquireAlbum(
                    {
                      albumTitle: album.albumName,
                      artistName: album.artistName,
                      mbid: album.albumMbid || undefined,
                      requestedTracks: album.tracksNeeded.map((t) => ({
                        title: t.title,
                      })),
                    },
                    context,
                  );

                  if (result.success) {
                    jobLogger?.info(
                      `Album acquisition success: ${album.artistName} - ${album.albumName} via ${result.source}`,
                    );
                  }
                }

                if (!result.success) {
                  const errorMsg =
                    result.error || "No download sources available";
                  jobLogger?.debug(
                    `[Spotify Import] ✗ Failed: ${album.albumName} - ${errorMsg}`,
                  );
                  jobLogger?.logAlbumFailed(
                    album.albumName,
                    album.artistName,
                    errorMsg,
                  );
                }

                job.albumsCompleted++;
                job.progress = job.albumsTotal > 0
                  ? Math.round((job.albumsCompleted / job.albumsTotal) * 30)
                  : 0;
                // A stop from another process stays, and the counts never go down: the loop below reads the stored status.
                await recordAlbumProgress(job.id, job.albumsCompleted, job.progress);

                jobLogger?.debug(
                  `Album done: ${album.artistName} - ${
                    album.albumName
                  } (success=${result.success ? "yes" : "no"})`,
                );
              } catch (error: any) {
                if (error?.name === 'AbortError' || signal.aborted) {
                  warnOfErrorAfterStop(job.id, error);
                  return;
                }
                jobLogger?.error(
                  `[Spotify Import] Failed: ${album.artistName} - ${album.albumName}: ${error.message}`,
                );
                jobLogger?.logAlbumFailed(
                  album.albumName,
                  album.artistName,
                  error.message,
                );
              }
            }, { signal }),
          );

          // Wait for all album acquisitions to complete
          await Promise.all(albumPromises);

          jobLogger?.info(
            `Initial acquisition phase finished for ${albumMbidsToDownload.length} album(s). Checking completion state...`,
          );

          // Poll until the job is terminal: Soulseek downloads finish inline, Lidarr's via
          // webhook. Every 15 s for up to 30 min; the short sleeps keep the event loop
          // free for BullMQ's lock renewal.
          const POLL_INTERVAL_MS = 15_000;
          const MAX_WAIT_MS = 30 * 60 * 1000;

          const pollStart = Date.now();

          while (true) {
            if (signal.aborted) {
              jobLogger?.info(`[Spotify Import] Job ${job.id}: aborted during completion poll`);
              return;
            }

            // The stored status decides, not a cached copy: a stop from another process holds here too.
            if (!(await importStillOpen(job.id))) {
              jobLogger?.info(`[Spotify Import] Job ${job.id}: stopped during completion poll`);
              return;
            }

            try {
              await this.checkImportCompletion(job.id);
            } catch (error: any) {
              // A stop is handled by the outer catch. Any other failure (the scan request, say) left the import waiting
              // for its downloads, so the next turn asks again; the 30-minute cap below still bounds it.
              if (error?.name === 'AbortError' || signal.aborted) throw error;
              jobLogger?.warn(`[Spotify Import] Job ${job.id}: completion check failed, trying again next turn: ${error?.message ?? error}`);
              logger.warn(`[Spotify Import] Job ${job.id}: completion check failed, trying again next turn:`, error);
            }

            const stored = await prisma.spotifyImportJob.findUnique({ where: { id: job.id }, select: { status: true } });
            if (!stored) {
              jobLogger?.error(`[Spotify Import] Job ${job.id}: not found during completion poll`);
              return;
            }

            if (HANDED_OFF_STATES.includes(stored.status as ImportJob["status"])) {
              jobLogger?.info(`Import job ${job.id} handed off to next phase: ${stored.status}`);
              return;
            }

            // The last check at the cap is not retried: a failure there ends the import as failed.
            if (Date.now() - pollStart > MAX_WAIT_MS) {
              jobLogger?.warn(`[Spotify Import] Job ${job.id}: timed out after 30 minutes, running final completion check`);
              await this.checkImportCompletion(job.id);
              return;
            }

            jobLogger?.debug(`[Spotify Import] Job ${job.id}: still ${stored.status}, polling again in 15s...`);
            // A stop in this process ends the wait at once and the loop's next turn returns; one from another process is
            // seen by the stored-status check after the wait.
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", done);
                resolve();
              };
              const timer = setTimeout(done, POLL_INTERVAL_MS);
              signal.addEventListener("abort", done);
              if (signal.aborted) done();
            });
          }
        }

        // No downloads needed - all tracks already in library
        await this.buildPlaylist(job);
      } finally {
        untrackImportSearches(job.id);
      }
    } catch (error: any) {
      if (error?.name === 'AbortError' || abortController?.signal.aborted) {
        warnOfErrorAfterStop(job.id, error);
        jobLogger?.info(`[Spotify Import] Job ${job.id}: import cancelled, returning cleanly`);
        return;
      }
      job.status = "failed";
      job.error = error.message;
      job.updatedAt = new Date();
      // The row is what the import page and the worker's failure handler read, so it is written here, and only the
      // person whose import it still is hears of the failure: not one who cancelled it, whose import completed, or who
      // was already told it failed. A write that itself fails is logged: the error that ended the import is the one thrown.
      try {
        if (await updateImportJobFields(job.id, { status: "failed", error: error.message }, CLOSED_IMPORT_STATES)) {
          notifyImportFailed(job);
        }
      } catch (writeError) {
        logger.error(`[Spotify Import] Job ${job.id}: could not record the failure: ${writeError}`);
      }
      throw error;
    }
  }

  /** Whether all of an import's downloads are done (asked by the download manager, the queue cleaner and the poll). */
  async checkImportCompletion(importJobId: string): Promise<void> {

    // The stored import, not a cached copy: one cancelled or handed on in another process is not checked again.
    const job = await getStoredImportJob(importJobId);
    if (!job) {
      logger.debug(`   Job not found`);
      jobLoggers.delete(importJobId);
      return;
    }

    // Past the download phase, or a quick import still fetching: nothing to check yet.
    if (NOT_WAITING_FOR_DOWNLOADS.includes(job.status)) {
      logger.debug(`   Job already in ${job.status} state, skipping`);
      return;
    }

    const jobLogger = jobLoggers.get(importJobId);

    // Download jobs carry this import's id in metadata.spotifyImportJobId
    const downloadJobs = await prisma.downloadJob.findMany({
      where: {
        metadata: {
          path: ["spotifyImportJobId"],
          equals: importJobId,
        },
      },
    });

    const total = downloadJobs.length;
    const completed = downloadJobs.filter((j) => jobMoves.isCompleted(j.status)).length;
    const failed = downloadJobs.filter((j) => jobMoves.isFailed(j.status)).length;
    const pending = total - completed - failed;

    if (total === 0 && job.albumsTotal > 0) {
      const message =
        "No download jobs were created for this import. This usually means the import preview did not include the selected albums.";
      logger.debug(`   ${message}`);
      jobLogger?.warn(message);

      job.status = "failed";
      job.error = message;
      job.updatedAt = new Date();
      // Only the person whose import it still is hears of its failure.
      if (await recordDownloadsCheck(job, { status: "failed", error: message })) notifyImportFailed(job);
      // Clean up job logger to prevent memory leak
      jobLoggers.delete(job.id);
      return;
    }

    logger.debug(
      `   Download status: ${completed}/${total} completed, ${failed} failed, ${pending} pending`,
    );
    jobLogger?.logDownloadProgress(completed, failed, pending);

    job.progress =
      total > 0
        ? 30 + Math.round((completed / total) * 40) // 30-70% for downloads
        : 30;
    job.updatedAt = new Date();

    if (pending > 0) {
      const oldestPending = downloadJobs
        .filter((j) => jobMoves.isActive(j.status))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];

      const waitTimeMs = oldestPending
        ? Date.now() - oldestPending.createdAt.getTime()
        : 0;
      const waitTimeMins = Math.round(waitTimeMs / 60000);

      // After 10 minutes of waiting, proceed anyway to avoid stuck jobs
      if (waitTimeMs < 600000) {
        // 10 minutes
        logger.debug(
          `   Still waiting for ${pending} downloads... (${waitTimeMins} min elapsed)`,
        );
        jobLogger?.info(`Waiting for Soulseek downloads to complete...`);
        await recordDownloadsCheck(job, {});
        return;
      }

      logger.debug(
        `   Timeout: ${pending} downloads still pending after ${waitTimeMins} minutes, proceeding anyway`,
      );
      jobLogger?.warn(
        `Download timeout: ${pending} pending after ${waitTimeMins}m, proceeding with available tracks`,
      );

      await jobMoves.fail(
        downloadJobs.filter((j) => jobMoves.isActive(j.status)),
        "Timed out waiting for download",
      );
    }

    // All downloads finished (completed or failed). Counted again: the timeout settle moved some,
    // and a job another path settled in the meantime counts as what it became.
    const finalStatuses = await prisma.downloadJob.findMany({
      where: { metadata: { path: ["spotifyImportJobId"], equals: importJobId } },
      select: { status: true },
    });
    const finalCompleted = finalStatuses.filter((j) => jobMoves.isCompleted(j.status)).length;
    const finalFailed = finalStatuses.filter((j) => jobMoves.isFailed(j.status)).length;
    logger.debug(`   All downloads finished! Triggering library scan...`);
    jobLogger?.info(
      `All ${finalStatuses.length} download jobs finished (${finalCompleted} completed, ${finalFailed} failed)`,
    );

    // The counting above took time, and the cache read at the top can be older still, so the import is claimed first:
    // a scan is asked for only when this write finds it still waiting, not when it was cancelled, closed or handed on.
    const waitingProgress = job.progress;
    job.status = "scanning";
    job.progress = 75;
    job.updatedAt = new Date();
    if (!(await recordDownloadsCheck(job, { status: "scanning" }))) {
      logger.debug(`   Job is no longer waiting for its downloads, no scan requested`);
      return;
    }

    try {
      const { requestScan } = await import("../../workers/scanRequest");
      const scanResult = await requestScan({
        userId: job.userId,
        source: "spotify-import",
        spotifyImportJobId: importJobId,
      });

      jobLogger?.info(
        scanResult.queued
          ? `Queued library scan (bullJobId=${scanResult.jobId})`
          : `Library scan not re-queued: ${scanResult.reason}`,
      );
    } catch (error) {
      // No scan is coming, so none will move the import on: back to downloading, the only state the claim above
      // comes from (NOT_WAITING_FOR_DOWNLOADS leaves out every other), and the next check asks again.
      await updateImportJobFields(importJobId, { status: "downloading", progress: waitingProgress }, NOT_SCANNING);
      throw error;
    }
  }

  /** Builds the import's playlist once the scan that followed its downloads is done (the scan processor asks). */
  async buildPlaylistAfterScan(importJobId: string): Promise<void> {

    const job = await getImportJob(importJobId);
    if (!job) {
      logger.debug(`   Job not found`);
      jobLoggers.delete(importJobId);
      return;
    }

    // Guard: job already reached a terminal state from a previous scan
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      logger.debug(`   Job already ${job.status}, skipping playlist build`);
      return;
    }

    await this.buildPlaylist(job);
  }

  /** One build per import at a time, across processes: a second one that finds the first running leaves it to finish. */
  async buildPlaylist(job: ImportJob): Promise<void> {
    const lockKey = IMPORT_BUILD_LOCK_KEY(job.id);
    const taken = await distributedLock.acquire(lockKey, IMPORT_BUILD_LOCK_TTL_MS);
    if (taken.outcome === "held") {
      jobLoggers.get(job.id)?.debug(`   Another build of job ${job.id} is running, skipping`);
      return;
    }
    if (taken.outcome === "unavailable") {
      // Nothing retries a build that skipped: with Redis down there is no lock to take, so the build runs, and the
      // link to the playlist is still made once, in its transaction.
      logger.warn(`[Import] Redis is not reachable: building job ${job.id} without its lock`, taken.error);
      await this.buildPlaylistLocked(job);
      return;
    }
    // A build is thousands of rows and a preview lookup per waiting song: the lock is renewed while it runs, and frees
    // within its ttl if the process dies.
    const stopRenewal = taken.lease.keepAlive();
    try {
      await this.buildPlaylistLocked(job, taken.lease.signal);
    } catch (error) {
      if (!(error instanceof LockLostError)) throw error;
      // Another build may hold the lock now. This one stops at its next step; the import is still waiting for its
      // playlist, so that build or the next scan's makes it (the transaction links one playlist only).
      logger.warn(`[Import] The lock of job ${job.id} was lost: this build stopped before making its playlist`);
    } finally {
      stopRenewal();
      await taken.lease.release();
    }
  }

  /** `lock` aborts when the build's lock is lost (none when Redis was down): the steps below stop at their next check. */
  private async buildPlaylistLocked(job: ImportJob, lock?: AbortSignal): Promise<void> {
    const jobLogger = jobLoggers.get(job.id);

    // Guard: playlist already created for this job
    if (job.createdPlaylistId) {
      jobLogger?.debug(`   Playlist already created: ${job.createdPlaylistId}, skipping`);
      jobLoggers.delete(job.id);
      return;
    }

    if (!(await markBuilding(job))) {
      jobLogger?.debug(`   Job ${job.id} is linked to a playlist or closed, skipping`);
      jobLoggers.delete(job.id);
      return;
    }

    lock?.throwIfAborted();
    jobLogger?.logPlaylistCreationStart();
    jobLogger?.logTrackMatchingStart();

    // Verify pre-matched track ids: one that stopped playing since the preview falls through to the matching below.
    const preMatchedIds = job.pendingTracks
      .map((t) => t.preMatchedTrackId)
      .filter((id): id is string => !!id);
    const verifiedPreMatched = preMatchedIds.length > 0
      ? new Map(
          (await prisma.track.findMany({
            where: { AND: [PLAYABLE_SONG, { id: { in: preMatchedIds } }] },
            select: { id: true, title: true },
          })).map((t) => [t.id, t]),
        )
      : new Map<string, { id: string; title: string }>();

    // Matches by ISRC
    const pendingIsrcs = job.pendingTracks
      .filter((t) => t.isrc)
      .map((t) => t.isrc!);
    const isrcMatches = pendingIsrcs.length > 0
      ? new Map(
          (await prisma.track.findMany({
            where: { AND: [PLAYABLE_SONG, { isrc: { in: pendingIsrcs } }] },
            select: { id: true, isrc: true, title: true },
          })).map((t) => [t.isrc!, t]),
        )
      : new Map<string, { id: string; isrc: string; title: string }>();

    // One entry per listing that matched, with its place (1-based) in the original Spotify order. A song the source
    // lists twice matches twice and the playlist holds it twice.
    const matchedEntries: Array<{ trackId: string; position: number }> = [];
    const unmatched: Array<{ pendingTrack: typeof job.pendingTracks[number]; position: number }> = [];

    const noMatch = (pendingTrack: typeof job.pendingTracks[number], position: number) => {
      jobLogger?.debug(`   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist}`);
      jobLogger?.logTrackMatch(position, job.tracksTotal, pendingTrack.title, pendingTrack.artist, false);
    };

    // What the preview or the song's recording already settled comes first; only the rest goes through the ladder.
    for (const [at, pendingTrack] of job.pendingTracks.entries()) {
      const position = at + 1;

      if (pendingTrack.preMatchedTrackId) {
        const existingTrack = verifiedPreMatched.get(pendingTrack.preMatchedTrackId);
        if (existingTrack) {
          matchedEntries.push({ trackId: existingTrack.id, position });
          jobLogger?.debug(
            `   ✓ Pre-matched: "${pendingTrack.title}" -> track ${existingTrack.id}`,
          );
          jobLogger?.logTrackMatch(
            position, job.tracksTotal, pendingTrack.title, pendingTrack.artist, true, existingTrack.id,
          );
          continue;
        }
      }

      if (pendingTrack.isrc) {
        const isrcMatch = isrcMatches.get(pendingTrack.isrc);
        if (isrcMatch) {
          matchedEntries.push({ trackId: isrcMatch.id, position });
          jobLogger?.debug(`   ISRC match: "${pendingTrack.title}" -> ${isrcMatch.id}`);
          jobLogger?.logTrackMatch(position, job.tracksTotal, pendingTrack.title, pendingTrack.artist, true, isrcMatch.id);
          continue;
        }
      }

      unmatched.push({ pendingTrack, position });
    }

    const matches = await matchEntries(unmatched.map((u) => u.pendingTrack), { titleReads: "together" });
    for (const [at, { pendingTrack, position }] of unmatched.entries()) {
      const match = matches[at];
      if (!match) {
        noMatch(pendingTrack, position);
        continue;
      }
      matchedEntries.push({ trackId: match.candidate.id, position });
      jobLogger?.debug(
        `   ✓ Matched${match.via === "title" ? " by title alone" : ""}: "${pendingTrack.title}" -> track ${match.candidate.id} (${match.matchType} ${match.confidence}%)`,
      );
      jobLogger?.logTrackMatch(position, job.tracksTotal, pendingTrack.title, pendingTrack.artist, true, match.candidate.id);
    }

    // The playlist's order is the source's order, whichever step matched the listing.
    matchedEntries.sort((x, y) => x.position - y.position);
    jobLogger?.debug(
      `   Matched ${matchedEntries.length}/${job.tracksTotal} tracks`,
    );
    jobLogger?.info(
      `Matched tracks after scan: ${matchedEntries.length}/${job.tracksTotal}`,
    );

    // What did not match waits: the listings the matcher recorded no position for, one for one.
    const matchedPositions = new Set(matchedEntries.map((e) => e.position));
    const pendingTracksToSave = job.pendingTracks
      .map((track, index) => ({ ...track, originalIndex: index }))
      .filter((track) => !matchedPositions.has(track.originalIndex + 1));

    // The preview lookups below are the long step: not started for a build that lost its lock.
    lock?.throwIfAborted();
    let waitingEntries: Array<Omit<Prisma.PlaylistPendingTrackCreateManyInput, "playlistId">> = [];
    if (pendingTracksToSave.length > 0) {
      jobLogger?.debug(
        `   Saving ${pendingTracksToSave.length} pending tracks for future auto-matching`,
      );
      jobLogger?.debug(`   Fetching Deezer preview URLs for pending tracks...`);
      jobLogger?.info(`Saving pending tracks: ${pendingTracksToSave.length}`);

      // Fetch Deezer previews with concurrency limit to avoid overwhelming API
      const DEEZER_PREVIEW_CONCURRENCY = 5;
      const previewQueue = new PQueue({
        concurrency: DEEZER_PREVIEW_CONCURRENCY,
      });

      const pendingTracksWithPreviews = await Promise.all(
        pendingTracksToSave.map((track) =>
          previewQueue.add(async () => {
            let deezerPreviewUrl: string | null = null;
            try {
              deezerPreviewUrl = await deezerService.getTrackPreview(
                track.artist,
                track.title,
              );
            } catch {
              // Preview not critical, continue without it
            }
            return {
              ...track,
              deezerPreviewUrl,
            };
          }),
        ),
      );

      const previewsFound = pendingTracksWithPreviews.filter(
        (t) => t.deezerPreviewUrl,
      ).length;
      jobLogger?.info(
        `Pending previews found: ${previewsFound}/${pendingTracksToSave.length}`,
      );

      waitingEntries = pendingTracksWithPreviews.map((track) => ({
        spotifyArtist: track.artist,
        spotifyTitle: track.title,
        spotifyAlbum: track.album,
        albumMbid: track.albumMbid,
        artistMbid: track.artistMbid,
        deezerPreviewUrl: track.deezerPreviewUrl,
        isrc: track.isrc || null,
        sort: track.originalIndex,
        rank: rankForPosition(track.originalIndex),
      }));
    }

    lock?.throwIfAborted();
    // The playlist, its songs, its waiting entries and the job's link to it commit together. A scan or a dismissal that
    // finds the playlist finds its job, with counts that match the entries, and nothing here writes over them afterwards.
    const playlist = await prisma.$transaction(
      async (tx) => {
        const made = await tx.playlist.create({
          data: {
            userId: job.userId,
            name: job.playlistName,
            isPublic: false,
            spotifyPlaylistId: job.spotifyPlaylistId,
            items:
              matchedEntries.length > 0
                ? {
                    create: matchedEntries.map(({ trackId, position }, index) => ({
                      trackId,
                      sort: index,
                      // Rank from the listing's ORIGINAL Spotify position (0-based), the
                      // same scale the pending tracks use, so the two interleave into the
                      // playlist's real order rather than forming two sequences.
                      rank: rankForPosition(position - 1),
                    })),
                  }
                : undefined,
          },
        });
        if (waitingEntries.length > 0) {
          await tx.playlistPendingTrack.createMany({
            data: waitingEntries.map((entry) => ({ ...entry, playlistId: made.id })),
          });
        }
        // Only a job still waiting for its playlist takes the link: one another build already linked, one a person
        // cancelled (its row is gone) or one that failed takes none, and this build's playlist is rolled back.
        const linked = await tx.spotifyImportJob.updateMany({
          where: { id: job.id, createdPlaylistId: null, status: { notIn: CLOSED_IMPORT_STATES } },
          data: {
            createdPlaylistId: made.id,
            tracksMatched: matchedEntries.length,
            status: "completed",
            progress: 100,
            updatedAt: new Date(),
          },
        });
        if (linked.count === 0) throw new PlaylistNotWanted();
        return made;
      },
      // A long playlist is thousands of rows: well past the default five seconds.
      { timeout: 60_000, maxWait: 10_000 },
    ).catch((error: unknown) => {
      if (error instanceof PlaylistNotWanted) return null;
      throw error;
    });
    if (!playlist) {
      jobLogger?.debug(`   Job ${job.id} no longer wants a playlist (cancelled, failed or already built), skipping`);
      jobLoggers.delete(job.id);
      return;
    }

    job.createdPlaylistId = playlist.id;
    job.tracksMatched = matchedEntries.length;
    job.status = "completed";
    job.progress = 100;
    job.updatedAt = new Date();
    announcePlaylistChange(job.userId, playlist.id);
    // The cache and the open page get the row as the database holds it, not this copy of the job.
    await publishImportJob(job.id);

    if (waitingEntries.length > 0) {
      // Auto-retry: attempt per-track Soulseek download for unmatched tracks
      // This runs in the background - tracks will be reconciled on next scan
      this.autoRetryPendingTracks(job, pendingTracksToSave).catch((err) => {
        jobLogger?.debug(`Auto-retry error: ${err.message}`);
      });
    }

    jobLogger?.logPlaylistCreated(
      playlist.id,
      matchedEntries.length,
      job.tracksTotal,
    );
    jobLogger?.logJobComplete(
      matchedEntries.length,
      job.tracksTotal,
      playlist.id,
    );

    try {
      await notificationService.notifyImportComplete(
        job.userId,
        job.playlistName,
        playlist.id,
        matchedEntries.length,
        job.tracksTotal,
      );
    } catch (notifError) {
      jobLogger?.error(`Failed to send import notification: ${notifError}`);
    }

    jobLoggers.delete(job.id);
  }

  /** Whether the user an import belongs to may start downloads (#238); a deleted user may not. */
  private async importerMayAcquire(userId: string): Promise<boolean> {
    const importer = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return importer !== null && (await mayAcquire(importer));
  }

  /**
   * Auto-retry unmatched tracks via per-track Soulseek search.
   * Runs in the background after playlist creation. Downloaded tracks
   * will be added to the playlist via reconcilePendingTracks on next scan.
   */
  private async autoRetryPendingTracks(
    job: ImportJob,
    pendingTracks: Array<{
      artist: string;
      title: string;
      album: string;
      albumMbid: string | null;
      artistMbid: string | null;
    }>,
  ): Promise<void> {
    const jobLogger = jobLoggers.get(job.id);

    // Searching and downloading is acquisition (#238); for anyone else the songs stay pending for an operator to retry.
    if (!(await this.importerMayAcquire(job.userId))) {
      jobLogger?.debug(`Auto-retry: this user may not start downloads; ${pendingTracks.length} song(s) stay pending`);
      return;
    }

    const { soulseekService } = await import("../soulseek");
    if (!soulseekService.isConnected()) {
      jobLogger?.debug(`Auto-retry: Soulseek not connected, skipping`);
      return;
    }


    jobLogger?.info(
      `Auto-retrying ${pendingTracks.length} unmatched track(s) via per-track search...`,
    );

    let downloadedCount = 0;

    // A song listed twice is fetched once; each waiting entry still joins the playlist when the scan finds it.
    const fetched = new Set<string>();
    for (const track of pendingTracks) {
      const key = `${normalizeArtistName(track.artist)}|${track.title.toLowerCase()}`;
      if (fetched.has(key)) continue;
      fetched.add(key);
      try {
        const searchResult = await soulseekService.searchTrack(
          track.artist,
          track.title,
          track.album !== "Unknown Album" ? track.album : undefined,
        );

        if (!searchResult.found || searchResult.allMatches.length === 0) {
          jobLogger?.debug(
            `Auto-retry: No results for "${track.title}" by ${track.artist}`,
          );
          continue;
        }

        const albumName =
          track.album !== "Unknown Album" ? track.album : track.artist;
        const result = await soulseekService.downloadBestMatch(
          track.artist,
          track.title,
          albumName,
          searchResult.allMatches,
          config.music.musicPath,
        );

        if (result.success) {
          downloadedCount++;
          jobLogger?.info(
            `Auto-retry: Downloaded "${track.title}" by ${track.artist}`,
          );
        } else {
          jobLogger?.debug(
            `Auto-retry: Download failed for "${track.title}": ${result.error}`,
          );
        }
      } catch (err: any) {
        jobLogger?.debug(
          `Auto-retry: Error for "${track.title}": ${err.message}`,
        );
      }
    }

    if (downloadedCount > 0) {
      // Trigger library scan - reconcilePendingTracks will add them to the playlist
      const { requestScan } = await import("../../workers/scanRequest");
      await requestScan({
        userId: job.userId,
        source: "retry-pending-track",
        priority: 1,
        removeOnComplete: true,
      });
      jobLogger?.info(
        `Auto-retry: ${downloadedCount}/${pendingTracks.length} track(s) downloaded, scan queued`,
      );
    } else {
      jobLogger?.debug(`Auto-retry: No tracks downloaded`);
    }
  }

  /**
   * The songs the library now has for waiting entries, each tied to the entry it answers. Scans and refreshes both
   * match this way (the import's own ladder, playlistImport/matching), and an entry is its own listing: a song the
   * playlist already holds does not answer it.
   */
  private async matchWaitingEntries(
    waiting: Array<{ id: string; spotifyArtist: string; spotifyTitle: string }>,
  ): Promise<FoundSong[]> {
    if (waiting.length === 0) return [];
    const matches = await matchEntries(
      waiting.map((w) => ({ title: w.spotifyTitle, artist: w.spotifyArtist })),
      { titleReads: "each" },
    );
    const found: FoundSong[] = [];
    for (const [at, entry] of waiting.entries()) {
      const match = matches[at];
      if (!match) continue;
      found.push({ trackId: match.candidate.id, pendingId: entry.id });
      logger.debug(`   ✓ Matched: "${entry.spotifyTitle}" by ${entry.spotifyArtist}`);
    }
    return found;
  }

  /**
   * Re-match pending tracks and add newly downloaded ones to the playlist
   */
  async refreshJobMatches(
    jobId: string,
  ): Promise<{ added: number; total: number }> {
    const jobLogger = jobLoggers.get(jobId);
    const job = await getImportJob(jobId);
    if (!job) {
      throw new Error("Import job not found");
    }
    if (!job.createdPlaylistId) {
      throw new Error("No playlist created for this job");
    }

    // Each waiting entry is its own listing, answered by a song the library now has: a song the playlist already holds
    // from elsewhere does not cover it, and an entry the person removed is not waiting, so it is not brought back.
    const waitingNow = await prisma.playlistPendingTrack.findMany({
      where: { playlistId: job.createdPlaylistId },
      orderBy: { rank: "asc" },
    });

    const found = await this.matchWaitingEntries(waitingNow);

    const placed = await placeFoundSongs(job.createdPlaylistId, found);
    const added = placed.length;
    if (added > 0) announcePlaylistChange(job.userId, job.createdPlaylistId);

    // The songs were counted by placeFoundSongs, in the same locked step that placed them. The job loaded above may
    // be older than a dismissal or another refresh that ran meanwhile, so it is never written back: the counts are read
    // again and announced as they now stand.
    const current = (await getImportJob(jobId)) ?? job;
    if (added > 0) announceImportProgress(current);

    jobLogger?.debug(
      `[Spotify Import] Refresh job ${jobId}: added ${added} newly downloaded tracks`,
    );
    jobLogger?.info(
      `Refresh: added ${added} newly downloaded track(s), totalMatchedNow=${current.tracksMatched}`,
    );

    return { added, total: current.tracksMatched };
  }

  async getUserJobs(userId: string): Promise<ImportJob[]> {
    // Get from database to include jobs across restarts
    // A cancelled import is one whose removal has not finished (a finished cancel deletes the row): the stuck-work
    // check finishes it, and the person, who cancelled it, does not see it meanwhile.
    const dbJobs = await prisma.spotifyImportJob.findMany({
      where: { userId, status: { not: "cancelled" } },
      orderBy: { createdAt: "desc" },
    });

    return dbJobs.map(toImportJob);
  }

  /**
   * Remove all DB and Redis artifacts for an import job.
   * Does NOT touch downloaded files on disk (those become part of the library). Downloads still pending or processing
   * are stopped at Lidarr first (`stopImportDownloadsAtSource`), so nothing goes on fetching for a removed import.
   */
  private async cleanupImportArtifacts(jobId: string): Promise<void> {
    await stopImportDownloadsAtSource(jobId);

    // The import is closed by now (cancelled or failed): the rows go first, through the download module's own removal,
    // in this import's lane after the completion checks already queued for it have read them. A completion check that
    // finds a closed import has nothing to tell. If the removal fails, the import row is still there, closed, for the
    // next cancel to finish. The removal does not wait for the rows.
    const downloads = await prisma.downloadJob.findMany({
      where: { metadata: { path: ["spotifyImportJobId"], equals: jobId } },
      select: { id: true },
    });
    await jobMoves.remove(downloads);

    try {
      await prisma.spotifyImportJob.delete({ where: { id: jobId } });
    } catch (err: any) {
      // May already be deleted or not yet persisted
      if (err.code !== "P2025") throw err;
    }

    try {
      await redisClient.del(IMPORT_JOB_KEY(jobId));
      await redisClient.del(previewKey(jobId));
    } catch (error) {
      // Non-critical: the keys expire on their own.
      logger.warn(`Could not remove import ${jobId} from Redis:`, error);
    }

    // Clean up job logger
    jobLoggers.delete(jobId);
  }

  /**
   * Cancel an import job.
   * Aborts all in-flight work and removes all DB/Redis traces of the import.
   */
  async cancelJob(jobId: string): Promise<{
    playlistCreated: boolean;
    playlistId: string | null;
    tracksMatched: number;
  }> {
    // The stored status decides, not the cached copy `getImportJob` may hand back: a cancel that went by a stale copy
    // could clean away an import that has completed. An import only the cache knows (not yet stored) is still cancelled.
    const stored = await prisma.spotifyImportJob.findUnique({ where: { id: jobId } });
    if (!stored && !(await getImportJob(jobId))) {
      throw new Error("Import job not found");
    }

    const jobLogger = jobLoggers.get(jobId);
    jobLogger?.debug(`[Spotify Import] Cancelling job ${jobId}...`);
    jobLogger?.info(`Job cancelled by user`);

    // If already completed, nothing to undo
    if (stored?.status === "completed") {
      return {
        playlistCreated: !!stored.createdPlaylistId,
        playlistId: stored.createdPlaylistId || null,
        tracksMatched: stored.tracksMatched,
      };
    }

    // If already cancelled or failed, just ensure cleanup
    if (stored?.status === "cancelled" || stored?.status === "failed") {
      await this.cleanupImportArtifacts(jobId);
      return { playlistCreated: false, playlistId: null, tracksMatched: 0 };
    }

    // Closed first, by a move that only a still-open import accepts: an import that completed since it was read keeps
    // its result and its downloads. The move aborts this process's searches and announces "cancelled" to the page.
    if (!(await updateImportJobFields(jobId, { status: "cancelled", error: null }, CLOSED_IMPORT_STATES))) {
      const now = await prisma.spotifyImportJob.findUnique({ where: { id: jobId } });
      if (now?.status === "completed") {
        return {
          playlistCreated: !!now.createdPlaylistId,
          playlistId: now.createdPlaylistId || null,
          tracksMatched: now.tracksMatched,
        };
      }
      // Failed or cancelled by someone else meanwhile, or already gone: only the cleanup is left.
    }

    // Full cleanup -- remove all traces from DB and Redis
    await this.cleanupImportArtifacts(jobId);

    jobLogger?.info(`Import cancelled by user — all artifacts removed`);

    return {
      playlistCreated: false,
      playlistId: null,
      tracksMatched: 0,
    };
  }

  /** Add the pending tracks that now match the library: every playlist's after a scan, or one playlist's when named. */
  async reconcilePendingTracks(playlistId?: string): Promise<{
    playlistsUpdated: number;
    tracksAdded: number;
  }> {

    const allPendingTracks = await prisma.playlistPendingTrack.findMany({
      where: playlistId ? { playlistId } : {},
      include: {
        playlist: {
          select: {
            id: true,
            name: true,
            userId: true,
          },
        },
      },
      orderBy: [{ playlistId: "asc" }, { rank: "asc" }],
    });

    if (allPendingTracks.length === 0) {
      logger.debug(`   No pending tracks to reconcile`);
      return { playlistsUpdated: 0, tracksAdded: 0 };
    }

    logger.debug(
      `   Found ${allPendingTracks.length} pending tracks across playlists`,
    );

    let totalTracksAdded = 0;
    let playlistsUpdated = 0;
    // Group by playlist for efficient processing
    const tracksByPlaylist = new Map<string, typeof allPendingTracks>();
    for (const pt of allPendingTracks) {
      const existing = tracksByPlaylist.get(pt.playlistId) || [];
      existing.push(pt);
      tracksByPlaylist.set(pt.playlistId, existing);
    }

    // One playlist failing does not stop the rest: each is placed, announced and notified on its own.
    for (const [playlistId, pendingTracks] of tracksByPlaylist) {
      let placed: FoundSong[];
      try {
        const found = await this.matchWaitingEntries(pendingTracks);
        // Each found song takes its waiting entry's place; one another scan already placed is not added twice.
        placed = await placeFoundSongs(playlistId, found);
      } catch (err) {
        logger.error(`   Could not reconcile pending tracks of playlist ${playlistId}:`, err);
        continue;
      }
      if (placed.length === 0) continue;

      totalTracksAdded += placed.length;
      playlistsUpdated++;

      const { playlist } = pendingTracks[0];
      try {
        announcePlaylistChange(playlist.userId, playlist.id);
        await announceImportCounts(playlist.id);
        await notificationService.create({
          userId: playlist.userId,
          type: "playlist_ready",
          title: "Playlist Updated",
          message: `${placed.length} new track${placed.length !== 1 ? "s" : ""} added to "${playlist.name}"`,
          metadata: {
            playlistId: playlist.id,
            tracksAdded: placed.length,
          },
        });
      } catch (err) {
        logger.error(`   Could not announce or notify about playlist ${playlist.id}:`, err);
      }
    }

    logger.debug(
      `   Reconciliation complete: ${totalTracksAdded} tracks added to ${playlistsUpdated} playlists`,
    );

    return {
      playlistsUpdated,
      tracksAdded: totalTracksAdded,
    };
  }

  /**
   * Start a background preview job and return the job ID immediately.
   * Progress and completion are broadcast via SSE (preview:progress / preview:complete).
   */
  async startPreviewJob(url: string, userId: string): Promise<{ jobId: string }> {
    const jobId = randomUUID();

    (async () => {
      try {
        eventBus.emit({
          type: "preview:progress",
          userId,
          payload: { jobId, phase: "fetching", message: "Fetching playlist..." },
        });

        const emitFetchProgress = (fetched: number, total: number) => {
          eventBus.emit({
            type: "preview:progress",
            userId,
            payload: { jobId, phase: "fetching", message: `Fetching tracks: ${fetched.toLocaleString()} of ${total.toLocaleString()}...` },
          });
        };

        const link = requireMusicLink(url);

        const tracklist = await readMusicLink(link, {
          onFetchProgress: emitFetchProgress,
          onStage: (stage) => {
            eventBus.emit({
              type: "preview:progress",
              userId,
              payload: {
                jobId,
                phase: "matching",
                message: stage === "resolving" ? "Resolving tracks via song.link..." : "Matching tracks to library...",
              },
            });
          },
        });
        const preview = await previewOfTracklist(tracklist);

        await redisClient.setex(
          PREVIEW_JOB_KEY(jobId),
          PREVIEW_JOB_TTL,
          JSON.stringify({ status: "completed", preview, userId }),
        ).catch((e) => logger.error("[Preview Job] Failed to persist result to Redis:", e));

        eventBus.emit({
          type: "preview:complete",
          userId,
          payload: { jobId, preview },
        });
      } catch (error: any) {
        logger.error("[Preview Job] Failed:", error);
        const isNetworkError = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(error.code);
        const userMessage = isNetworkError
            ? "Service temporarily unavailable. Please try again in a moment."
            : (error.message || "Import failed");
        await redisClient.setex(
          PREVIEW_JOB_KEY(jobId),
          PREVIEW_JOB_TTL,
          JSON.stringify({ status: "failed", error: userMessage, userId }),
        ).catch((e) => logger.error("[Preview Job] Failed to persist error state to Redis:", e));
        eventBus.emit({
          type: "preview:complete",
          userId,
          payload: { jobId, error: userMessage },
        });
      }
    })().catch((e) => logger.error("[Preview Job] Unhandled:", e));

    return { jobId };
  }

  async getPreviewResult(jobId: string): Promise<{ status: string; preview?: ImportPreview; error?: string; userId?: string } | null> {
    try {
      const raw = await redisClient.get(PREVIEW_JOB_KEY(jobId));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      // A failed cache read counts as no preview yet.
      return null;
    }
  }

  /**
   * Import an M3U playlist, matching entries by file path, then filename, then
   * exact EXTINF artist and title, then fuzzy metadata (0.6 title + 0.4 artist >= 80; see bestTitleScore). The
   * metadata tiers read the name a person edited an artist or song to as well as the stored one. A file in which no
   * entry matches makes no playlist: it throws M3UNothingMatched, after telling the owner.
   */
  async importFromM3U(
    userId: string,
    playlistName: string,
    entries: M3UEntry[],
  ): Promise<{ playlistId: string; matched: number; unmatched: number; total: number }> {
    const found = await matchM3UEntries(entries);
    const matchedTrackIds = found.flatMap((track) => (track ? [track.id] : []));

    // Nothing in the file is in the library: an empty playlist helps nobody, so none is made and the owner is told
    // the way a failed playlist import tells them.
    if (matchedTrackIds.length === 0) {
      const failure = new M3UNothingMatched(entries.length);
      await notificationService
        .notifyImportFailed(userId, `m3u-${randomUUID()}`, playlistName, failure.message, "/playlists")
        .catch((e) => logger.error("[M3U Import] failure notification failed:", e));
      throw failure;
    }

    // One item per matched line, in file order: a song the file lists twice is held twice.
    const playlist = await prisma.playlist.create({
      data: {
        userId,
        name: playlistName,
        isPublic: false,
        items: {
          create: matchedTrackIds.map((trackId, index) => ({
            trackId,
            sort: index,
            rank: rankForPosition(index),
          })),
        },
      },
    });

    logger.info(
      `[M3U Import] Created playlist "${playlistName}" (${playlist.id}): ${matchedTrackIds.length}/${entries.length} matched`,
    );
    announcePlaylistChange(userId, playlist.id);

    return {
      playlistId: playlist.id,
      matched: matchedTrackIds.length,
      unmatched: entries.length - matchedTrackIds.length,
      total: entries.length,
    };
  }

  /**
   * Process an import job from the BullMQ worker.
   * Loads the job and cached preview from Redis/DB, then delegates to processImport.
   */
  async processImportFromQueue(importJobId: string, albumMbidsToDownload: string[]): Promise<void> {
    const job = await getImportJob(importJobId);
    if (!job) throw new Error(`Import job ${importJobId} not found`);

    // Retrieve cached preview from Redis
    let preview: ImportPreview | null = null;
    try {
      const cached = await redisClient.get(previewKey(importJobId));
      if (cached) preview = JSON.parse(cached);
    } catch (e: any) {
      logger.warn(`[Spotify Import] Failed to read preview cache for job ${importJobId}: ${e.message}`);
    }

    if (!preview) {
      throw new Error(`Preview not found for import job ${importJobId}`);
    }

    const jobLogger = createPlaylistLogger(importJobId);
    jobLoggers.set(importJobId, jobLogger);

    try {
      // Permission was checked when the import was queued; it may have been withdrawn since (#238).
      let albums = albumMbidsToDownload;
      if (albums.length > 0 && !(await this.importerMayAcquire(job.userId))) {
        jobLogger.info(`[Spotify Import] Downloads are no longer allowed for this user; importing without the ${albums.length} album(s)`);
        albums = [];
        job.albumsTotal = 0;
      }
      await this.processImport(job, albums, preview);
    } finally {
      jobLoggers.delete(importJobId);
    }
  }

  /**
   * Quick import: skip preview, enqueue everything for background processing.
   * Returns immediately with a jobId.
   */
  async quickImport(
    url: string,
    userId: string,
    playlistName?: string,
  ): Promise<{ jobId: string }> {
    // Normalize URL for dedup (strip query params, trailing slashes, keep host)
    let normalizedUrl: string;
    try {
      const parsed = new URL(url);
      normalizedUrl = parsed.host + parsed.pathname.replace(/\/+$/, "");
    } catch {
      normalizedUrl = url;
    }

    const existingJobs = await this.getUserJobs(userId);
    const activeStatuses = ["pending", "fetching", "downloading", "scanning", "creating_playlist"];
    const activeJob = existingJobs.find(
      (j) => activeStatuses.includes(j.status) && j.sourceUrl === normalizedUrl,
    );
    if (activeJob) {
      return { jobId: activeJob.id };
    }

    const jobId = newImportJobId();

    const link = requireMusicLink(url);

    // Fetch the real playlist name if not provided (lightweight API call)
    let resolvedName = playlistName;
    if (!resolvedName) {
      try {
        resolvedName = await musicLinkName(link);
      } catch {
        // Non-critical -- fall back to hint
      }
    }

    const job: ImportJob = {
      id: jobId,
      userId,
      spotifyPlaylistId: "",
      playlistName: resolvedName || PLAYLIST_HINTS[link.platform],
      status: "pending",
      progress: 0,
      albumsTotal: 0,
      albumsCompleted: 0,
      tracksMatched: 0,
      tracksTotal: 0,
      tracksDownloadable: 0,
      createdPlaylistId: null,
      error: null,
      sourceUrl: normalizedUrl,
      createdAt: new Date(),
      updatedAt: new Date(),
      pendingTracks: [],
    };

    await saveImportJob(job);

    const { importQueue } = await import("../../workers/queues");
    await importQueue.add("import", {
      importJobId: jobId,
      userId,
      quickImport: true,
      url,
      playlistName,
    }, {
      jobId,
    });

    logger.info(`[Quick Import] Enqueued job ${jobId} for ${url}`);
    return { jobId };
  }

  /**
   * Process a quick import from the BullMQ worker.
   * Fetches playlist, matches library, auto-selects all downloadable albums,
   * then delegates to processImport().
   */
  async processQuickImportFromQueue(
    importJobId: string,
    url: string,
    playlistNameOverride?: string,
  ): Promise<void> {
    const job = await getImportJob(importJobId);
    if (!job) throw new Error(`Import job ${importJobId} not found`);

    const jobLogger = createPlaylistLogger(importJobId);
    jobLoggers.set(importJobId, jobLogger);

    try {
      // Every write here leaves an import that was stopped meanwhile (the worker and the API run apart in the split
      // image), and the import ends where it finds that.
      job.status = "fetching";
      if (!(await updateImportJobFields(importJobId, { status: "fetching" }, CLOSED_IMPORT_STATES))) {
        jobLogger.info("[Quick Import] Job was stopped before fetching started");
        return;
      }

      jobLogger.info(`[Quick Import] Fetching playlist from ${url}`);

      const link = requireMusicLink(url);

      const preview = await previewOfTracklist(await readMusicLink(link));

      // The stored status shows a stop during the fetch phase
      if (!(await importStillOpen(importJobId))) {
        jobLogger.info("[Quick Import] Job stopped during fetch phase");
        return;
      }

      const resolvedName = playlistNameOverride || preview.playlist.name;
      job.playlistName = resolvedName;
      job.spotifyPlaylistId = preview.playlist.id;
      job.tracksTotal = preview.summary.total;
      job.tracksMatched = preview.summary.inLibrary;
      job.status = "downloading";
      if (!(await updateImportJobFields(importJobId, {
        playlistName: job.playlistName,
        spotifyPlaylistId: job.spotifyPlaylistId,
        tracksTotal: job.tracksTotal,
        tracksMatched: job.tracksMatched,
        status: "downloading",
      }, CLOSED_IMPORT_STATES))) {
        jobLogger.info("[Quick Import] Job was stopped after its playlist was read");
        return;
      }

      jobLogger.info(`[Quick Import] Playlist: "${resolvedName}" (${preview.summary.total} tracks)`);
      jobLogger.info(`[Quick Import] Already in library: ${preview.summary.inLibrary}, downloadable: ${preview.summary.downloadable}`);

      // Every downloadable album is selected, if this user may start downloads; otherwise the playlist is only
      // matched against the library.
      const albumMbidsToDownload = (await this.importerMayAcquire(job.userId))
        ? preview.albumsToDownload.map((a) => a.albumMbid || a.spotifyAlbumId)
        : [];

      if (albumMbidsToDownload.length === 0) {
        jobLogger.info(`[Quick Import] No albums to download, creating playlist from matched tracks`);
      }

      const tracksFromDownloads = preview.albumsToDownload.reduce(
        (sum, a) => sum + a.tracksNeeded.length, 0,
      );

      const pendingTracks = pendingTracksOf(preview);

      // Update job fully before handing off to processImport
      job.albumsTotal = albumMbidsToDownload.length;
      job.tracksDownloadable = tracksFromDownloads;
      job.pendingTracks = pendingTracks;
      if (!(await updateImportJobFields(importJobId, {
        albumsTotal: job.albumsTotal,
        tracksDownloadable: job.tracksDownloadable,
        pendingTracks: job.pendingTracks as unknown as Prisma.InputJsonValue,
      }, CLOSED_IMPORT_STATES))) {
        jobLogger.info("[Quick Import] Job was stopped before its downloads started");
        return;
      }

      // The preview goes to processImport directly: nothing reads a quick import's cached preview, so none is kept.
      await this.processImport(job, albumMbidsToDownload, preview);
    } finally {
      jobLoggers.delete(importJobId);
    }
  }

  /**
   * Mark an import job as failed (used by the BullMQ worker's failed handler)
   * and tell the user. A job that matched nothing is removed; one that matched
   * some tracks is kept so the user can see what happened.
   */
  async markJobFailed(importJobId: string, errorMessage: string): Promise<void> {
    try {
      const job = await getImportJob(importJobId);
      if (!job) return;
      job.error = errorMessage;

      const hasMatchedTracks = (job.pendingTracks || []).some(
        (t) => t.preMatchedTrackId,
      );

      // A late failure handler does not turn an import that completed or was cancelled meanwhile into a failed one,
      // and only a failure that was written is announced.
      if (!hasMatchedTracks) {
        const { count } = await prisma.spotifyImportJob.updateMany({
          where: { id: importJobId, status: { notIn: NOT_OVERWRITTEN_BY_FAILURE } },
          data: { status: "failed", error: errorMessage, updatedAt: new Date() },
        });
        if (count === 0) return;
        // Before anything that can throw: the import is failed, so its searches stop now.
        abortImportSearches(importJobId);
        notifyImportFailed(job);

        logger.info(
          `[Spotify Import] Job ${importJobId} failed with zero matched tracks, cleaning up`,
        );

        // Built here rather than from the job: this import's songs and progress are being cleaned away, so the page
        // is told zero matched and no progress.
        eventBus.emit({
          type: "import:progress",
          userId: job.userId,
          payload: {
            jobId: job.id,
            playlistName: job.playlistName,
            status: "failed",
            progress: 0,
            albumsTotal: job.albumsTotal,
            albumsCompleted: job.albumsCompleted,
            tracksMatched: 0,
            tracksTotal: job.tracksTotal,
            error: errorMessage,
          },
        });

        await this.cleanupImportArtifacts(importJobId);
        return;
      }

      // Only the status and the error: the counts and the listing are whatever a dismissal or a scan left them.
      if (await updateImportJobFields(importJobId, { status: "failed", error: errorMessage }, NOT_OVERWRITTEN_BY_FAILURE)) {
        notifyImportFailed(job);
      }
    } finally {
      // The import is over for this process, whichever way it ended.
      jobLoggers.delete(importJobId);
    }
  }
}

export const playlistImportService = new PlaylistImportService();
