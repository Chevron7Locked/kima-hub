import { Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { getSystemSettings, invalidateSystemSettingsCache } from "../utils/systemSettings";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { eventBus } from "../services/eventBus";
import { vibeQueue } from "../workers/enrichmentQueues";
import { triggerEnrichmentNow, markScanInvalid } from "../workers/unifiedEnrichment";
import { validateAudioHeader } from "../services/audioScanValidator";
import { config } from "../config";
import path from "path";
import { audioAnalysisCleanupService } from "../services/audioAnalysisCleanup";
import { appendTrackToProjection } from "../services/umapProjection";
import os from "os";

/**
 * Is the analyzer that owns this control channel actually running?
 *
 * Both Python analyzers write a millisecond timestamp to a Redis key every
 * thirty seconds while they are alive; featureDetection already reads the same
 * keys to decide whether a feature is available. Reusing them here is what
 * lets the settings screen say "the analyzer is offline" instead of accepting
 * a worker count and reporting success to nobody.
 *
 * A stale key counts as offline. The window is generous -- ten heartbeats --
 * because a busy analyzer running CLAP inference can be slow to loop.
 */
const ANALYZER_HEARTBEAT_TTL_MS = 300_000; // 5 minutes

async function analyzerIsOnline(heartbeatKey: string): Promise<boolean> {
    try {
        const beat = await redisClient.get(heartbeatKey);
        if (!beat) return false;
        const at = parseInt(beat, 10);
        return !isNaN(at) && Date.now() - at < ANALYZER_HEARTBEAT_TTL_MS;
    } catch {
        // Redis being unreachable is not evidence the analyzer is up.
        return false;
    }
}

/**
 * Send a worker-count change and report honestly what happened to it.
 *
 * Redis PUBLISH returns how many subscribers received the message. Every one
 * of these endpoints used to discard that number and answer 200 regardless, so
 * an admin moving the slider with no analyzer running was told it had worked.
 * The count is the only delivery evidence available, so it is passed on.
 */
/**
 * The sentence the settings screen shows under the slider.
 *
 * It used to always read "Using N of M available CPU cores" whether or not any
 * analyzer existed, which is the whole reason the control looked functional
 * while doing nothing.
 */
function describeWorkers(
    workers: number,
    cpuCores: number,
    online: boolean,
    delivered: number,
): string {
    if (delivered > 0) {
        return `Using ${workers} of ${cpuCores} available CPU cores`;
    }
    if (online) {
        return `Saved. The analyzer is running but did not acknowledge the change; it will use ${workers} core(s) after its next restart.`;
    }
    return `Saved, but no analyzer is running. It will use ${workers} of ${cpuCores} core(s) when it starts.`;
}

async function dispatchWorkerCount(
    channel: string,
    heartbeatKey: string,
    workers: number,
): Promise<{ online: boolean; delivered: number }> {
    const delivered = await redisClient.publish(
        channel,
        JSON.stringify({ command: "set_workers", count: workers }),
    );
    const online = await analyzerIsOnline(heartbeatKey);
    if (delivered === 0) {
        logger.warn(
            `[Analysis] set_workers=${workers} published to ${channel} but no analyzer received it`,
        );
    }
    return { online, delivered };
}

const router = Router();

// Redis queue key for audio analysis (Essentia uses raw Redis BRPOP, not BullMQ)
const ANALYSIS_QUEUE = "audio:analysis:queue";

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

        const rawTotal = statusCounts.reduce((sum, s) => sum + s._count, 0);
        const completed = statusCounts.find(s => s.analysisStatus === "completed")?._count || 0;
        const failed = statusCounts.find(s => s.analysisStatus === "failed")?._count || 0;
        const processing = statusCounts.find(s => s.analysisStatus === "processing")?._count || 0;
        const pending = statusCounts.find(s => s.analysisStatus === "pending")?._count || 0;
        const permanentlyFailed = statusCounts.find(s => s.analysisStatus === "permanently_failed")?._count || 0;

        // Exclude permanently_failed and corrupt tracks from progress denominator
        const corruptCount = await prisma.track.count({ where: { corrupt: true, analysisStatus: { not: "permanently_failed" } } });
        const total = rawTotal - permanentlyFailed - corruptCount;

        // Get queue length from Redis
        const queueLength = await redisClient.llen(ANALYSIS_QUEUE);

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
            permanentlyFailed,
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

        // Find pending tracks. scanStatus must be "valid": this endpoint feeds the same
        // Redis list the Essentia analyzer decodes from, so skipping the corrupt-file
        // check here would put exactly the files that hang a worker back in front of it.
        const tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "pending",
                scanStatus: "valid",
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
            // Separate "nothing to do" from "everything is still waiting on the
            // corrupt-file check", which otherwise look identical from the UI.
            const awaitingScan = await prisma.track.count({
                where: {
                    analysisStatus: "pending",
                    scanStatus: { not: "valid" },
                },
            });
            return res.json({
                message: awaitingScan > 0
                    ? `No tracks ready to analyze -- ${awaitingScan} still awaiting file validation`
                    : "No pending tracks to analyze",
                queued: 0,
                awaitingScan,
            });
        }

        // Queue tracks for analysis
        const pipeline = redisClient.multi();
        for (const track of tracks) {
            pipeline.rpush(ANALYSIS_QUEUE, JSON.stringify({
                trackId: track.id,
                filePath: track.filePath,
                duration: track.duration,
            }));
        }
        await pipeline.exec();

        // Claim the rows we just pushed. Without this they stay "pending", so the
        // background producer re-selects and re-pushes the same tracks on its next
        // cycle and the analyzer decodes each of them twice.
        await prisma.track.updateMany({
            where: { id: { in: tracks.map((t) => t.id) }, analysisStatus: "pending" },
            data: { analysisStatus: "queued" },
        });

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
        const failedResult = await prisma.track.updateMany({
            where: { analysisStatus: "failed" },
            data: {
                analysisStatus: "pending",
                analysisError: null,
                analysisRetryCount: 0,
                scanStatus: "pending",
            },
        });

        const permFailedResult = await prisma.track.updateMany({
            where: { analysisStatus: "permanently_failed" },
            data: {
                analysisStatus: "pending",
                analysisError: null,
                analysisRetryCount: 0,
                scanStatus: "pending",
            },
        });

        // Mark related enrichment failures as resolved
        await prisma.enrichmentFailure.updateMany({
            where: {
                entityType: "audio",
                resolved: false,
            },
            data: {
                resolved: true,
                resolvedAt: new Date(),
            },
        });

        audioAnalysisCleanupService.resetCircuitBreaker();

        const totalReset = failedResult.count + permFailedResult.count;
        res.json({
            message: `Reset ${totalReset} failed tracks to pending`,
            reset: totalReset,
            failed: failedResult.count,
            permanentlyFailed: permFailedResult.count,
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

        // Don't disturb a track a worker is already decoding.
        if (track.analysisStatus === "processing") {
            return res.json({
                message: "Track is already being analyzed",
                trackId,
            });
        }

        // Check the file before handing it to Essentia. This is the same header check
        // the background scan phase runs; doing it inline here means a single-track
        // request gets an answer immediately instead of silently queueing a file that
        // will stall a worker for three minutes and then be retried twice more.
        const musicPath = config.music.musicPath;
        if (!musicPath) {
            // Without it we cannot resolve the file to check it, and queueing an
            // unchecked track is exactly what the gate exists to prevent.
            return res.status(503).json({
                error: "Music library path is not configured",
                trackId,
            });
        }

        const result = await validateAudioHeader(path.join(musicPath, track.filePath));
        if (!result.valid) {
            const reason = result.error ?? "Unknown validation failure";
            await markScanInvalid(track.id, reason);
            return res.status(422).json({
                error: "Track failed file validation",
                reason,
                trackId,
            });
        }
        await prisma.track.update({
            where: { id: trackId },
            data: { scanStatus: "valid", scanError: null, scanStartedAt: null },
        });

        // Queue for analysis, then claim the row -- same order as the background
        // producer. The analyzer flushes this list on worker start, so an entry left
        // behind by a crash between the two is dropped rather than double-decoded.
        await redisClient.rpush(ANALYSIS_QUEUE, JSON.stringify({
            trackId: track.id,
            filePath: track.filePath,
            duration: track.duration,
        }));

        await prisma.track.update({
            where: { id: trackId },
            data: {
                analysisStatus: "queued",
                // An explicit request to analyze this track is a request to start over.
                // Left alone, a count already at the ceiling would have the next
                // enrichment cycle condemn the track to permanently_failed before the
                // analyzer ever reached it.
                analysisRetryCount: 0,
                analysisError: null,
            },
        });

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
        const online = await analyzerIsOnline("audio:worker:heartbeat");

        // Recommended: 50% of CPU cores, min 2, max 8
        const recommended = Math.max(2, Math.min(8, Math.floor(cpuCores / 2)));

        res.json({
            workers: currentWorkers,
            cpuCores,
            recommended,
            analyzerOnline: online,
            description: describeWorkers(currentWorkers, cpuCores, online, online ? 1 : 0),
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
        // upsert, not update: SystemSettings has no row until something writes
        // one, so on a fresh install `update` threw and the endpoint answered
        // 500 -- the worker count could never be changed on a new deployment.
        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: { id: "default", audioAnalyzerWorkers: workers },
            update: { audioAnalyzerWorkers: workers },
        });
        invalidateSystemSettingsCache();

        const { online, delivered } = await dispatchWorkerCount(
            "audio:analysis:control",
            "audio:worker:heartbeat",
            workers,
        );

        const cpuCores = os.cpus().length;
        const recommended = Math.max(2, Math.min(8, Math.floor(cpuCores / 2)));

        logger.info(
            `Audio analyzer workers set to ${workers} (delivered to ${delivered} listener(s))`,
        );

        res.json({
            workers,
            cpuCores,
            recommended,
            analyzerOnline: online,
            delivered,
            description: describeWorkers(workers, cpuCores, online, delivered),
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
        const online = await analyzerIsOnline("clap:worker:heartbeat");

        const recommended = Math.max(1, Math.min(8, Math.floor(cpuCores / 2)));

        res.json({
            workers: currentWorkers,
            cpuCores,
            recommended,
            analyzerOnline: online,
            description: describeWorkers(currentWorkers, cpuCores, online, online ? 1 : 0),
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
        // upsert, not update: SystemSettings has no row until something writes
        // one, so on a fresh install `update` threw and the endpoint answered
        // 500 -- the worker count could never be changed on a new deployment.
        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: { id: "default", clapWorkers: workers },
            update: { clapWorkers: workers },
        });
        invalidateSystemSettingsCache();

        const { online, delivered } = await dispatchWorkerCount(
            "audio:clap:control",
            "clap:worker:heartbeat",
            workers,
        );

        const cpuCores = os.cpus().length;
        const recommended = Math.max(1, Math.min(8, Math.floor(cpuCores / 2)));

        logger.info(
            `CLAP analyzer workers set to ${workers} (delivered to ${delivered} listener(s))`,
        );

        res.json({
            workers,
            cpuCores,
            recommended,
            analyzerOnline: online,
            delivered,
            description: describeWorkers(workers, cpuCores, online, delivered),
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
        eventBus.emit({ type: "enrichment:progress", userId: "*", payload: { phase: "vibe" } });
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
            // Every embedding is gone, so every status must go too --
            // leaving 'completed' on rows with no embedding made any
            // consumer keying on vibeAnalysisStatus lie mid-rebuild.
            await prisma.track.updateMany({
                where: {},
                data: { vibeAnalysisStatus: null, vibeAnalysisRetryCount: 0, vibeAnalysisStatusUpdatedAt: null },
            });
            logger.info("Cleared all vibe embeddings for re-generation");
        }

        // Find analyzed tracks without vibe embeddings (all tracks if force was used).
        // Requires analysisStatus = "completed" to match the reactive pub/sub path
        // in audioCompletionSubscriber.ts.
        const tracks = await prisma.$queryRaw<{ id: string; filePath: string; duration: number; title: string }[]>`
            SELECT t.id, t."filePath", t.duration, t.title
            FROM "Track" t
            LEFT JOIN track_embeddings te ON t.id = te.track_id
            WHERE te.track_id IS NULL
            AND t."filePath" IS NOT NULL
            AND t."analysisStatus" = 'completed'
            ORDER BY t."fileModified" DESC
            LIMIT ${limit}
        `;

        if (tracks.length === 0) {
            return res.json({
                message: "All tracks have vibe embeddings",
                queued: 0,
            });
        }

        // Clean completed AND failed jobs so jobId dedup can't silently drop a
        // re-queued track. This is a manual retry action, so failed jobs are
        // cleared immediately (grace 0) -- the user asked to retry now.
        await vibeQueue.clean(0, 0, "completed");
        await vibeQueue.clean(0, 0, "failed");

        // Queue tracks for CLAP embedding via BullMQ (jobId deduplication)
        await vibeQueue.addBulk(
            tracks.map((track) => ({
                name: "embed",
                data: { trackId: track.id, filePath: track.filePath, duration: track.duration },
                opts: { jobId: `vibe-${track.id}` },
            })),
        );

        // Clear any existing vibe failures for these tracks
        for (const track of tracks) {
            await enrichmentFailureService.clearFailure("vibe", track.id);
        }

        // Restart the enrichment cycle so executeVibePhase sweeps remaining tracks
        await triggerEnrichmentNow();

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

        // Reset Track-level retry counts so the vibe queue can pick them up again
        await prisma.track.updateMany({
            where: { id: { in: trackIds } },
            data: { vibeAnalysisStatus: null, vibeAnalysisRetryCount: 0, vibeAnalysisStatusUpdatedAt: null },
        });

        // Clean completed AND failed jobs so jobId dedup can't silently drop a
        // re-queued track. This is a manual retry action, so failed jobs are
        // cleared immediately (grace 0) -- the user asked to retry now.
        await vibeQueue.clean(0, 0, "completed");
        await vibeQueue.clean(0, 0, "failed");

        // Queue for retry via BullMQ (jobId deduplication)
        await vibeQueue.addBulk(
            tracks.map((track) => ({
                name: "embed",
                data: { trackId: track.id, filePath: track.filePath, duration: track.duration },
                opts: { jobId: `vibe-${track.id}` },
            })),
        );

        // Reset EnrichmentFailure retry counts
        await enrichmentFailureService.resetRetryCount(failures.map(f => f.id));

        // Restart the enrichment cycle so executeVibePhase sweeps remaining tracks
        await triggerEnrichmentNow();

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

        // Incrementally add to vibe map projection (non-blocking)
        appendTrackToProjection(trackId).catch(e =>
            logger.debug(`[VIBE-MAP] Incremental append skipped for ${trackId}:`, (e as Error).message)
        );

        res.json({ message: "Stale failures resolved" });
        eventBus.emit({ type: "enrichment:progress", userId: "*", payload: { phase: "vibe" } });
    } catch (error: any) {
        logger.error("Resolve vibe failure error:", error);
        res.status(500).json({ error: "Failed to resolve failures" });
    }
});

export default router;
