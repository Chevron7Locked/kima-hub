import { logger } from "../../utils/logger";
import { createPlaylistLogger } from "../../utils/playlistLogger";
import { notificationService } from "../notificationService";
import { prisma, Prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { eventBus } from "../eventBus";
import type { ImportJob } from "./types";
export const jobLoggers = new Map<string, ReturnType<typeof createPlaylistLogger>>();

export const IMPORT_JOB_KEY = (id: string) => `import:job:${id}`;
export const IMPORT_JOB_TTL = 24 * 60 * 60; // 24 hours
/**
 * Save import job to both database and Redis cache for cross-process sharing
 */
export async function saveImportJob(job: ImportJob): Promise<void> {
  await prisma.spotifyImportJob.upsert({
    where: { id: job.id },
    create: {
      id: job.id,
      userId: job.userId,
      spotifyPlaylistId: job.spotifyPlaylistId,
      playlistName: job.playlistName,
      status: job.status,
      progress: job.progress,
      albumsTotal: job.albumsTotal,
      albumsCompleted: job.albumsCompleted,
      tracksMatched: job.tracksMatched,
      tracksTotal: job.tracksTotal,
      tracksDownloadable: job.tracksDownloadable,
      createdPlaylistId: job.createdPlaylistId,
      error: job.error,
      sourceUrl: job.sourceUrl,
      pendingTracks: job.pendingTracks as any,
    },
    update: {
      playlistName: job.playlistName,
      status: job.status,
      progress: job.progress,
      albumsTotal: job.albumsTotal,
      albumsCompleted: job.albumsCompleted,
      tracksMatched: job.tracksMatched,
      tracksTotal: job.tracksTotal,
      tracksDownloadable: job.tracksDownloadable,
      createdPlaylistId: job.createdPlaylistId,
      error: job.error,
      // A job row made before its listing was known keeps the listing it later saves, not an empty one.
      pendingTracks: job.pendingTracks as any,
      updatedAt: new Date(),
    },
  });

  await cacheAndAnnounceImportJob(job);
}

/** Cache a job for the worker and API processes to share, and tell the person's open import page. */
export async function cacheAndAnnounceImportJob(job: ImportJob): Promise<void> {
  try {
    await redisClient.setex(IMPORT_JOB_KEY(job.id), IMPORT_JOB_TTL, JSON.stringify(job));
  } catch (error) {
    logger.warn(`Failed to cache import job ${job.id} in Redis:`, error);
    // Continue - Redis is optional, DB is source of truth
  }
  announceImportProgress(job);
}

/**
 * Change only the fields given on an import's row, then cache and announce the row as the database holds it. A write
 * that closes an import (it failed) uses this instead of `saveImportJob`, so the counts and listing that a dismissal or
 * a scan changed since the job was read are not written back over. A write that finds the row in an excepted state, or
 * gone, changes nothing and announces nothing: the page already heard of whatever put the row there. False then.
 */
export async function updateImportJobFields(
  importJobId: string,
  data: Prisma.SpotifyImportJobUncheckedUpdateManyInput,
  /** Rows in these states are left as they are. */
  exceptStatuses: string[] = [],
): Promise<boolean> {
  const { count } = await prisma.spotifyImportJob.updateMany({
    where: { id: importJobId, status: { notIn: exceptStatuses } },
    data: { ...data, updatedAt: new Date() },
  });
  if (count === 0) return false;
  await publishImportJob(importJobId);
  return true;
}

export const CLOSED_IMPORT_STATES: ImportJob["status"][] = ["completed", "failed", "cancelled"];

/**
 * Fails an import from outside the import (the stuck-work check, the stale-job cleanup). It leaves only a state that is
 * not final, so an import another path completed, cancelled or failed keeps its outcome and its reason, and it tells the
 * person's open import page. False when the import was already closed or is gone.
 */
export function failImportJob(importJobId: string, error: string): Promise<boolean> {
  return updateImportJobFields(importJobId, { status: "failed", error }, CLOSED_IMPORT_STATES);
}

/**
 * Marks an import as building its playlist: its status and progress, and its listing only when the row has none yet
 * (a row made before the listing was known). The link to a playlist, the counts and a listing a dismissal changed are
 * the row's own and are left alone, and the build reads the row's listing, not its own older copy (a song dismissed
 * while the build waited stays dismissed). A job with no row yet gets one. False when the row is already linked to a
 * playlist or closed, so there is nothing to build.
 */
export async function markBuilding(job: ImportJob): Promise<boolean> {
  const row = await prisma.spotifyImportJob.findUnique({ where: { id: job.id } });
  if (!row) {
    await saveImportJob({ ...job, status: "creating_playlist", progress: 90 });
  } else {
    if (row.createdPlaylistId || CLOSED_IMPORT_STATES.includes(row.status as ImportJob["status"])) return false;
    const listingEmpty = !Array.isArray(row.pendingTracks) || row.pendingTracks.length === 0;
    await updateImportJobFields(
      job.id,
      { status: "creating_playlist", progress: 90, ...(listingEmpty ? { pendingTracks: job.pendingTracks as any } : {}) },
      CLOSED_IMPORT_STATES,
    );
    if (!listingEmpty) job.pendingTracks = toImportJob(row).pendingTracks;
  }
  job.status = "creating_playlist";
  job.progress = 90;
  job.updatedAt = new Date();
  return true;
}

/** Cache an import's row as the database holds it and tell the person's open import page. */
export async function publishImportJob(importJobId: string): Promise<void> {
  const row = await prisma.spotifyImportJob.findUnique({ where: { id: importJobId } });
  if (row) await cacheAndAnnounceImportJob(toImportJob(row));
}

export function announceImportProgress(job: ImportJob): void {
  eventBus.emit({
    type: "import:progress",
    userId: job.userId,
    payload: {
      jobId: job.id,
      playlistName: job.playlistName,
      status: job.status,
      progress: job.progress,
      albumsTotal: job.albumsTotal,
      albumsCompleted: job.albumsCompleted,
      tracksMatched: job.tracksMatched,
      tracksTotal: job.tracksTotal,
      tracksDownloadable: job.tracksDownloadable,
      createdPlaylistId: job.createdPlaylistId,
      error: job.error,
    },
  });
}

/**
 * Tell the person's open import page the counts of the import that made `playlistId`, as the database holds them now.
 * A write to a playlist's waiting entries (a dismissal, a scan placing songs) changes those counts without saving the
 * job, so it calls this after it commits. A playlist no import made has nothing to announce.
 */
export async function announceImportCounts(playlistId: string): Promise<void> {
  try {
    const row = await prisma.spotifyImportJob.findFirst({
      where: { createdPlaylistId: playlistId },
      orderBy: { createdAt: "desc" },
    });
    if (row) announceImportProgress(toImportJob(row));
  } catch (error) {
    // The write it follows is committed: a missed announcement is logged, not raised.
    logger.warn(`Could not announce import counts for playlist ${playlistId}:`, error);
  }
}
export function toImportJob(
  dbJob: Prisma.SpotifyImportJobGetPayload<object>,
): ImportJob {
  return {
    id: dbJob.id,
    userId: dbJob.userId,
    spotifyPlaylistId: dbJob.spotifyPlaylistId,
    playlistName: dbJob.playlistName,
    status: dbJob.status as ImportJob["status"],
    progress: dbJob.progress,
    albumsTotal: dbJob.albumsTotal,
    albumsCompleted: dbJob.albumsCompleted,
    tracksMatched: dbJob.tracksMatched,
    tracksTotal: dbJob.tracksTotal,
    tracksDownloadable: dbJob.tracksDownloadable,
    createdPlaylistId: dbJob.createdPlaylistId,
    error: dbJob.error,
    sourceUrl: dbJob.sourceUrl,
    createdAt: dbJob.createdAt,
    updatedAt: dbJob.updatedAt,
    pendingTracks: (dbJob.pendingTracks as any) || [],
  };
}

/**
 * Get import job from Redis cache or database
 * Redis provides cross-process sharing between API and worker processes
 */
export async function getImportJob(importJobId: string): Promise<ImportJob | null> {
  try {
    const cached = await redisClient.get(IMPORT_JOB_KEY(importJobId));
    if (cached) {
      const job: ImportJob = JSON.parse(cached);
      // A job that made its playlist has its counts changed by the playlist's own writes (a dismissal, a scan placing
      // a song), which go to the database alone: the database is its truth, the cache only serves a job still running.
      if (!job.createdPlaylistId) return job;
    }
  } catch (error) {
    logger.warn(
      `Failed to read import job ${importJobId} from Redis:`,
      error,
    );
  }

  const dbJob = await prisma.spotifyImportJob.findUnique({
    where: { id: importJobId },
  });

  if (!dbJob) return null;

  const job = toImportJob(dbJob);

  try {
    await redisClient.setex(
      IMPORT_JOB_KEY(importJobId),
      IMPORT_JOB_TTL,
      JSON.stringify(job),
    );
  } catch (error) {
    logger.warn(
      `Failed to cache import job ${importJobId} in Redis:`,
      error,
    );
    // Continue - Redis is optional
  }

  return job;
}

export function notifyImportFailed(job: ImportJob): void {
  notificationService
    .notifyImportFailed(job.userId, job.id, job.playlistName, job.error ?? "Unknown error")
    .catch((e) => logger.error(`[Spotify Import] Job ${job.id}: failure notification failed:`, e));
}



/** An import past its downloads: finished, given up, or scanning and building its playlist. */
export const HANDED_OFF_STATES: ImportJob["status"][] = ["completed", "failed", "cancelled", "scanning", "creating_playlist"];

/** The states the downloads check does not act in: a quick import still fetching, and one already past its downloads. */
export const NOT_WAITING_FOR_DOWNLOADS: ImportJob["status"][] = ["fetching", ...HANDED_OFF_STATES];

/**
 * Records what the downloads check found: only its own fields, and only on an import still waiting for its downloads.
 * The check read the import some time ago, so a person's cancel (the row is gone) or a path that closed or handed the
 * import on in the meantime is not written over. False when nothing was written.
 */
export function recordDownloadsCheck(job: ImportJob, fields: { status?: ImportJob["status"]; error?: string }): Promise<boolean> {
  return updateImportJobFields(
    job.id,
    { progress: job.progress, ...fields },
    NOT_WAITING_FOR_DOWNLOADS,
  );
}
/** Every state but scanning: the write that undoes the move to scanning leaves an import that has moved on since. */
export const NOT_SCANNING: ImportJob["status"][] = ["pending", "fetching", "downloading", "creating_playlist", "completed", "failed", "cancelled"];

/** A new import job's id. */
export const newImportJobId = () => `import_${Date.now()}_${Math.random().toString(36).substring(7)}`;
