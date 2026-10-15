import { Router } from "express";
import { featureDetection } from "../services/featureDetection";
import { isPublicListener } from "../services/liveListening";
import { requireAuth } from "../middleware/auth";
import { logger } from "../utils/logger";

const router = Router();

/**
 * GET /api/system/features
 * Which analyzer features are available, and whether this user's player reports what it plays
 * for the public live feed: only on an instance with the public vibe switched on, and only for
 * its public user. Everywhere else the player sends nothing.
 */
router.get("/features", requireAuth, async (req, res) => {
    try {
        const features = await featureDetection.getFeatures();
        // A failed lookup means no reporting; it never costs the player its other features.
        const liveReporting = await isPublicListener(req.user!.id).catch((error) => {
            logger.warn("[PUBLIC-VIBE] could not tell whether this user's listening is public:", (error as Error).message);
            return false;
        });
        res.json({ ...features, liveReporting });
    } catch (error: any) {
        logger.error("Feature detection error:", error);
        res.status(500).json({ error: "Failed to detect features" });
    }
});

export default router;
