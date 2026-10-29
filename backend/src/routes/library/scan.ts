import { Router } from "express";
import { requireAdmin } from "../../middleware/auth";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { config } from "../../config";
import { scanQueue } from "../../workers/queues";
import { requestScan } from "../../workers/scanRequest";
import { organizeSingles } from "../../workers/organizeSingles";
import { parseLimit, parseOffset } from "./paging";

const router = Router();

router.post("/scan", requireAdmin, async (req, res) => {
  try {
    // Soulseek downloads are filed first; a failure there does not stop the scan.
    try {
      await organizeSingles();
    } catch (err: any) {
      logger.warn(`[Scan] Filing Soulseek downloads failed, scanning anyway: ${err.message}`);
    }

    const userId = req.user?.id || "system";

    const result = await requestScan({ userId, source: "manual-scan" });

    res.json({
      message: result.queued
        ? "Library scan started"
        : `Library scan already queued or running (${result.reason})`,
      jobId: result.jobId,
      musicPath: config.music.musicPath,
    });
  } catch (error) {
    logger.error("Scan trigger error:", error);
    res.status(500).json({ error: "Failed to start scan" });
  }
});

router.get("/scan/status/:jobId", async (req, res) => {
  try {
    const job = await scanQueue.getJob(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    const state = await job.getState();
    const progress = job.progress;
    const result = job.returnvalue;

    res.json({
      status: state,
      progress,
      result,
    });
  } catch (error) {
    logger.error("Get scan status error:", error);
    res.status(500).json({ error: "Failed to get job status" });
  }
});

router.post("/organize", requireAdmin, (_req, res) => {
  organizeSingles().catch((err) => {
    logger.error("Manual organization failed:", err);
  });
  res.json({ message: "Organization started in background" });
});

router.get("/corrupt-tracks", requireAdmin, async (_req, res) => {
  try {
    const tracks = await prisma.track.findMany({
      where: { corrupt: true },
      include: { album: { include: { artist: { select: { name: true } } } } },
      orderBy: { title: "asc" },
    });

    res.json({
      count: tracks.length,
      tracks: tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.album.artist.name,
        album: t.album.title,
        filePath: t.filePath,
      })),
    });
  } catch (error) {
    logger.error("Get corrupt tracks error:", error);
    res.status(500).json({ error: "Failed to get corrupt tracks" });
  }
});

router.get("/missing-tracks", requireAdmin, async (_req, res) => {
  try {
    // Tracks whose file is gone, and since when. The scan flags them rather than
    // deleting them and clears the flag when the file returns, so there is no
    // manual clear.
    const tracks = await prisma.track.findMany({
      where: { missingSince: { not: null } },
      include: { album: { include: { artist: { select: { name: true } } } } },
      orderBy: { missingSince: "asc" },
    });

    res.json({
      count: tracks.length,
      tracks: tracks.map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.album.artist.name,
        album: t.album.title,
        missingSince: t.missingSince,
      })),
    });
  } catch (error) {
    logger.error("Get missing tracks error:", error);
    res.status(500).json({ error: "Failed to get missing tracks" });
  }
});

router.get("/removals", requireAdmin, async (req, res) => {
  try {
    // What the reconcile sweep retired, newest first. Rows outlive the tracks they
    // describe; this is the memory of the library that left.
    const limit = parseLimit(req.query.limit, 100);
    const offset = parseOffset(req.query.offset);
    const [count, removals] = await Promise.all([
      prisma.removalLog.count(),
      prisma.removalLog.findMany({ orderBy: { removedAt: "desc" }, skip: offset, take: limit }),
    ]);
    res.json({
      count,
      removals: removals.map((r) => ({
        id: r.id,
        filePath: r.filePath,
        title: r.title,
        artistName: r.artistName,
        albumTitle: r.albumTitle,
        reason: r.reason,
        artifacts: r.artifacts,
        removedAt: r.removedAt,
      })),
    });
  } catch (error) {
    logger.error("Get removals error:", error);
    res.status(500).json({ error: "Failed to get removals" });
  }
});

router.delete("/corrupt-tracks", requireAdmin, async (_req, res) => {
  try {
    // Clear the corrupt flag only, keeping the track and its stage records; the
    // next scan re-checks the file.
    const result = await prisma.track.updateMany({
      where: { corrupt: true },
      data: { corrupt: false },
    });
    res.json({
      cleared: result.count,
      message: `Cleared the corrupt flag on ${result.count} tracks (rows kept)`,
    });
  } catch (error) {
    logger.error("Clear corrupt tracks error:", error);
    res.status(500).json({ error: "Failed to clear corrupt tracks" });
  }
});

export default router;
