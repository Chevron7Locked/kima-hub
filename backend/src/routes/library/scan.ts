import { Router } from "express";
import { requireAdmin } from "../../middleware/auth";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { config } from "../../config";
import { scanQueue } from "../../workers/queues";
import { organizeSingles } from "../../workers/organizeSingles";

const router = Router();

router.post("/scan", requireAdmin, async (req, res) => {
  try {
    if (!config.music.musicPath) {
      return res.status(500).json({
        error:
          "Music path not configured. Please set MUSIC_PATH environment variable.",
      });
    }

    try {
      logger.info("[Scan] Organizing Soulseek downloads before scan...");
      await organizeSingles();
      logger.info("[Scan] Soulseek organization complete");
    } catch (err: any) {
      logger.info("[Scan] Soulseek organization skipped:", err.message);
    }

    const userId = req.user?.id || "system";

    const job = await scanQueue.add("scan", {
      userId,
      musicPath: config.music.musicPath,
    });

    res.json({
      message: "Library scan started",
      jobId: job.id,
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

router.post("/organize", requireAdmin, async (_req, res) => {
  try {
    organizeSingles().catch((err) => {
      logger.error("Manual organization failed:", err);
    });

    res.json({ message: "Organization started in background" });
  } catch (error) {
    logger.error("Organization trigger error:", error);
    res.status(500).json({ error: "Failed to start organization" });
  }
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
      })),
    });
  } catch (error) {
    logger.error("Get corrupt tracks error:", error);
    res.status(500).json({ error: "Failed to get corrupt tracks" });
  }
});

router.delete("/corrupt-tracks", requireAdmin, async (_req, res) => {
  try {
    const result = await prisma.track.deleteMany({ where: { corrupt: true } });
    res.json({ deleted: result.count, message: `Removed ${result.count} corrupt tracks` });
  } catch (error) {
    logger.error("Delete corrupt tracks error:", error);
    res.status(500).json({ error: "Failed to delete corrupt tracks" });
  }
});

export default router;
