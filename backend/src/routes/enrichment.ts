import { Router, Response } from "express";
import { logger } from "../utils/logger";
import { refuseRequest, safeError } from "../utils/errors";
import { prisma } from "../utils/db";
import {
  getEnrichmentProgress,
  invalidateEnrichmentProgress,
  retryFailedAndBlocked,
  redecideEverything,
  startEnrichmentNow,
} from "../workers/unifiedEnrichment";
import { wipeEnrichment, rerunEnrichment, RERUN_STEPS, type RerunStep } from "../services/enrichmentRestart";
import { enrichmentStateService } from "../services/enrichmentState";
import { enrichmentFailureService, isFailureType, type GetFailuresOptions } from "../services/enrichmentFailureService";
import {
  getSystemSettings,
  saveSystemSettings,
} from "../utils/systemSettings";
import { rateLimiter } from "../services/rateLimiter";
import { redisClient } from "../utils/redis";
import {
  DuplicateMbidError,
  moveAlbumRgMbid,
  moveArtistMbid,
} from "../services/mbidReassign";
import { forgetOwnedIndex } from "../services/discovery/ownedIndexVersion";
import { artistSortName, isMbid } from "../services/artistIdentity";
import { albumIsListed, artistIsListed, markLibraryChanged, songIsListed } from "../services/libraryChanged";
import { parseLimit, parseOffset } from "./library/paging";
import { wholeNumber } from "../utils/wholeNumber";

const router = Router();

/** A field of a metadata edit that is not what it should be; the reason names the field and the rule, never the value. */
class BadField extends Error {}

/** Text cannot hold a null character (the database refuses it), so one is the caller's mistake, not a server fault. */
const hasNull = (text: string) => text.includes("\u0000");

/** A text override: text, or null (or blank text) to remove the override. */
function textOverride(field: string, raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || hasNull(raw)) throw new BadField(`${field}: text, or null to clear`);
  return raw.trim() === "" ? null : raw;
}

/** A genre override: a list of text, or null for the empty list a reset writes. */
function genresOverride(raw: unknown): string[] {
  if (raw === null) return [];
  if (!Array.isArray(raw) || raw.some((g) => typeof g !== "string" || hasNull(g))) {
    throw new BadField("genres: a list of text, or null to clear");
  }
  return raw.filter((g) => g.trim() !== "");
}

/** A new MusicBrainz id: an id, or nothing (null or blank text) when the id stays. */
function mbidInput(field: string, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new BadField(`${field}: a MusicBrainz id`);
  const id = raw.trim();
  if (id === "") return null;
  if (!isMbid(id)) throw new BadField(`${field}: a MusicBrainz id`);
  return id.toLowerCase();
}

/** Answer 404 when a Prisma update hit a row that was deleted meanwhile (P2025). */
function respondIfDeleted(res: Response, error: unknown, entity: string): boolean {
  if (typeof error !== "object" || error === null || (error as { code?: string }).code !== "P2025") {
    return false;
  }
  res.status(404).json({
    error: `${entity[0].toUpperCase()}${entity.slice(1)} not found`,
    message: `The ${entity} may have been deleted`,
  });
  return true;
}

// What a metadata edit and a metadata reset send back, so the editor sees the same row either way.
const ARTIST_EDIT_REPLY = { albums: { select: { id: true, title: true, year: true, coverUrl: true } } } as const;
const ALBUM_EDIT_REPLY = {
  artist: { select: { id: true, name: true } },
  tracks: { select: { id: true, title: true, trackNo: true, duration: true } },
} as const;
const TRACK_EDIT_REPLY = {
  album: { select: { id: true, title: true, artist: { select: { id: true, name: true } } } },
} as const;

/** The artist page caches its hero image; an edit or reset of the artist drops it. */
async function forgetArtistHero(artistId: string): Promise<void> {
  try {
    await redisClient.del(`hero:${artistId}`);
  } catch (err) {
    logger.warn("Failed to invalidate Redis cache:", err);
  }
}

// Authentication is per-route: a path that matches no route must 404, not 401,
// so the settings UI sees "no such control", not "log in".

/**
 * GET /enrichment/progress
 * Get comprehensive enrichment progress (artists, track tags, audio analysis)
 */
router.get("/progress", async (_req, res) => {
  try {
    const progress = await getEnrichmentProgress();
    res.json(progress);
  } catch (error) {
    logger.error("Get enrichment progress error:", error);
    res.status(500).json({ error: "Failed to get progress" });
  }
});

/**
 * GET /enrichment/status
 * Get detailed enrichment state (running, paused, etc.)
 */
router.get("/status", async (_req, res) => {
  try {
    const state = await enrichmentStateService.getState();
    const base = state || { status: "idle", currentPhase: null };
    // Surface a hang to the UI: status says running but lastActivity has not
    // moved for over 15 minutes.
    const hung =
      base.status === "running" &&
      (await enrichmentStateService.detectHang());
    res.json({ ...base, hung });
  } catch (error) {
    logger.error("Get enrichment status error:", error);
    res.status(500).json({ error: "Failed to get status" });
  }
});

/**
 * POST /enrichment/pause
 * Pause the enrichment process
 */
router.post("/pause", async (_req, res) => {
  try {
    const state = await enrichmentStateService.pause();
    res.json({
      message: "Enrichment paused",
      state,
    });
  } catch (error) {
    safeError(res, "Pause enrichment", error);
  }
});

/**
 * POST /enrichment/resume
 * Resume a paused enrichment process
 */
router.post("/resume", async (_req, res) => {
  try {
    const state = await enrichmentStateService.resume();
    res.json({
      message: "Enrichment resumed",
      state,
    });
  } catch (error) {
    safeError(res, "Resume enrichment", error);
  }
});

/**
 * POST /enrichment/stop
 * Stop the enrichment process
 */
router.post("/stop", async (_req, res) => {
  try {
    const state = await enrichmentStateService.stop();
    res.json({
      message: "Enrichment stopping...",
      state,
    });
  } catch (error) {
    safeError(res, "Stop enrichment", error);
  }
});

/**
 * POST /enrichment/retry-failed-and-blocked
 * Re-queue every stage question still owed an answer. Nothing is reset: done
 * answers are not re-asked and terminal ones wait for a human. Admin only.
 */
router.post("/retry-failed-and-blocked", async (_req, res) => {
  try {
    const work = await retryFailedAndBlocked();
    invalidateEnrichmentProgress();

    res.json({
      message: "Failed and blocked work re-queued",
      description: `${work.length} stage questions handed to the queue`,
      queued: work.length,
    });
  } catch (error) {
    logger.error("Retry failed and blocked error:", error);
    res
      .status(500)
      .json({ error: "Failed to re-queue failed and blocked work" });
  }
});

/**
 * POST /enrichment/re-decide-everything
 * Re-open every stage question so the sweep asks again. Deletes no answers and
 * never re-runs AcoustID on a track that has a recordingMbid. Admin only.
 */
router.post("/re-decide-everything", async (_req, res) => {
  try {
    const { reopened } = await redecideEverything();
    invalidateEnrichmentProgress();

    res.json({
      message: "Every stage question re-opened",
      description: `${reopened} stage records reopened`,
      reopened,
    });
  } catch (error) {
    logger.error("Re-decide everything error:", error);
    res.status(500).json({ error: "Failed to re-decide everything" });
  }
});

// The steps whose name in a reply is not their id.
const STEP_NAMES: Partial<Record<RerunStep, string>> = {
  analysis: "audio analysis",
  vectors: "sound vectors",
};

/**
 * POST /enrichment/rerun
 * Re-run the enrichment from one of its six steps: the step's answers and
 * everything that depends on them are cleared and worked out again
 * (services/enrichmentRestart.ts). Person-decided answers and everything
 * people made stay. Admin only.
 */
router.post("/rerun", async (req, res) => {
  try {
    const step = req.body?.step;
    if (!RERUN_STEPS.includes(step)) {
      refuseRequest(req, res, "step: not a step that can be rerun");
      return;
    }
    const wiped = await rerunEnrichment(step);
    invalidateEnrichmentProgress();
    void startEnrichmentNow();
    res.json({
      ...wiped,
      message: `Re-running from ${STEP_NAMES[step as RerunStep] ?? step}`,
    });
  } catch (error) {
    logger.error("Rerun enrichment error:", error);
    res.status(500).json({ error: "Failed to re-run enrichment" });
  }
});

/**
 * POST /enrichment/wipe-and-rerun
 * Clear what the enrichment steps worked out and run them again from the start
 * (services/enrichmentRestart.ts). The library, file identities and everything
 * people made stay. Admin only.
 */
router.post("/wipe-and-rerun", async (_req, res) => {
  try {
    const wiped = await wipeEnrichment();
    invalidateEnrichmentProgress();
    void startEnrichmentNow();
    res.json(wiped);
  } catch (error) {
    logger.error("Wipe and re-run enrichment error:", error);
    res.status(500).json({ error: "Failed to wipe and re-run enrichment" });
  }
});

/**
 * POST /enrichment/sync
 * Trigger incremental enrichment (only processes pending items)
 * Fast sync that picks up new content without re-processing everything
 */
router.post("/sync", async (_req, res) => {
  try {
    const result = await startEnrichmentNow();

    res.json({
      message: "Incremental sync started",
      description: "Processing new and pending items only",
      result,
    });
  } catch (error) {
    safeError(res, "Trigger incremental sync", error);
  }
});

/**
 * GET /enrichment/failures
 * Enrichment failures with filtering: track stages from TrackStage, artists and
 * podcasts from the ledger, in the EnrichmentFailure shape.
 */
router.get("/failures", async (req, res) => {
  try {
    const { entityType, includeSkipped, includeResolved, limit, offset } =
      req.query;

    if (entityType && !isFailureType(entityType)) {
      return refuseRequest(req, res, "entityType: not a known failure type");
    }

    const options: GetFailuresOptions = {};
    if (isFailureType(entityType)) options.entityType = entityType;
    if (includeSkipped === "true") options.includeSkipped = true;
    if (includeResolved === "true") options.includeResolved = true;
    if (limit) options.limit = parseLimit(limit, 100);
    if (offset) options.offset = parseOffset(offset);

    const result = await enrichmentFailureService.getFailures(options);
    res.json(result);
  } catch (error) {
    logger.error("Get failures error:", error);
    res.status(500).json({ error: "Failed to get failures" });
  }
});

/**
 * GET /enrichment/failures/counts
 * Get failure counts by type
 */
router.get("/failures/counts", async (_req, res) => {
  try {
    const counts = await enrichmentFailureService.getFailureCounts();
    res.json(counts);
  } catch (error) {
    logger.error("Get failure counts error:", error);
    res.status(500).json({ error: "Failed to get failure counts" });
  }
});

/**
 * POST /enrichment/retry
 * Retry specific failed items
 */
router.post("/retry", async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return refuseRequest(req, res, "ids: a list of failure ids required");
    }

    // Reset retry count for these failures
    await enrichmentFailureService.resetRetryCount(ids);

    // Get the failures to determine what to retry
    const failures = await Promise.all(
      ids.map((id) => enrichmentFailureService.getFailure(id)),
    );

    const present = failures.filter((f): f is NonNullable<typeof f> => f !== null);
    const exists = await enrichmentFailureService.subjectsThatExist(present);

    let queued = 0;
    let skipped = 0;
    const toResolve: string[] = [];
    const artistIdsToReset: string[] = [];
    const stageReopenIds: string[] = [];
    const podcastIdsToRefresh: string[] = [];

    for (const failure of present) {
      if (!exists(failure)) {
        // Deleted since the failure was recorded: nothing to retry.
        toResolve.push(failure.id);
        skipped++;
      } else if (failure.entityType === "artist") {
        artistIdsToReset.push(failure.entityId);
        queued++;
      } else if (failure.entityType === "podcast") {
        // The feed is refreshed on the next cycle; a refresh that works resolves the failure.
        podcastIdsToRefresh.push(failure.entityId);
        queued++;
      } else {
        // Track-stage failure (track/audio/vibe/scan): retrying reopens the
        // question on the stage record (pending, fresh attempt, error cleared)
        // and the queue re-asks it. The record is what the engine decides from,
        // so no Track columns are reset.
        stageReopenIds.push(failure.id);
        queued++;
      }
    }

    // One batch update per kind. Each is isolated so a failure resetting one
    // kind doesn't block the others.
    try {
      if (artistIdsToReset.length > 0) {
        await prisma.artist.updateMany({
          where: { id: { in: artistIdsToReset } },
          data: { enrichmentStatus: "pending", enrichmentFailures: 0 },
        });
      }
    } catch (error) {
      logger.error("Failed to reset artist enrichment for retry:", error);
    }

    try {
      if (podcastIdsToRefresh.length > 0) {
        await prisma.podcast.updateMany({
          where: { id: { in: podcastIdsToRefresh } },
          data: { lastRefreshed: new Date(0) },
        });
      }
    } catch (error) {
      logger.error("Failed to make podcasts due for refresh:", error);
    }

    try {
      if (stageReopenIds.length > 0) {
        await enrichmentFailureService.retryStageFailures(stageReopenIds);
      }
    } catch (error) {
      logger.error("Failed to reopen stage records for retry:", error);
    }

    try {
      if (toResolve.length > 0) {
        // Entities deleted since the failure was recorded - mark resolved
        await enrichmentFailureService.resolveFailures(toResolve);
      }
    } catch (error) {
      logger.error("Failed to resolve stale enrichment failures:", error);
    }

    res.json({
      message: `Queued ${queued} items for retry, ${skipped} skipped (entities no longer exist)`,
      queued,
      skipped,
    });
  } catch (error) {
    safeError(res, "Retry enrichment failures", error);
  }
});

/**
 * PUT /enrichment/artists/:id/metadata
 * Update artist metadata manually (non-destructive overrides)
 * User edits are stored as overrides; canonical data preserved for API lookups
 */
router.put("/artists/:id/metadata", async (req, res) => {
    try {
      const { name, bio, genres, heroUrl, mbid } = req.body;

      // Every field is read before anything is read from or written to the database.
      const updateData: any = {};
      let hasOverrides = false;
      let newName: string | null | undefined;
      if (name !== undefined) {
        newName = textOverride("name", name);
        updateData.displayName = newName;
        hasOverrides = true;
      }
      if (bio !== undefined) {
        updateData.userSummary = textOverride("bio", bio);
        hasOverrides = true;
      }
      if (heroUrl !== undefined) {
        updateData.userHeroUrl = textOverride("heroUrl", heroUrl);
        hasOverrides = true;
      }
      if (genres !== undefined) {
        updateData.userGenres = genresOverride(genres);
        hasOverrides = true;
      }
      const newMbid = mbidInput("mbid", mbid);

      // The name shown before the edit, to tell afterwards whether the edit changed it.
      const before = await prisma.artist.findUnique({
        where: { id: req.params.id },
        select: { name: true, displayName: true },
      });

      // sortName follows displayName. Clearing the override files the artist under
      // its canonical name.
      if (newName !== undefined) {
        updateData.sortName = artistSortName(newName ?? before?.name ?? "");
      }

      // Set override flag
      if (hasOverrides) {
        updateData.hasUserOverrides = true;
      }

      // A new id and the rest of the edit are stored together or not at all.
      const artist = await prisma.$transaction(async (tx) => {
        if (newMbid !== null) await moveArtistMbid(tx, req.params.id, newMbid);
        return tx.artist.update({
          where: { id: req.params.id },
          data: updateData,
          include: ARTIST_EDIT_REPLY,
        });
      });
      if (newMbid !== null) forgetOwnedIndex();
      await forgetArtistHero(req.params.id);

      // A shown name is what a Subsonic client lists, so an edit that changes it moves the library's change marker. An
      // edit that sends the name already shown, a new MBID (it renames nothing), or an artist no client lists (Discover's,
      // or one whose songs are missing or corrupt) moves nothing.
      if (before && (artist.displayName || artist.name) !== (before.displayName || before.name) && (await artistIsListed(req.params.id))) {
        await markLibraryChanged();
      }
      res.json(artist);
    } catch (error) {
      if (error instanceof BadField) return refuseRequest(req, res, error.message);
      if (error instanceof DuplicateMbidError) {
        return res.status(409).json({
          error: `MBID ${error.mbidValue} is already in use by another artist`,
        });
      }
      if (!respondIfDeleted(res, error, "artist")) {
        safeError(res, "Update artist metadata", error);
      }
    }
  });

/**
 * PUT /enrichment/albums/:id/metadata
 * Update album metadata manually (non-destructive overrides)
 * User edits are stored as overrides; canonical data preserved for API lookups
 */
router.put("/albums/:id/metadata", async (req, res) => {
    try {
      const { title, year, genres, coverUrl, rgMbid } = req.body;

      // Every field is read before anything is read from or written to the database.
      const updateData: any = {};
      let hasOverrides = false;
      let newTitle: string | null | undefined;
      if (title !== undefined) {
        newTitle = textOverride("title", title);
        updateData.displayTitle = newTitle;
        hasOverrides = true;
      }
      if (year !== undefined) {
        // An emptied field arrives as null (or an empty string) and removes the override.
        const parsedYear = year === null || year === "" ? null : wholeNumber(year);
        if (parsedYear !== null && !(parsedYear >= 1000 && parsedYear <= 9999)) {
          return refuseRequest(req, res, "year: a whole number 1000-9999");
        }
        updateData.displayYear = parsedYear;
        hasOverrides = true;
      }
      if (coverUrl !== undefined) {
        updateData.userCoverUrl = textOverride("coverUrl", coverUrl);
        hasOverrides = true;
      }
      if (genres !== undefined) {
        updateData.userGenres = genresOverride(genres);
        hasOverrides = true;
      }
      const newRgMbid = mbidInput("rgMbid", rgMbid);

      // The title shown before the edit, to tell afterwards whether the edit changed it.
      const before = await prisma.album.findUnique({
        where: { id: req.params.id },
        select: { title: true, displayTitle: true },
      });

      // sortName follows displayTitle, like the artist override. artistSortName is
      // text-generic, so it serves albums too. Clearing the override files the album
      // under its canonical title.
      if (newTitle !== undefined) {
        updateData.sortName = artistSortName(newTitle ?? before?.title ?? "");
      }

      // Set override flag
      if (hasOverrides) {
        updateData.hasUserOverrides = true;
      }

      // A new id and the rest of the edit are stored together or not at all.
      const { album, moved } = await prisma.$transaction(async (tx) => {
        const moved = newRgMbid !== null && (await moveAlbumRgMbid(tx, req.params.id, newRgMbid, { source: "editor" }));
        const album = await tx.album.update({
          where: { id: req.params.id },
          data: updateData,
          include: ALBUM_EDIT_REPLY,
        });
        return { album, moved };
      });
      if (moved) forgetOwnedIndex();

      // Only a shown title that changed is a change to what a client lists.
      if (before && (album.displayTitle || album.title) !== (before.displayTitle || before.title) && (await albumIsListed(req.params.id))) {
        await markLibraryChanged();
      }
      res.json(album);
    } catch (error) {
      if (error instanceof BadField) return refuseRequest(req, res, error.message);
      if (error instanceof DuplicateMbidError) {
        return res.status(409).json({
          error: `rgMbid ${error.mbidValue} is already in use by another album`,
        });
      }
      if (!respondIfDeleted(res, error, "album")) {
        safeError(res, "Update album metadata", error);
      }
    }
  });

/**
 * PUT /enrichment/tracks/:id/metadata
 * Update track metadata manually (non-destructive overrides)
 * User edits are stored as overrides; canonical data preserved
 */
router.put("/tracks/:id/metadata", async (req, res) => {
  try {
    const { title, trackNo } = req.body;

    const updateData: any = {};
    let hasOverrides = false;

    // Map user edits to override fields (non-destructive)
    if (title !== undefined) {
      updateData.displayTitle = textOverride("title", title);
      hasOverrides = true;
    }
    if (trackNo !== undefined) {
      // Same as displayYear above: null clears the override, anything unparseable or outside the range is the
      // caller's mistake and gets a 400 rather than a 500.
      const parsedTrackNo = trackNo === null || trackNo === "" ? null : wholeNumber(trackNo);
      if (parsedTrackNo !== null && !(parsedTrackNo >= 1 && parsedTrackNo <= 9999)) {
        return refuseRequest(req, res, "trackNo: a whole number 1-9999");
      }
      updateData.displayTrackNo = parsedTrackNo;
      hasOverrides = true;
    }

    // Set override flag
    if (hasOverrides) {
      updateData.hasUserOverrides = true;
    }

    // The title shown before the edit, to tell afterwards whether the edit changed it.
    const before = await prisma.track.findUnique({
      where: { id: req.params.id },
      select: { title: true, displayTitle: true },
    });

    const track = await prisma.track.update({
      where: { id: req.params.id },
      data: updateData,
      include: TRACK_EDIT_REPLY,
    });

    // Only a shown title that changed is a change to what a client lists.
    if (before && (track.displayTitle || track.title) !== (before.displayTitle || before.title) && (await songIsListed(req.params.id))) {
      await markLibraryChanged();
    }
    res.json(track);
  } catch (error) {
    if (error instanceof BadField) return refuseRequest(req, res, error.message);
    if (!respondIfDeleted(res, error, "track")) {
      safeError(res, "Update track metadata", error);
    }
  }
});

/**
 * POST /enrichment/artists/:id/reset
 * Reset artist metadata to canonical values (clear all user overrides)
 */
router.post("/artists/:id/reset", async (req, res) => {
  try {
    // Check if artist exists first
    const existingArtist = await prisma.artist.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, displayName: true },
    });

    if (!existingArtist) {
      return res.status(404).json({
        error: "Artist not found",
        message: "The artist may have been deleted",
      });
    }

    const artist = await prisma.artist.update({
      where: { id: req.params.id },
      data: {
        displayName: null,
        userSummary: null,
        userHeroUrl: null,
        userGenres: [],
        hasUserOverrides: false,
        // A reset clears displayName, so sortName has to file back under
        // the canonical name too -- same reason the PUT handler recomputes
        // it on clear.
        sortName: artistSortName(existingArtist.name),
      },
      include: ARTIST_EDIT_REPLY,
    });
    await forgetArtistHero(req.params.id);

    // Only a shown name that changed back is a change to what a client lists.
    if ((existingArtist.displayName || existingArtist.name) !== existingArtist.name && (await artistIsListed(req.params.id))) await markLibraryChanged();
    res.json({
      message: "Artist metadata reset to original values",
      artist,
    });
  } catch (error) {
    if (!respondIfDeleted(res, error, "artist")) {
      safeError(res, "Reset artist metadata", error);
    }
  }
});

/**
 * POST /enrichment/albums/:id/reset
 * Reset album metadata to canonical values (clear all user overrides)
 */
router.post("/albums/:id/reset", async (req, res) => {
  try {
    // Check if album exists first
    const existingAlbum = await prisma.album.findUnique({
      where: { id: req.params.id },
      select: { id: true, title: true, displayTitle: true },
    });

    if (!existingAlbum) {
      return res.status(404).json({
        error: "Album not found",
        message: "The album may have been deleted",
      });
    }

    const album = await prisma.album.update({
      where: { id: req.params.id },
      data: {
        displayTitle: null,
        displayYear: null,
        userCoverUrl: null,
        userGenres: [],
        hasUserOverrides: false,
        // A reset clears displayTitle, so sortName has to file back under
        // the canonical title too -- same reason the PUT handler recomputes
        // it on clear.
        sortName: artistSortName(existingAlbum.title),
      },
      include: ALBUM_EDIT_REPLY,
    });

    // Only a shown title that changed back is a change to what a client lists.
    if ((existingAlbum.displayTitle || existingAlbum.title) !== existingAlbum.title && (await albumIsListed(req.params.id))) await markLibraryChanged();
    res.json({
      message: "Album metadata reset to original values",
      album,
    });
  } catch (error) {
    if (!respondIfDeleted(res, error, "album")) {
      safeError(res, "Reset album metadata", error);
    }
  }
});

/**
 * POST /enrichment/tracks/:id/reset
 * Reset track metadata to canonical values (clear all user overrides)
 */
router.post("/tracks/:id/reset", async (req, res) => {
  try {
    // Check if track exists first
    const existingTrack = await prisma.track.findUnique({
      where: { id: req.params.id },
      select: { id: true, title: true, displayTitle: true },
    });

    if (!existingTrack) {
      return res.status(404).json({
        error: "Track not found",
        message: "The track may have been deleted",
      });
    }

    const track = await prisma.track.update({
      where: { id: req.params.id },
      data: {
        displayTitle: null,
        displayTrackNo: null,
        hasUserOverrides: false,
      },
      include: TRACK_EDIT_REPLY,
    });

    // Only a shown title that changed back is a change to what a client lists.
    if ((existingTrack.displayTitle || existingTrack.title) !== existingTrack.title && (await songIsListed(req.params.id))) await markLibraryChanged();
    res.json({
      message: "Track metadata reset to original values",
      track,
    });
  } catch (error) {
    if (!respondIfDeleted(res, error, "track")) {
      safeError(res, "Reset track metadata", error);
    }
  }
});

/**
 * GET /enrichment/concurrency
 * Get current enrichment concurrency configuration
 */
router.get("/concurrency", async (_req, res) => {
  try {
    const settings = await getSystemSettings();
    res.json({ concurrency: settings?.enrichmentConcurrency || 1 });
  } catch (error) {
    logger.error("Failed to get enrichment settings:", error);
    res.status(500).json({ error: "Failed to get enrichment settings" });
  }
});

/**
 * PUT /enrichment/concurrency
 * Update enrichment concurrency configuration
 */
router.put("/concurrency", async (req, res) => {
  try {
    const { concurrency } = req.body;

    if (!concurrency || typeof concurrency !== "number") {
      return refuseRequest(req, res, "concurrency: a number required");
    }

    // Clamp concurrency to 1-5
    const clampedConcurrency = Math.max(
      1,
      Math.min(5, Math.floor(concurrency)),
    );

    await saveSystemSettings({ enrichmentConcurrency: clampedConcurrency });

    // Update rate limiter concurrency multiplier
    rateLimiter.updateConcurrencyMultiplier(clampedConcurrency);

    logger.debug(
      `[Enrichment Settings] Updated concurrency to ${clampedConcurrency}`,
    );

    res.json({ concurrency: clampedConcurrency });
  } catch (error) {
    logger.error("Failed to update enrichment settings:", error);
    res.status(500).json({ error: "Failed to update enrichment settings" });
  }
});

export default router;
