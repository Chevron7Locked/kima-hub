import { Router } from "express";
import { logger } from "../utils/logger";
import { safeError } from "../utils/errors";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { enrichmentService } from "../services/enrichment";
import { prisma } from "../utils/db";
import {
  getEnrichmentProgress,
  runFullEnrichment,
  reRunArtistsOnly,
  reRunMoodTagsOnly,
  reRunAudioAnalysisOnly,
  triggerEnrichmentNow,
} from "../workers/unifiedEnrichment";
import { enrichmentStateService } from "../services/enrichmentState";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import {
  getSystemSettings,
  invalidateSystemSettingsCache,
} from "../utils/systemSettings";
import { rateLimiter } from "../services/rateLimiter";
import { redisClient } from "../utils/redis";

const router = Router();

router.use(requireAuth);

/**
 * GET /enrichment/progress
 * Get comprehensive enrichment progress (artists, track tags, audio analysis)
 */
router.get("/progress", async (req, res) => {
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
router.get("/status", async (req, res) => {
  try {
    const state = await enrichmentStateService.getState();
    res.json(state || { status: "idle", currentPhase: null });
  } catch (error) {
    logger.error("Get enrichment status error:", error);
    res.status(500).json({ error: "Failed to get status" });
  }
});

/**
 * POST /enrichment/pause
 * Pause the enrichment process
 */
router.post("/pause", requireAdmin, async (req, res) => {
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
router.post("/resume", requireAdmin, async (req, res) => {
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
router.post("/stop", requireAdmin, async (req, res) => {
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
 * POST /enrichment/full
 * Trigger full enrichment (re-enriches everything regardless of status)
 * Admin only
 */
router.post("/full", requireAdmin, async (req, res) => {
  try {
    // This runs in the background
    runFullEnrichment().catch((err) => {
      logger.error("Full enrichment error:", err);
    });

    res.json({
      message: "Full enrichment started",
      description:
        "All artists, track tags, and audio analysis will be re-processed",
    });
  } catch (error) {
    logger.error("Trigger full enrichment error:", error);
    res.status(500).json({ error: "Failed to start full enrichment" });
  }
});

/**
 * POST /enrichment/reset-artists
 * Reset only artist enrichment (keeps mood tags and audio analysis intact)
 * Admin only - selective re-enrichment for large libraries
 */
router.post("/reset-artists", requireAdmin, async (req, res) => {
  try {
    const result = await reRunArtistsOnly();

    res.json({
      message: "Artist enrichment reset",
      description: `${result.count} artists queued for re-enrichment`,
      count: result.count,
    });
  } catch (error) {
    logger.error("Reset artists error:", error);
    res.status(500).json({ error: "Failed to reset artist enrichment" });
  }
});

/**
 * POST /enrichment/reset-mood-tags
 * Reset only mood tags (keeps artist metadata and audio analysis intact)
 * Admin only - selective re-enrichment for large libraries
 */
router.post("/reset-mood-tags", requireAdmin, async (req, res) => {
  try {
    const result = await reRunMoodTagsOnly();

    res.json({
      message: "Mood tags reset",
      description: `${result.count} tracks queued for mood tag re-enrichment`,
      count: result.count,
    });
  } catch (error) {
    logger.error("Reset mood tags error:", error);
    res.status(500).json({ error: "Failed to reset mood tags" });
  }
});

/**
 * POST /enrichment/reset-audio-analysis
 * Reset only audio analysis (keeps artist metadata and mood tags intact)
 * Admin only - selective re-enrichment for large libraries
 */
router.post("/reset-audio-analysis", requireAdmin, async (req, res) => {
  try {
    const queued = await reRunAudioAnalysisOnly();

    res.json({
      message: "Audio analysis reset",
      description: `${queued} tracks queued for audio re-analysis`,
      count: queued,
    });
  } catch (error) {
    logger.error("Reset audio analysis error:", error);
    res.status(500).json({ error: "Failed to reset audio analysis" });
  }
});

/**
 * POST /enrichment/sync
 * Trigger incremental enrichment (only processes pending items)
 * Fast sync that picks up new content without re-processing everything
 */
router.post("/sync", async (req, res) => {
  try {
    const result = await triggerEnrichmentNow();

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
 * GET /enrichment/settings
 * Get enrichment settings for current user
 */
router.get("/settings", async (req, res) => {
  try {
    const userId = req.user!.id;
    const settings = await enrichmentService.getSettings(userId);
    res.json(settings);
  } catch (error) {
    logger.error("Get enrichment settings error:", error);
    res.status(500).json({ error: "Failed to get settings" });
  }
});

/**
 * PUT /enrichment/settings
 * Update enrichment settings for current user
 */
router.put("/settings", async (req, res) => {
  try {
    const userId = req.user!.id;
    const settings = await enrichmentService.updateSettings(userId, req.body);
    res.json(settings);
  } catch (error) {
    logger.error("Update enrichment settings error:", error);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

/**
 * POST /enrichment/artist/:id
 * Enrich a single artist
 */
router.post("/artist/:id", async (req, res) => {
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
router.post("/album/:id", async (req, res) => {
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
 * POST /enrichment/start
 * Start library-wide enrichment (runs in background)
 * Delegates to the unified enrichment worker for consistent state tracking,
 * failure recording, and pause/stop support.
 */
router.post("/start", async (req, res) => {
  try {
    const systemSettings = await prisma.systemSettings.findUnique({
      where: { id: "default" },
      select: { autoEnrichMetadata: true },
    });

    if (!systemSettings?.autoEnrichMetadata) {
      return res.status(400).json({
        error: "Enrichment is not enabled. Enable it in settings first.",
      });
    }

    // Run via unified worker (handles state, failures, notifications)
    runFullEnrichment().catch((err) => {
      logger.error("Background enrichment failed:", err);
    });

    res.json({
      success: true,
      message: "Library enrichment started in background",
    });
  } catch (error) {
    safeError(res, "Start library enrichment", error);
  }
});

/**
 * GET /enrichment/failures
 * Get all enrichment failures with filtering
 */
router.get("/failures", async (req, res) => {
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
router.get("/failures/counts", async (req, res) => {
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
router.post("/retry", requireAdmin, async (req, res) => {
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

    // Group by type and trigger appropriate re-enrichment

    let queued = 0;
    let skipped = 0;

    for (const failure of failures) {
      if (!failure) continue;

      try {
        if (failure.entityType === "artist") {
          // Check if artist still exists
          const artist = await prisma.artist.findUnique({
            where: { id: failure.entityId },
            select: { id: true },
          });

          if (!artist) {
            // Entity was deleted - mark failure as resolved
            await enrichmentFailureService.resolveFailures([failure.id]);
            skipped++;
            continue;
          }

          // Reset artist enrichment status
          await prisma.artist.update({
            where: { id: failure.entityId },
            data: { enrichmentStatus: "pending" },
          });
          queued++;
        } else if (failure.entityType === "track") {
          // Check if track still exists
          const track = await prisma.track.findUnique({
            where: { id: failure.entityId },
            select: { id: true },
          });

          if (!track) {
            // Entity was deleted - mark failure as resolved
            await enrichmentFailureService.resolveFailures([failure.id]);
            skipped++;
            continue;
          }

          // Reset track tag status
          await prisma.track.update({
            where: { id: failure.entityId },
            data: { lastfmTags: [] },
          });
          queued++;
        } else if (failure.entityType === "audio") {
          // Check if track still exists
          const track = await prisma.track.findUnique({
            where: { id: failure.entityId },
            select: { id: true },
          });

          if (!track) {
            // Entity was deleted - mark failure as resolved
            await enrichmentFailureService.resolveFailures([failure.id]);
            skipped++;
            continue;
          }

          // Reset audio analysis status
          await prisma.track.update({
            where: { id: failure.entityId },
            data: {
              analysisStatus: "pending",
              analysisRetryCount: 0,
            },
          });
          queued++;
        }
      } catch (error) {
        logger.error(
          `Failed to reset ${failure.entityType} ${failure.entityId}:`,
          error,
        );
        // Don't re-throw - continue processing other failures
      }
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
 * POST /enrichment/skip
 * Skip specific failures (won't retry automatically)
 */
router.post("/skip", requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ error: "Must provide array of failure IDs" });
    }

    const count = await enrichmentFailureService.skipFailures(ids);
    res.json({
      message: `Skipped ${count} failures`,
      count,
    });
  } catch (error) {
    safeError(res, "Skip enrichment failures", error);
  }
});

/**
 * DELETE /enrichment/failures
 * Clear all unresolved failures (optionally filtered by type)
 */
router.delete("/failures", requireAdmin, async (req, res) => {
  try {
    const entityType = req.query.entityType as
      | "artist"
      | "track"
      | "audio"
      | undefined;

    if (entityType && !["artist", "track", "audio"].includes(entityType)) {
      return res.status(400).json({ error: "Invalid entityType" });
    }

    const count = await enrichmentFailureService.clearAllFailures(entityType);

    res.json({
      message: `Cleared ${count} failure${count !== 1 ? "s" : ""}`,
      count,
    });
  } catch (error) {
    safeError(res, "Clear enrichment failures", error);
  }
});

/**
 * DELETE /enrichment/failures/:id
 * Delete a specific failure record
 */
router.delete("/failures/:id", requireAdmin, async (req, res) => {
  try {
    const count = await enrichmentFailureService.deleteFailures([
      req.params.id,
    ]);
    res.json({
      message: "Failure deleted",
      count,
    });
  } catch (error) {
    safeError(res, "Delete enrichment failure", error);
  }
});

/**
 * PUT /enrichment/artists/:id/metadata
 * Update artist metadata manually (non-destructive overrides)
 * User edits are stored as overrides; canonical data preserved for API lookups
 */
router.put("/artists/:id/metadata", async (req, res) => {
  try {
    const { name, bio, genres, heroUrl } = req.body;

    const updateData: any = {};
    let hasOverrides = false;

    // Map user edits to override fields (non-destructive)
    if (name !== undefined) {
      updateData.displayName = name;
      hasOverrides = true;
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
router.put("/albums/:id/metadata", async (req, res) => {
  try {
    const { title, year, genres, coverUrl } = req.body;

    const updateData: any = {};
    let hasOverrides = false;

    // Map user edits to override fields (non-destructive)
    if (title !== undefined) {
      updateData.displayTitle = title;
      hasOverrides = true;
    }
    if (year !== undefined) {
      updateData.displayYear = parseInt(year);
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
router.put("/tracks/:id/metadata", async (req, res) => {
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
      updateData.displayTrackNo = parseInt(trackNo);
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
router.post("/artists/:id/reset", async (req, res) => {
  try {
    // Check if artist exists first
    const existingArtist = await prisma.artist.findUnique({
      where: { id: req.params.id },
      select: { id: true },
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
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2025") {
      return res.status(404).json({
        error: "Artist not found",
        message: "The artist may have been deleted",
      });
    }
    safeError(res, "Reset artist metadata", error);
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
      select: { id: true },
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
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2025") {
      return res.status(404).json({
        error: "Album not found",
        message: "The album may have been deleted",
      });
    }
    safeError(res, "Reset album metadata", error);
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
    if (typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "P2025") {
      return res.status(404).json({
        error: "Track not found",
        message: "The track may have been deleted",
      });
    }
    safeError(res, "Reset track metadata", error);
  }
});

/**
 * GET /enrichment/concurrency
 * Get current enrichment concurrency configuration
 */
router.get("/concurrency", async (req, res) => {
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
router.put("/concurrency", requireAdmin, async (req, res) => {
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
