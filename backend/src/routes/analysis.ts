import { Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { getSystemSettings, invalidateSystemSettingsCache } from "../utils/systemSettings";
import { eventBus } from "../services/eventBus";
import { startEnrichmentNow, recordStageSuccess, recordStageFailure } from "../workers/unifiedEnrichment";
import os from "os";
import { isInternalSecret } from "../utils/internalSecret";
import { reopenable } from "../services/missingFileStages";
import { ASKED_AGAIN_SQL } from "../services/stageReopen";

/**
 * Whether an analyzer is running, from the heartbeat timestamp it writes to
 * Redis every 30 s (the same keys featureDetection reads). Ten missed beats
 * count as offline, since CLAP inference can slow the loop.
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

/** The line under the worker slider, stating whether the change reached an analyzer. */
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

/** Publish a worker-count change and return how many analyzers received it,
 * the only delivery evidence Redis gives. */
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

/**
 * POST /api/analysis/retry-failed
 * Retry failed analysis jobs (admin only)
 */
router.post("/retry-failed", requireAuth, requireAdmin, async (_req, res) => {
    try {
        // Reopen analysis records: retryable failures become due now, and spent ones
        // (retryable = false) reopen with a fresh budget. The first UPDATE must skip
        // spent rows, or the second would never match them.
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage"
                SET status = 'pending', "nextRetryAt" = NULL, retryable = true,
                    "lastErrorCode" = NULL, "lastErrorMessage" = NULL,
                    "failureClass" = NULL, "startedAt" = NULL, "finishedAt" = NULL,
                    evidence = jsonb_build_object('reopenedBy', 'retry-failed')
              WHERE stage = 'analysis' AND status = 'failed' AND retryable = true
                AND ${reopenable('"TrackStage"')}`,
        );
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage"
                SET status = 'pending', failures = 0, "nextRetryAt" = NULL, retryable = true,
                    "lastErrorCode" = NULL, "lastErrorMessage" = NULL,
                    "failureClass" = NULL, "startedAt" = NULL, "finishedAt" = NULL,
                    evidence = jsonb_build_object('reopenedBy', 'retry-failed')
              WHERE stage = 'analysis' AND status = 'failed' AND retryable = false
                AND ${reopenable('"TrackStage"')}`,
        );

        // Mirror the re-ask on the columns the analyzer claims and the UI
        // reads, so record and columns agree while the retry runs.
        const failedTracks = await prisma.track.updateMany({
            where: { analysisStatus: "failed", missingSince: null },
            data: {
                analysisStatus: "pending",
                analysisError: null,
                analysisRetryCount: 0,
                scanStatus: "pending",
            },
        });

        const permFailedTracks = await prisma.track.updateMany({
            where: { analysisStatus: "permanently_failed", missingSince: null },
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

        const totalReset = failedTracks.count + permFailedTracks.count;
        res.json({
            message: `Reset ${totalReset} failed tracks to pending`,
            reset: totalReset,
            failed: failedTracks.count,
            permanentlyFailed: permFailedTracks.count,
        });
    } catch (error: any) {
        logger.error("Retry failed error:", error);
        res.status(500).json({ error: "Failed to retry analysis" });
    }
});



/**
 * GET /api/analysis/workers
 * Get current audio analyzer worker configuration
 */
router.get("/workers", requireAuth, requireAdmin, async (_req, res) => {
    try {
        const settings = await getSystemSettings();
        const cpuCores = os.cpus().length;
        const currentWorkers = settings?.audioAnalyzerWorkers || 2;
        const online = await analyzerIsOnline("audio:worker:heartbeat");

        const recommended = Math.max(2, Math.floor(cpuCores / 2));

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
        const cpuCores = os.cpus().length;
        
        if (typeof workers !== 'number' || workers < 1 || workers > cpuCores) {
            return res.status(400).json({
                error: `Workers must be a number between 1 and ${cpuCores}`
            });
        }
        
        // upsert: SystemSettings has no row on a fresh install.
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

        const recommended = Math.max(2, Math.floor(cpuCores / 2));

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
router.get("/clap-workers", requireAuth, requireAdmin, async (_req, res) => {
    try {
        const settings = await getSystemSettings();
        const cpuCores = os.cpus().length;
        const currentWorkers = settings?.clapWorkers || 2;
        const online = await analyzerIsOnline("clap:worker:heartbeat");

        const recommended = Math.max(1, Math.floor(cpuCores / 2));

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
        const cpuCores = os.cpus().length;

        if (typeof workers !== 'number' || workers < 1 || workers > cpuCores) {
            return res.status(400).json({
                error: `CLAP workers must be a number between 1 and ${cpuCores}`
            });
        }

        // upsert: SystemSettings has no row on a fresh install.
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

        const recommended = Math.max(1, Math.floor(cpuCores / 2));

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
    try {
        // Internal endpoint: only the analyzers know this server's secret.
        if (!(await isInternalSecret(req.headers["x-internal-secret"]))) {
            return res.status(403).json({ error: "Forbidden" });
        }

        const { trackId, trackName, errorMessage, errorCode, jobId } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: "trackId is required" });
        }

        // The stage record is the only record of this failure: the failures API
        // reads TrackStage for track stages, so no EnrichmentFailure row is written.
        // Record the CLAP worker's failure on its retry ladder, so it closes when
        // the ladder runs out.
        await recordStageFailure(
            trackId,
            "embedding",
            "clap",
            new Error(errorMessage || "Vibe embedding generation failed"),
            { reportedCode: errorCode, trackName },
            typeof jobId === "string" ? jobId : undefined,
        );

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
 * @param force - If true, every track's embedding is made again; the old ones stay readable until replaced
 */
router.post("/vibe/start", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { limit = 500, force = false } = req.body;

        if (force) {
            // Force reopens every embedding question without deleting anything: the old
            // embeddings stay readable for the vibe map, and each is overwritten as its
            // new one lands.
            await prisma.$executeRawUnsafe(
                `UPDATE "TrackStage"
                    SET ${ASKED_AGAIN_SQL}, "decidedAt" = NULL, "decidedBy" = NULL
                  WHERE stage = 'embedding'
                    AND ${reopenable('"TrackStage"')}`,
            );
            logger.info(
                "Re-opened every vibe embedding question for re-generation (existing embeddings stay readable until each is overwritten)",
            );
        } else {
            // Reopen embedding questions for analysed tracks with no embedding row, so the
            // stage queue offers them. Gating reads the analysis record, not the column.
            await prisma.$executeRawUnsafe(
                `UPDATE "TrackStage" ts
                    SET ${ASKED_AGAIN_SQL}, "decidedAt" = NULL, "decidedBy" = NULL
                   FROM "TrackStage" a, "Track" t
                  WHERE ts.stage = 'embedding'
                    AND a."trackId" = ts."trackId" AND a.stage = 'analysis' AND a.status = 'done'
                    AND t.id = ts."trackId"
                    AND ts.status <> 'pending'
                    AND ${reopenable("ts")}
                    AND NOT EXISTS (SELECT 1 FROM track_embeddings te WHERE te.track_id = ts."trackId")
                    ${limit ? `AND ts.ctid IN (
                        SELECT ts2.ctid FROM "TrackStage" ts2
                        JOIN "TrackStage" a2 ON a2."trackId" = ts2."trackId" AND a2.stage = 'analysis' AND a2.status = 'done'
                        WHERE ts2.stage = 'embedding'
                          AND ts2.status <> 'pending'
                          AND ${reopenable("ts2")}
                          AND NOT EXISTS (SELECT 1 FROM track_embeddings te2 WHERE te2.track_id = ts2."trackId")
                        LIMIT ${Math.min(Math.max(1, Number(limit) || 500), 10000)})` : ""}`,
            );
        }

        // Owed work: analysed library songs whose embedding question is open (Discover songs are never enriched). After a force,
        // the old rows still exist, so the "row missing" filter does not apply.
        const owedRows = force
            ? await prisma.$queryRaw<Array<{ count: bigint }>>`
                  SELECT count(*) FROM "TrackStage" ts
                  JOIN "TrackStage" a ON a."trackId" = ts."trackId" AND a.stage = 'analysis' AND a.status = 'done'
                  WHERE ts.stage = 'embedding'
                    AND ts.status IN ('pending', 'failed', 'working')
                    AND ts.retryable = true
                    AND EXISTS (SELECT 1 FROM "Track" lt JOIN "Album" la ON la.id = lt."albumId" WHERE lt.id = ts."trackId" AND la.location = 'LIBRARY')
                    AND (ts."nextRetryAt" IS NULL OR ts."nextRetryAt" <= now())
              `
            : await prisma.$queryRaw<Array<{ count: bigint }>>`
                  SELECT count(*) FROM "TrackStage" ts
                  JOIN "TrackStage" a ON a."trackId" = ts."trackId" AND a.stage = 'analysis' AND a.status = 'done'
                  WHERE ts.stage = 'embedding'
                    AND ts.status IN ('pending', 'failed', 'working')
                    AND ts.retryable = true
                    AND EXISTS (SELECT 1 FROM "Track" lt JOIN "Album" la ON la.id = lt."albumId" WHERE lt.id = ts."trackId" AND la.location = 'LIBRARY')
                    AND (ts."nextRetryAt" IS NULL OR ts."nextRetryAt" <= now())
                    AND NOT EXISTS (SELECT 1 FROM track_embeddings te WHERE te.track_id = ts."trackId")
              `;
        const queued = Number(owedRows[0]?.count ?? 0);

        if (queued === 0) {
            return res.json({
                message: "All tracks have vibe embeddings",
                queued: 0,
            });
        }

        // An admin asked for this, so lift any stop and feed the queue now.
        await startEnrichmentNow();

        logger.info(`${queued} tracks owed vibe embedding${force ? " (force reset)" : ""}`);

        res.json({
            message: `Queued ${queued} tracks for vibe embedding`,
            queued,
        });
    } catch (error: any) {
        logger.error("Start vibe embedding error:", error);
        res.status(500).json({ error: "Failed to start vibe embedding" });
    }
});


/**
 * POST /api/analysis/vibe/success
 * Resolve failure records when a vibe embedding succeeds (called by CLAP analyzer)
 */
router.post("/vibe/success", async (req, res) => {
    try {
        // Internal endpoint: only the analyzers know this server's secret.
        if (!(await isInternalSecret(req.headers["x-internal-secret"]))) {
            return res.status(403).json({ error: "Forbidden" });
        }

        const { trackId, jobId } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: "trackId is required" });
        }

        // The embedding stage record is the failure record, so answering it here also
        // clears it from the failures list.
        await recordStageSuccess(
            trackId,
            "embedding",
            "clap",
            { outcome: "embedded" },
            typeof jobId === "string" ? jobId : undefined,
        );

        res.json({ message: "Stale failures resolved" });
        eventBus.emit({ type: "enrichment:progress", userId: "*", payload: { phase: "vibe" } });
    } catch (error: any) {
        logger.error("Resolve vibe failure error:", error);
        res.status(500).json({ error: "Failed to resolve failures" });
    }
});

/**
 * GET /api/analysis/together
 * Whether audio analysis and sound vectors run side by side (true) or one after the other (false, the default).
 */
router.get("/together", requireAuth, requireAdmin, async (_req, res) => {
    try {
        const settings = await getSystemSettings();
        res.json({ together: settings?.analysisAndVectorsTogether === true });
    } catch (error) {
        logger.error("Get analysis-and-vectors setting error:", error);
        res.status(500).json({ error: "Failed to read the setting" });
    }
});

/**
 * PUT /api/analysis/together
 * Body { together: boolean }. New work follows it from the next claim; work already handed out finishes as it is.
 */
router.put("/together", requireAuth, requireAdmin, async (req, res) => {
    const together = req.body?.together;
    if (typeof together !== "boolean") {
        return res.status(400).json({ error: "together (boolean) is required" });
    }
    try {
        // upsert: SystemSettings has no row on a fresh install.
        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: { id: "default", analysisAndVectorsTogether: together },
            update: { analysisAndVectorsTogether: together },
        });
        invalidateSystemSettingsCache();
        logger.info(`Audio analysis and sound vectors now run ${together ? "side by side" : "one after the other"}`);
        res.json({ together });
    } catch (error) {
        logger.error("Set analysis-and-vectors setting error:", error);
        res.status(500).json({ error: "Failed to save the setting" });
    }
});

export default router;
