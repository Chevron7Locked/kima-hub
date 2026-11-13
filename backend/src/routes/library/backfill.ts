import { Router } from "express";
import { logger } from "../../utils/logger";
import {
  isImageBackfillNeeded,
  getImageBackfillProgress,
  backfillAllImages,
} from "../../services/imageBackfill";

const router = Router();

router.get("/image-backfill/status", async (_req, res) => {
  try {
    const [status, progress] = await Promise.all([
      isImageBackfillNeeded(),
      getImageBackfillProgress(),
    ]);

    res.json({
      ...status,
      ...progress,
    });
  } catch (error: any) {
    logger.error("[ImageBackfill] Status check error:", error?.message);
    res.status(500).json({ error: "Failed to check status" });
  }
});

router.post("/image-backfill/start", async (_req, res) => {
  try {
    const progress = getImageBackfillProgress();
    if (progress.inProgress) {
      return res.json({
        message: "Image backfill already in progress",
        status: "processing",
        progress,
      });
    }

    res.json({ message: "Image backfill started", status: "processing" });

    backfillAllImages().catch((error) => {
      logger.error("[ImageBackfill] Backfill failed:", error);
    });
  } catch (error: any) {
    logger.error("[ImageBackfill] Backfill trigger error:", error?.message);
    res.status(500).json({ error: "Failed to start image backfill" });
  }
});

export default router;
