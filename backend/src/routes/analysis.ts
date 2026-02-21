import { Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { getSystemSettings, invalidateSystemSettingsCache } from "../utils/systemSettings";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import os from "os";

const router = Router();

// Redis queue key for audio analysis
const ANALYSIS_QUEUE = "audio:analysis:queue";
const VIBE_QUEUE = "audio:clap:queue";

/**
 * GET /api/analysis/status
 * Get audio analysis status and progress
 */
router.get("/status", requireAuth, async (req, res) => {
    try {
        // Get counts by status
        const statusCounts = await prisma.track.groupBy({
            by: ["analysisStatus"],
            _count: true,
        });

        const total = statusCounts.reduce((sum, s) => sum + s._count, 0);
        const completed = statusCounts.find(s => s.analysisStatus === "completed")?._count || 0;
        const failed = statusCounts.find(s => s.analysisStatus === "failed")?._count || 0;
        const processing = statusCounts.find(s => s.analysisStatus === "processing")?._count || 0;
        const pending = statusCounts.find(s => s.analysisStatus === "pending")?._count || 0;

        // Get queue length from Redis
        const queueLength = await redisClient.lLen(ANALYSIS_QUEUE);

        // Get CLAP embedding count
        const embeddingCount = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) as count FROM track_embeddings
        `;
        const withEmbeddings = Number(embeddingCount[0]?.count || 0);

        const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

        res.json({
            total,
            completed,
            failed,
            processing,
            pending,
            queueLength,
            progress,
            isComplete: pending === 0 && processing === 0 && queueLength === 0,
            clap: {
                withEmbeddings,
                embeddingProgress: total > 0 ? Math.round((withEmbeddings / total) * 100) : 0,
            },
        });
    } catch (error: any) {
        logger.error("Analysis status error:", error);
        res.status(500).json({ error: "Failed to get analysis status" });
    }
});

/**
 * POST /api/analysis/start
 * Start audio analysis for pending tracks (admin only)
 */
router.post("/start", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { limit = 100, priority = "recent" } = req.body;

        // Find pending tracks
        const tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "pending",
            },
            select: {
                id: true,
                filePath: true,
                duration: true,
            },
            orderBy: priority === "recent"
                ? { fileModified: "desc" }
                : { title: "asc" },
            take: Math.min(limit, 1000),
        });

        if (tracks.length === 0) {
            return res.json({
                message: "No pending tracks to analyze",
                queued: 0,
            });
        }

        // Queue tracks for analysis
        const pipeline = redisClient.multi();
        for (const track of tracks) {
            pipeline.rPush(ANALYSIS_QUEUE, JSON.stringify({
                trackId: track.id,
                filePath: track.filePath,
                duration: track.duration,
            }));
        }
        await pipeline.exec();

        logger.debug(`Queued ${tracks.length} tracks for audio analysis`);

        res.json({
            message: `Queued ${tracks.length} tracks for analysis`,
            queued: tracks.length,
        });
    } catch (error: any) {
        logger.error("Analysis start error:", error);
        res.status(500).json({ error: "Failed to start analysis" });
    }
});

/**
 * POST /api/analysis/retry-failed
 * Retry failed analysis jobs (admin only)
 */
router.post("/retry-failed", requireAuth, requireAdmin, async (req, res) => {
    try {
        // Reset failed tracks to pending
        const result = await prisma.track.updateMany({
            where: {
                analysisStatus: "failed",
            },
            data: {
                analysisStatus: "pending",
                analysisError: null,
            },
        });

        res.json({
            message: `Reset ${result.count} failed tracks to pending`,
            reset: result.count,
        });
    } catch (error: any) {
        logger.error("Retry failed error:", error);
        res.status(500).json({ error: "Failed to retry analysis" });
    }
});

/**
 * POST /api/analysis/analyze/:trackId
 * Queue a specific track for analysis
 */
router.post("/analyze/:trackId", requireAuth, async (req, res) => {
    try {
        const { trackId } = req.params;

        const track = await prisma.track.findUnique({
            where: { id: trackId },
            select: {
                id: true,
                filePath: true,
                duration: true,
                analysisStatus: true,
            },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        // Queue for analysis
        await redisClient.rPush(ANALYSIS_QUEUE, JSON.stringify({
            trackId: track.id,
            filePath: track.filePath,
            duration: track.duration,
        }));

        // Mark as pending if not already
        if (track.analysisStatus !== "processing") {
            await prisma.track.update({
                where: { id: trackId },
                data: { analysisStatus: "pending" },
            });
        }

        res.json({
            message: "Track queued for analysis",
            trackId,
        });
    } catch (error: any) {
        logger.error("Analyze track error:", error);
        res.status(500).json({ error: "Failed to queue track for analysis" });
    }
});

/**
 * GET /api/analysis/track/:trackId
 * Get analysis data for a specific track
 */
router.get("/track/:trackId", requireAuth, async (req, res) => {
    try {
        const { trackId } = req.params;

        const track = await prisma.track.findUnique({
            where: { id: trackId },
            select: {
                id: true,
                title: true,
                analysisStatus: true,
                analysisError: true,
                analyzedAt: true,
                analysisVersion: true,
                analysisMode: true,
                bpm: true,
                beatsCount: true,
                key: true,
                keyScale: true,
                keyStrength: true,
                energy: true,
                loudness: true,
                dynamicRange: true,
                danceability: true,
                valence: true,
                arousal: true,
                instrumentalness: true,
                acousticness: true,
                speechiness: true,
                // MusiCNN mood predictions
                moodHappy: true,
                moodSad: true,
                moodRelaxed: true,
                moodAggressive: true,
                moodParty: true,
                moodAcoustic: true,
                moodElectronic: true,
                moodTags: true,
                essentiaGenres: true,
                lastfmTags: true,
            },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        res.json(track);
    } catch (error: any) {
        logger.error("Get track analysis error:", error);
        res.status(500).json({ error: "Failed to get track analysis" });
    }
});

/**
 * GET /api/analysis/features
 * Get aggregated feature statistics for the library
 */
router.get("/features", requireAuth, async (req, res) => {
    try {
        // Get analyzed tracks
        const analyzed = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                bpm: { not: null },
            },
            select: {
                bpm: true,
                energy: true,
                danceability: true,
                valence: true,
                keyScale: true,
            },
        });

        if (analyzed.length === 0) {
            return res.json({
                count: 0,
                averages: null,
                distributions: null,
            });
        }

        // Calculate averages
        const avgBpm = analyzed.reduce((sum, t) => sum + (t.bpm || 0), 0) / analyzed.length;
        const avgEnergy = analyzed.reduce((sum, t) => sum + (t.energy || 0), 0) / analyzed.length;
        const avgDanceability = analyzed.reduce((sum, t) => sum + (t.danceability || 0), 0) / analyzed.length;
        const avgValence = analyzed.reduce((sum, t) => sum + (t.valence || 0), 0) / analyzed.length;

        // Key distribution
        const majorCount = analyzed.filter(t => t.keyScale === "major").length;
        const minorCount = analyzed.filter(t => t.keyScale === "minor").length;

        // BPM distribution (buckets)
        const bpmBuckets = {
            slow: analyzed.filter(t => (t.bpm || 0) < 90).length,
            moderate: analyzed.filter(t => (t.bpm || 0) >= 90 && (t.bpm || 0) < 120).length,
            upbeat: analyzed.filter(t => (t.bpm || 0) >= 120 && (t.bpm || 0) < 150).length,
            fast: analyzed.filter(t => (t.bpm || 0) >= 150).length,
        };

        res.json({
            count: analyzed.length,
            averages: {
                bpm: Math.round(avgBpm),
                energy: Math.round(avgEnergy * 100) / 100,
                danceability: Math.round(avgDanceability * 100) / 100,
                valence: Math.round(avgValence * 100) / 100,
            },
            distributions: {
                key: { major: majorCount, minor: minorCount },
                bpm: bpmBuckets,
            },
        });
    } catch (error: any) {
        logger.error("Get features error:", error);
        res.status(500).json({ error: "Failed to get feature statistics" });
    }
});

/**
 * GET /api/analysis/workers
 * Get current audio analyzer worker configuration
 */
router.get("/workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const settings = await getSystemSettings();
        const cpuCores = os.cpus().length;
        const currentWorkers = settings?.audioAnalyzerWorkers || 2;
        
        // Recommended: 50% of CPU cores, min 2, max 8
        const recommended = Math.max(2, Math.min(8, Math.floor(cpuCores / 2)));
        
        res.json({
            workers: currentWorkers,
            cpuCores,
            recommended,
            description: `Using ${currentWorkers} of ${cpuCores} available CPU cores`,
        });
    } catch (error: any) {
        logger.error("Get workers config error:", error);
        res.status(500).json({ error: "Failed to get worker configuration" });
    }
});

/**
 * PUT /api/analysis/workers
 * Update audio analyzer worker count
 */
router.put("/workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { workers } = req.body;
        
        if (typeof workers !== 'number' || workers < 1 || workers > 8) {
            return res.status(400).json({ 
                error: "Workers must be a number between 1 and 8" 
            });
        }
        
        // Update SystemSettings
        await prisma.systemSettings.update({
            where: { id: "default" },
            data: { audioAnalyzerWorkers: workers },
        });
        invalidateSystemSettingsCache();

        // Publish control signal to Redis for Python worker to pick up
        await redisClient.publish(
            "audio:analysis:control",
            JSON.stringify({ command: "set_workers", count: workers })
        );
        
        const cpuCores = os.cpus().length;
        const recommended = Math.max(2, Math.min(8, Math.floor(cpuCores / 2)));
        
        logger.info(`Audio analyzer workers updated to ${workers}`);
        
        res.json({
            workers,
            cpuCores,
            recommended,
            description: `Using ${workers} of ${cpuCores} available CPU cores`,
        });
    } catch (error: any) {
        logger.error("Update workers config error:", error);
        res.status(500).json({ error: "Failed to update worker configuration" });
    }
});

/**
 * GET /api/analysis/clap-workers
 * Get current CLAP analyzer worker configuration
 */
router.get("/clap-workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const settings = await getSystemSettings();
        const cpuCores = os.cpus().length;
        const currentWorkers = settings?.clapWorkers || 2;

        const recommended = Math.max(1, Math.min(8, Math.floor(cpuCores / 2)));

        res.json({
            workers: currentWorkers,
            cpuCores,
            recommended,
            description: `Using ${currentWorkers} of ${cpuCores} available CPU cores`,
        });
    } catch (error: any) {
        logger.error("Get CLAP workers config error:", error);
        res.status(500).json({ error: "Failed to get CLAP worker configuration" });
    }
});

/**
 * PUT /api/analysis/clap-workers
 * Update CLAP analyzer worker count
 */
router.put("/clap-workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { workers } = req.body;

        if (typeof workers !== 'number' || workers < 1 || workers > 8) {
            return res.status(400).json({
                error: "CLAP workers must be a number between 1 and 8"
            });
        }

        // Update SystemSettings
        await prisma.systemSettings.update({
            where: { id: "default" },
            data: { clapWorkers: workers },
        });
        invalidateSystemSettingsCache();

        // Publish control signal to Redis for CLAP analyzer to pick up
        await redisClient.publish(
            "audio:clap:control",
            JSON.stringify({ command: "set_workers", count: workers })
        );

        const cpuCores = os.cpus().length;
        const recommended = Math.max(1, Math.min(8, Math.floor(cpuCores / 2)));

        logger.info(`CLAP analyzer workers updated to ${workers}`);

        res.json({
            workers,
            cpuCores,
            recommended,
            description: `Using ${workers} of ${cpuCores} available CPU cores`,
        });
    } catch (error: any) {
        logger.error("Update CLAP workers config error:", error);
        res.status(500).json({ error: "Failed to update CLAP worker configuration" });
    }
});

/**
 * POST /api/analysis/vibe/failure
 * Record a vibe embedding failure (called by CLAP analyzer)
 */
router.post("/vibe/failure", async (req, res) => {
    // Internal endpoint - verify shared secret from CLAP analyzer
    const internalSecret = req.headers["x-internal-secret"];
    if (!process.env.INTERNAL_API_SECRET || internalSecret !== process.env.INTERNAL_API_SECRET) {
        return res.status(403).json({ error: "Forbidden" });
    }

    try {
        const { trackId, trackName, errorMessage, errorCode } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: "trackId is required" });
        }

        await enrichmentFailureService.recordFailure({
            entityType: "vibe",
            entityId: trackId,
            entityName: trackName,
            errorMessage: errorMessage || "Vibe embedding generation failed",
            errorCode: errorCode,
        });

        res.json({ message: "Failure recorded" });
    } catch (error: any) {
        logger.error("Record vibe failure error:", error);
        res.status(500).json({ error: "Failed to record failure" });
    }
});

/**
 * POST /api/analysis/vibe/start
 * Queue tracks for vibe embedding generation (admin only)
 *
 * @param force - If true, delete all embeddings and re-queue all tracks
 */
router.post("/vibe/start", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { limit = 500, force = false } = req.body;

        // If force mode, delete all existing embeddings first
        if (force) {
            await prisma.$executeRaw`DELETE FROM track_embeddings`;
            await enrichmentFailureService.clearAllFailures("vibe");
            await prisma.track.updateMany({
                where: { vibeAnalysisStatus: { in: ["failed", "processing"] } },
                data: { vibeAnalysisStatus: null, vibeAnalysisRetryCount: 0, vibeAnalysisStatusUpdatedAt: null },
            });
            logger.info("Cleared all vibe embeddings for re-generation");
        }

        // Find tracks without vibe embeddings (all tracks if force was used)
        const tracks = await prisma.$queryRaw<{ id: string; filePath: string; duration: number; title: string }[]>`
            SELECT t.id, t."filePath", t.duration, t.title
            FROM "Track" t
            LEFT JOIN track_embeddings te ON t.id = te.track_id
            WHERE te.track_id IS NULL
            AND t."filePath" IS NOT NULL
            ORDER BY t."fileModified" DESC
            LIMIT ${limit}
        `;

        if (tracks.length === 0) {
            return res.json({
                message: "All tracks have vibe embeddings",
                queued: 0,
            });
        }

        // Queue tracks for CLAP embedding
        const pipeline = redisClient.multi();
        for (const track of tracks) {
            pipeline.rPush(VIBE_QUEUE, JSON.stringify({
                trackId: track.id,
                filePath: track.filePath,
                duration: track.duration,
            }));
        }
        await pipeline.exec();

        // Clear any existing vibe failures for these tracks
        for (const track of tracks) {
            await enrichmentFailureService.clearFailure("vibe", track.id);
        }

        logger.info(`Queued ${tracks.length} tracks for vibe embedding${force ? " (force reset)" : ""}`);

        res.json({
            message: `Queued ${tracks.length} tracks for vibe embedding`,
            queued: tracks.length,
        });
    } catch (error: any) {
        logger.error("Start vibe embedding error:", error);
        res.status(500).json({ error: "Failed to start vibe embedding" });
    }
});

/**
 * POST /api/analysis/vibe/retry
 * Retry failed vibe embeddings (admin only)
 */
router.post("/vibe/retry", requireAuth, requireAdmin, async (req, res) => {
    try {
        // Get all vibe failures
        const { failures } = await enrichmentFailureService.getFailures({
            entityType: "vibe",
            includeSkipped: false,
            includeResolved: false,
        });

        if (failures.length === 0) {
            return res.json({
                message: "No vibe failures to retry",
                queued: 0,
            });
        }

        // Get track details for failed tracks
        const trackIds = failures.map(f => f.entityId);
        const tracks = await prisma.track.findMany({
            where: { id: { in: trackIds } },
            select: { id: true, filePath: true, duration: true, title: true },
        });

        // Reset Track-level retry counts so queueVibeEmbeddings can pick them up again
        await prisma.track.updateMany({
            where: { id: { in: trackIds } },
            data: { vibeAnalysisStatus: null, vibeAnalysisRetryCount: 0, vibeAnalysisStatusUpdatedAt: null },
        });

        // Queue for retry
        const pipeline = redisClient.multi();
        for (const track of tracks) {
            pipeline.rPush(VIBE_QUEUE, JSON.stringify({
                trackId: track.id,
                filePath: track.filePath,
                duration: track.duration,
            }));
        }
        await pipeline.exec();

        // Reset EnrichmentFailure retry counts
        await enrichmentFailureService.resetRetryCount(failures.map(f => f.id));

        logger.info(`Retrying ${tracks.length} failed vibe embeddings`);

        res.json({
            message: `Queued ${tracks.length} failed tracks for vibe embedding retry`,
            queued: tracks.length,
        });
    } catch (error: any) {
        logger.error("Retry vibe failures error:", error);
        res.status(500).json({ error: "Failed to retry vibe failures" });
    }
});

/**
 * POST /api/analysis/vibe/success
 * Resolve failure records when a vibe embedding succeeds (called by CLAP analyzer)
 */
router.post("/vibe/success", async (req, res) => {
    // Internal endpoint - verify shared secret from CLAP analyzer
    const internalSecret = req.headers["x-internal-secret"];
    if (!process.env.INTERNAL_API_SECRET || internalSecret !== process.env.INTERNAL_API_SECRET) {
        return res.status(403).json({ error: "Forbidden" });
    }

    try {
        const { trackId } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: "trackId is required" });
        }

        // Resolve any stale failure records for this track
        await enrichmentFailureService.resolveByEntity("vibe", trackId);

        res.json({ message: "Stale failures resolved" });
    } catch (error: any) {
        logger.error("Resolve vibe failure error:", error);
        res.status(500).json({ error: "Failed to resolve failures" });
    }
});

export default router;
