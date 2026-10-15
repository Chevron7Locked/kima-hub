import { Router, Response } from "express";
import { logger } from "../utils/logger";
import { safeError } from "../utils/errors";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { enrichmentService } from "../services/enrichment";
import { prisma } from "../utils/db";
import {
  getEnrichmentProgress,
  invalidateEnrichmentProgress,
  retryFailedAndBlocked,
  redecideEverything,
  startEnrichmentNow,
} from "../workers/unifiedEnrichment";
import { wipeEnrichment, rerunEnrichment, type RerunStep } from "../services/enrichmentRestart";
import { enrichmentStateService } from "../services/enrichmentState";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import {
  getSystemSettings,
  invalidateSystemSettingsCache,
} from "../utils/systemSettings";
import { rateLimiter } from "../services/rateLimiter";
import { redisClient } from "../utils/redis";
import {
  DuplicateMbidError,
  reassignAlbumRgMbid,
  reassignArtistMbid,
} from "../services/mbidReassign";
import { artistSortName } from "../services/artistIdentity";

const router = Router();

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

// Authentication is per-route: a path that matches no route must 404, not 401,
// so the settings UI sees "no such control", not "log in".

/**
 * GET /enrichment/progress
 * Get comprehensive enrichment progress (artists, track tags, audio analysis)
 */
router.get("/progress", requireAuth, async (_req, res) => {
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
router.get("/status", requireAuth, async (_req, res) => {
  try {
    const state = await enrichmentStateService.getState();
    const base = state || { status: "idle", currentPhase: null };
    // Surface a hang to the UI: status says running but lastActivity has not
    // moved for over 15 minutes.
    const hung =
      base.status === "running" &&
      (await enrichmentStateService.detectHang());
    res.json({ ...base, hung: hung === true });
  } catch (error) {
    logger.error("Get enrichment status error:", error);
    res.status(500).json({ error: "Failed to get status" });
  }
});

/**
 * POST /enrichment/pause
 * Pause the enrichment process
 */
router.post("/pause", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const state = await enrichmentStateService.pause();
    res.json({
      message: "Enrichment paused",
      state,
    });
  } catch (error) {
    safeError(res, "Pause enrichment", error, 400);
  }
});

/**
 * POST /enrichment/resume
 * Resume a paused enrichment process
 */
router.post("/resume", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const state = await enrichmentStateService.resume();
    res.json({
      message: "Enrichment resumed",
      state,
    });
  } catch (error) {
    safeError(res, "Resume enrichment", error, 400);
  }
});

/**
 * POST /enrichment/stop
 * Stop the enrichment process
 */
router.post("/stop", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const state = await enrichmentStateService.stop();
    res.json({
      message: "Enrichment stopping...",
      state,
    });
  } catch (error) {
    safeError(res, "Stop enrichment", error, 400);
  }
});

/**
 * POST /enrichment/retry-failed-and-blocked
 * Re-queue every stage question still owed an answer. Nothing is reset: done
 * answers are not re-asked and terminal ones wait for a human. Admin only.
 */
router.post("/retry-failed-and-blocked", requireAuth, requireAdmin, async (_req, res) => {
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
router.post("/re-decide-everything", requireAuth, requireAdmin, async (_req, res) => {
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

const RERUN_STEPS: Record<RerunStep, string> = {
    identification: "identification",
    artists: "artists",
    analysis: "audio analysis",
    vectors: "sound vectors",
    similarity: "similarity",
};

/**
 * POST /enrichment/rerun
 * Re-run the enrichment from one of its five steps: the step's answers and
 * everything that depends on them are cleared and worked out again, the vibe
 * map laid out fresh (services/enrichmentRestart.ts). Person-decided answers
 * and everything people made stay. Admin only.
 */
router.post("/rerun", requireAuth, requireAdmin, async (req, res) => {
  try {
    const step = req.body?.step;
    if (!Object.prototype.hasOwnProperty.call(RERUN_STEPS, step)) {
      res.status(400).json({ error: `step must be one of: ${Object.keys(RERUN_STEPS).join(", ")}` });
      return;
    }
    const wiped = await rerunEnrichment(step as RerunStep);
    invalidateEnrichmentProgress();
    void startEnrichmentNow();
    res.json({
      ...wiped,
      message: `Re-running from ${RERUN_STEPS[step as RerunStep]}`,
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
router.post("/wipe-and-rerun", requireAuth, requireAdmin, async (_req, res) => {
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
router.post("/sync", requireAuth, requireAdmin, async (_req, res) => {
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
 * POST /enrichment/artist/:id
 * Enrich a single artist
 */
router.post("/artist/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const settings = await enrichmentService.getSettings(userId);

    if (!settings.enabled) {
      return res.status(400).json({ error: "Enrichment is not enabled" });
    }

    const enrichmentData = await enrichmentService.enrichArtist(
      req.params.id,
      settings,
    );

    if (!enrichmentData) {
      return res.status(404).json({ error: "No enrichment data found" });
    }

    if (enrichmentData.confidence > 0.3) {
      await enrichmentService.applyArtistEnrichment(
        req.params.id,
        enrichmentData,
      );
    }

    res.json({
      success: true,
      confidence: enrichmentData.confidence,
      data: enrichmentData,
    });
  } catch (error) {
    safeError(res, "Enrich artist", error);
  }
});

/**
 * POST /enrichment/album/:id
 * Enrich a single album
 */
router.post("/album/:id", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const settings = await enrichmentService.getSettings(userId);

    if (!settings.enabled) {
      return res.status(400).json({ error: "Enrichment is not enabled" });
    }

    const enrichmentData = await enrichmentService.enrichAlbum(
      req.params.id,
      settings,
    );

    if (!enrichmentData) {
      return res.status(404).json({ error: "No enrichment data found" });
    }

    if (enrichmentData.confidence > 0.3) {
      await enrichmentService.applyAlbumEnrichment(
        req.params.id,
        enrichmentData,
      );
    }

    res.json({
      success: true,
      confidence: enrichmentData.confidence,
      data: enrichmentData,
    });
  } catch (error) {
    safeError(res, "Enrich album", error);
  }
});

/**
 * GET /enrichment/failures
 * Enrichment failures with filtering: track stages from TrackStage, artists and
 * podcasts from the ledger, in the EnrichmentFailure shape.
 */
router.get("/failures", requireAuth, async (req, res) => {
  try {
    const { entityType, includeSkipped, includeResolved, limit, offset } =
      req.query;

    const options: any = {};
    if (entityType) options.entityType = entityType as string;
    if (includeSkipped === "true") options.includeSkipped = true;
    if (includeResolved === "true") options.includeResolved = true;
    if (limit) options.limit = parseInt(limit as string);
    if (offset) options.offset = parseInt(offset as string);

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
router.get("/failures/counts", requireAuth, async (_req, res) => {
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
router.post("/retry", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ error: "Must provide array of failure IDs" });
    }

    // Reset retry count for these failures
    await enrichmentFailureService.resetRetryCount(ids);

    // Get the failures to determine what to retry
    const failures = await Promise.all(
      ids.map((id) => enrichmentFailureService.getFailure(id)),
    );

    // Group by entity type so existence can be checked with one findMany
    // per type instead of a findUnique+update per failure.
    const idsByType = new Map<string, Set<string>>();
    for (const failure of failures) {
      if (!failure) continue;
      if (!idsByType.has(failure.entityType)) {
        idsByType.set(failure.entityType, new Set());
      }
      idsByType.get(failure.entityType)!.add(failure.entityId);
    }

    const existingArtistIds = idsByType.has("artist")
      ? new Set(
          (
            await prisma.artist.findMany({
              where: { id: { in: [...idsByType.get("artist")!] } },
              select: { id: true },
            })
          ).map((a) => a.id),
        )
      : new Set<string>();

      const trackFailureIds = new Set<string>([
        ...(idsByType.get("track") ?? []),
        ...(idsByType.get("audio") ?? []),
        ...(idsByType.get("vibe") ?? []),
        ...(idsByType.get("scan") ?? []),
      ]);
    const existingTrackIds =
      trackFailureIds.size > 0
        ? new Set(
            (
              await prisma.track.findMany({
                where: { id: { in: [...trackFailureIds] } },
                select: { id: true },
              })
            ).map((t) => t.id),
          )
        : new Set<string>();

    let queued = 0;
    let skipped = 0;
    const toResolve: string[] = [];
    const artistIdsToReset: string[] = [];
    const stageReopenIds: string[] = [];

    for (const failure of failures) {
      if (!failure) continue;

      if (failure.entityType === "artist") {
        if (!existingArtistIds.has(failure.entityId)) {
          toResolve.push(failure.id);
          skipped++;
        } else {
          artistIdsToReset.push(failure.entityId);
          queued++;
        }
      } else {
        // Track-stage failure (track/audio/vibe/scan): retrying reopens the
        // question on the stage record (pending, fresh attempt, error cleared)
        // and the queue re-asks it. The record is what the engine decides from,
        // so no Track columns are reset.
        if (!existingTrackIds.has(failure.entityId)) {
          toResolve.push(failure.id);
          skipped++;
        } else {
          stageReopenIds.push(failure.id);
          queued++;
        }
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
router.put("/artists/:id/metadata", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { name, bio, genres, heroUrl, mbid } = req.body;
  
      const updateData: any = {};
      let hasOverrides = false;
  
      // Map user edits to override fields (non-destructive)
      if (name !== undefined) {
        updateData.displayName = name;
        hasOverrides = true;

        // sortName follows displayName. Clearing the override files the artist under
        // its canonical name, fetched only in that case.
        const effectiveName =
          typeof name === "string" && name.trim() !== ""
            ? name
            : ((
                await prisma.artist.findUnique({
                  where: { id: req.params.id },
                  select: { name: true },
                })
              )?.name ?? "");
        updateData.sortName = artistSortName(effectiveName);
      }
      if (bio !== undefined) {
        updateData.userSummary = bio;
        hasOverrides = true;
      }
      if (heroUrl !== undefined) {
        updateData.userHeroUrl = heroUrl;
        hasOverrides = true;
      }
      if (genres !== undefined) {
        updateData.userGenres = genres;
        hasOverrides = true;
      }
  
      // Set override flag
      if (hasOverrides) {
        updateData.hasUserOverrides = true;
      }
  
      // Reassign canonical MBID if provided (trim once; skip empty/whitespace/non-string)
      const trimmedMbid = typeof mbid === "string" ? mbid.trim() : "";
      if (trimmedMbid !== "") {
        try {
          await reassignArtistMbid(req.params.id, trimmedMbid);
        } catch (err) {
          if (err instanceof DuplicateMbidError) {
            return res.status(409).json({
              error: `MBID ${trimmedMbid} is already in use by another artist`,
            });
          }
          throw err;
        }
      }
  
      const artist = await prisma.artist.update({
        where: { id: req.params.id },
        data: updateData,
        include: {
          albums: {
            select: {
              id: true,
              title: true,
              year: true,
              coverUrl: true,
            },
          },
        },
      });
  
      // Invalidate Redis cache for artist hero image
      try {
        await redisClient.del(`hero:${req.params.id}`);
      } catch (err) {
        logger.warn("Failed to invalidate Redis cache:", err);
      }
  
      res.json(artist);
    } catch (error) {
      safeError(res, "Update artist metadata", error);
    }
  });

/**
 * PUT /enrichment/albums/:id/metadata
 * Update album metadata manually (non-destructive overrides)
 * User edits are stored as overrides; canonical data preserved for API lookups
 */
router.put("/albums/:id/metadata", requireAuth, requireAdmin, async (req, res) => {
    try {
      const { title, year, genres, coverUrl, rgMbid } = req.body;
  
      const updateData: any = {};
      let hasOverrides = false;
  
      // Map user edits to override fields (non-destructive)
      if (title !== undefined) {
        updateData.displayTitle = title;
        hasOverrides = true;

        // sortName follows displayTitle, like the artist override. artistSortName is
        // text-generic, so it serves albums too.
        const effectiveTitle =
          typeof title === "string" && title.trim() !== ""
            ? title
            : ((
                await prisma.album.findUnique({
                  where: { id: req.params.id },
                  select: { title: true },
                })
              )?.title ?? "");
        updateData.sortName = artistSortName(effectiveTitle);
      }
      if (year !== undefined) {
        // An emptied field arrives as null (parseInt("") is NaN, which JSON sends as
        // null) and removes the override.
        const parsedYear = year === null || year === "" ? null : parseInt(year, 10);
        if (parsedYear !== null && Number.isNaN(parsedYear)) {
          return res.status(400).json({ error: "year must be a number" });
        }
        updateData.displayYear = parsedYear;
        hasOverrides = true;
      }
      if (coverUrl !== undefined) {
        updateData.userCoverUrl = coverUrl;
        hasOverrides = true;
      }
      if (genres !== undefined) {
        updateData.userGenres = genres;
        hasOverrides = true;
      }
  
      // Set override flag
      if (hasOverrides) {
        updateData.hasUserOverrides = true;
      }
  
      // Reassign canonical rgMbid if provided (trim once; skip empty/whitespace/non-string)
      const trimmedRgMbid = typeof rgMbid === "string" ? rgMbid.trim() : "";
      if (trimmedRgMbid !== "") {
        try {
          await reassignAlbumRgMbid(req.params.id, trimmedRgMbid, { source: "editor" });
        } catch (err) {
          if (err instanceof DuplicateMbidError) {
            return res.status(409).json({
              error: `rgMbid ${trimmedRgMbid} is already in use by another album`,
            });
          }
          throw err;
        }
      }
  
      const album = await prisma.album.update({
        where: { id: req.params.id },
        data: updateData,
        include: {
          artist: {
            select: {
              id: true,
              name: true,
            },
          },
          tracks: {
            select: {
              id: true,
              title: true,
              trackNo: true,
              duration: true,
            },
          },
        },
      });
  
      res.json(album);
    } catch (error) {
      safeError(res, "Update album metadata", error);
    }
  });

/**
 * PUT /enrichment/tracks/:id/metadata
 * Update track metadata manually (non-destructive overrides)
 * User edits are stored as overrides; canonical data preserved
 */
router.put("/tracks/:id/metadata", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, trackNo } = req.body;

    const updateData: any = {};
    let hasOverrides = false;

    // Map user edits to override fields (non-destructive)
    if (title !== undefined) {
      updateData.displayTitle = title;
      hasOverrides = true;
    }
    if (trackNo !== undefined) {
      // Same as displayYear above: null clears the override, anything unparseable is the
      // caller's mistake and gets a 400 rather than a 500.
      const parsedTrackNo = trackNo === null || trackNo === "" ? null : parseInt(trackNo, 10);
      if (parsedTrackNo !== null && Number.isNaN(parsedTrackNo)) {
        return res.status(400).json({ error: "trackNo must be a number" });
      }
      updateData.displayTrackNo = parsedTrackNo;
      hasOverrides = true;
    }

    // Set override flag
    if (hasOverrides) {
      updateData.hasUserOverrides = true;
    }

    const track = await prisma.track.update({
      where: { id: req.params.id },
      data: updateData,
      include: {
        album: {
          select: {
            id: true,
            title: true,
            artist: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    res.json(track);
  } catch (error) {
    safeError(res, "Update track metadata", error);
  }
});

/**
 * POST /enrichment/artists/:id/reset
 * Reset artist metadata to canonical values (clear all user overrides)
 */
router.post("/artists/:id/reset", requireAuth, async (req, res) => {
  try {
    // Check if artist exists first
    const existingArtist = await prisma.artist.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true },
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
      include: {
        albums: {
          select: {
            id: true,
            title: true,
            year: true,
            coverUrl: true,
          },
        },
      },
    });

    // Invalidate Redis cache for artist hero image
    try {
      await redisClient.del(`hero:${req.params.id}`);
    } catch (err) {
      logger.warn("Failed to invalidate Redis cache:", err);
    }

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
router.post("/albums/:id/reset", requireAuth, async (req, res) => {
  try {
    // Check if album exists first
    const existingAlbum = await prisma.album.findUnique({
      where: { id: req.params.id },
      select: { id: true, title: true },
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
      include: {
        artist: {
          select: {
            id: true,
            name: true,
          },
        },
        tracks: {
          select: {
            id: true,
            title: true,
            trackNo: true,
            duration: true,
          },
        },
      },
    });

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
router.post("/tracks/:id/reset", requireAuth, async (req, res) => {
  try {
    // Check if track exists first
    const existingTrack = await prisma.track.findUnique({
      where: { id: req.params.id },
      select: { id: true },
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
      include: {
        album: {
          select: {
            id: true,
            title: true,
            artist: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

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
router.get("/concurrency", requireAuth, async (_req, res) => {
  try {
    const settings = await getSystemSettings();
    const concurrency = settings?.enrichmentConcurrency || 1;

    // Calculate estimated speeds based on concurrency
    const artistsPerMin = Math.round(10 * concurrency);
    const tracksPerMin = Math.round(60 * concurrency);

    res.json({
      concurrency,
      estimatedSpeed: `~${artistsPerMin} artists/min, ~${tracksPerMin} tracks/min`,
      artistsPerMin,
      tracksPerMin,
    });
  } catch (error) {
    logger.error("Failed to get enrichment settings:", error);
    res.status(500).json({ error: "Failed to get enrichment settings" });
  }
});

/**
 * PUT /enrichment/concurrency
 * Update enrichment concurrency configuration
 */
router.put("/concurrency", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { concurrency } = req.body;

    if (!concurrency || typeof concurrency !== "number") {
      return res
        .status(400)
        .json({ error: "Missing or invalid 'concurrency' parameter" });
    }

    // Clamp concurrency to 1-5
    const clampedConcurrency = Math.max(
      1,
      Math.min(5, Math.floor(concurrency)),
    );

    // Update system settings in database

    await prisma.systemSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        enrichmentConcurrency: clampedConcurrency,
      },
      update: {
        enrichmentConcurrency: clampedConcurrency,
      },
    });

    // Invalidate cache so next read gets fresh value
    invalidateSystemSettingsCache();

    // Update rate limiter concurrency multiplier
    rateLimiter.updateConcurrencyMultiplier(clampedConcurrency);

    // Calculate estimated speeds
    const artistsPerMin = Math.round(10 * clampedConcurrency);
    const tracksPerMin = Math.round(60 * clampedConcurrency);

    logger.debug(
      `[Enrichment Settings] Updated concurrency to ${clampedConcurrency}`,
    );

    res.json({
      concurrency: clampedConcurrency,
      estimatedSpeed: `~${artistsPerMin} artists/min, ~${tracksPerMin} tracks/min`,
      artistsPerMin,
      tracksPerMin,
    });
  } catch (error) {
    logger.error("Failed to update enrichment settings:", error);
    res.status(500).json({ error: "Failed to update enrichment settings" });
  }
});

export default router;
