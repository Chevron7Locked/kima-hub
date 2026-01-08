import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { enrichmentService } from "../services/enrichment";
import {
    getEnrichmentProgress,
    runFullEnrichment,
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
    } catch (error: any) {
        logger.error("Pause enrichment error:", error);
        res.status(400).json({
            error: error.message || "Failed to pause enrichment",
        });
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
    } catch (error: any) {
        logger.error("Resume enrichment error:", error);
        res.status(400).json({
            error: error.message || "Failed to resume enrichment",
        });
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
    } catch (error: any) {
        logger.error("Stop enrichment error:", error);
        res.status(400).json({
            error: error.message || "Failed to stop enrichment",
        });
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
 * POST /enrichment/sync
 * Trigger incremental enrichment (only processes pending items)
 * Fast sync that picks up new content without re-processing everything
 */
router.post("/sync", async (req, res) => {
    try {
        const { triggerEnrichmentNow } = await import(
            "../workers/unifiedEnrichment"
        );

        // Trigger immediate enrichment cycle (incremental mode)
        const result = await triggerEnrichmentNow();

        res.json({
            message: "Incremental sync started",
            description: "Processing new and pending items only",
            result,
        });
    } catch (error: any) {
        logger.error("Trigger sync error:", error);
        res.status(500).json({
            error: error.message || "Failed to start sync",
        });
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
        const settings = await enrichmentService.updateSettings(
            userId,
            req.body
        );
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
            settings
        );

        if (!enrichmentData) {
            return res.status(404).json({ error: "No enrichment data found" });
        }

        if (enrichmentData.confidence > 0.3) {
            await enrichmentService.applyArtistEnrichment(
                req.params.id,
                enrichmentData
            );
        }

        res.json({
            success: true,
            confidence: enrichmentData.confidence,
            data: enrichmentData,
        });
    } catch (error: any) {
        logger.error("Enrich artist error:", error);
        res.status(500).json({
            error: error.message || "Failed to enrich artist",
        });
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
            settings
        );

        if (!enrichmentData) {
            return res.status(404).json({ error: "No enrichment data found" });
        }

        if (enrichmentData.confidence > 0.3) {
            await enrichmentService.applyAlbumEnrichment(
                req.params.id,
                enrichmentData
            );
        }

        res.json({
            success: true,
            confidence: enrichmentData.confidence,
            data: enrichmentData,
        });
    } catch (error: any) {
        logger.error("Enrich album error:", error);
        res.status(500).json({
            error: error.message || "Failed to enrich album",
        });
    }
});

/**
 * POST /enrichment/start
 * Start library-wide enrichment (runs in background)
 */
router.post("/start", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { notificationService } = await import(
            "../services/notificationService"
        );

        // Check if enrichment is enabled in system settings
        const { prisma } = await import("../utils/db");
        const systemSettings = await prisma.systemSettings.findUnique({
            where: { id: "default" },
            select: { autoEnrichMetadata: true },
        });

        if (!systemSettings?.autoEnrichMetadata) {
            return res.status(400).json({
                error: "Enrichment is not enabled. Enable it in settings first.",
            });
        }

        // Get user enrichment settings or use defaults
        const settings = await enrichmentService.getSettings(userId);

        // Override enabled flag with system setting
        settings.enabled = true;

        // Send notification that enrichment is starting
        await notificationService.notifySystem(
            userId,
            "Library Enrichment Started",
            "Enriching artist metadata in the background..."
        );

        // Start enrichment in background
        enrichmentService
            .enrichLibrary(userId)
            .then(async () => {
                // Send notification when complete
                await notificationService.notifySystem(
                    userId,
                    "Library Enrichment Complete",
                    "All artist metadata has been enriched"
                );
            })
            .catch(async (error) => {
                logger.error("Background enrichment failed:", error);
                await notificationService.create({
                    userId,
                    type: "error",
                    title: "Enrichment Failed",
                    message:
                        error.message || "Failed to enrich library metadata",
                });
            });

        res.json({
            success: true,
            message: "Library enrichment started in background",
        });
    } catch (error: any) {
        logger.error("Start enrichment error:", error);
        res.status(500).json({
            error: error.message || "Failed to start enrichment",
        });
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
            ids.map((id) => enrichmentFailureService.getFailure(id))
        );

        // Group by type and trigger appropriate re-enrichment
        const { prisma } = await import("../utils/db");
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
                        await enrichmentFailureService.resolveFailures([
                            failure.id,
                        ]);
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
                        await enrichmentFailureService.resolveFailures([
                            failure.id,
                        ]);
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
                        await enrichmentFailureService.resolveFailures([
                            failure.id,
                        ]);
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
                    error
                );
                // Don't re-throw - continue processing other failures
            }
        }

        res.json({
            message: `Queued ${queued} items for retry, ${skipped} skipped (entities no longer exist)`,
            queued,
            skipped,
        });
    } catch (error: any) {
        logger.error("Retry failures error:", error);
        res.status(500).json({
            error: error.message || "Failed to retry failures",
        });
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
    } catch (error: any) {
        logger.error("Skip failures error:", error);
        res.status(500).json({
            error: error.message || "Failed to skip failures",
        });
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
    } catch (error: any) {
        logger.error("Delete failure error:", error);
        res.status(500).json({
            error: error.message || "Failed to delete failure",
        });
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

        const { prisma } = await import("../utils/db");
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
    } catch (error: any) {
        logger.error("Update artist metadata error:", error);
        res.status(500).json({
            error: error.message || "Failed to update artist",
        });
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

        const { prisma } = await import("../utils/db");
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
    } catch (error: any) {
        logger.error("Update album metadata error:", error);
        res.status(500).json({
            error: error.message || "Failed to update album",
        });
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

        const { prisma } = await import("../utils/db");
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
    } catch (error: any) {
        logger.error("Update track metadata error:", error);
        res.status(500).json({
            error: error.message || "Failed to update track",
        });
    }
});

/**
 * POST /enrichment/artists/:id/reset
 * Reset artist metadata to canonical values (clear all user overrides)
 */
router.post("/artists/:id/reset", async (req, res) => {
    try {
        const { prisma } = await import("../utils/db");

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
    } catch (error: any) {
        // Handle P2025 specifically in case of race condition
        if (error.code === "P2025") {
            return res.status(404).json({
                error: "Artist not found",
                message: "The artist may have been deleted",
            });
        }
        logger.error("Reset artist metadata error:", error);
        res.status(500).json({
            error: error.message || "Failed to reset artist metadata",
        });
    }
});

/**
 * POST /enrichment/albums/:id/reset
 * Reset album metadata to canonical values (clear all user overrides)
 */
router.post("/albums/:id/reset", async (req, res) => {
    try {
        const { prisma } = await import("../utils/db");

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
    } catch (error: any) {
        // Handle P2025 specifically in case of race condition
        if (error.code === "P2025") {
            return res.status(404).json({
                error: "Album not found",
                message: "The album may have been deleted",
            });
        }
        logger.error("Reset album metadata error:", error);
        res.status(500).json({
            error: error.message || "Failed to reset album metadata",
        });
    }
});

/**
 * POST /enrichment/tracks/:id/reset
 * Reset track metadata to canonical values (clear all user overrides)
 */
router.post("/tracks/:id/reset", async (req, res) => {
    try {
        const { prisma } = await import("../utils/db");

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
    } catch (error: any) {
        // Handle P2025 specifically in case of race condition
        if (error.code === "P2025") {
            return res.status(404).json({
                error: "Track not found",
                message: "The track may have been deleted",
            });
        }
        logger.error("Reset track metadata error:", error);
        res.status(500).json({
            error: error.message || "Failed to reset track metadata",
        });
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
            Math.min(5, Math.floor(concurrency))
        );

        // Update system settings in database
        const { prisma } = await import("../utils/db");
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
            `[Enrichment Settings] Updated concurrency to ${clampedConcurrency}`
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
