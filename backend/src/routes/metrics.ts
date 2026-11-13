import { Router } from "express";
import { requireAdmin } from "../middleware/auth";
import { getMetrics } from "../utils/metrics";
import { logger } from "../utils/logger";

const router = Router();

// Prometheus metrics: the whole server's activity, so admins only (an admin app key works for scrapers).
router.get("/", requireAdmin, async (_req, res) => {
    try {
        res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        res.send(await getMetrics());
    } catch (error) {
        logger.error("Error generating metrics:", error);
        res.status(500).send("Error generating metrics");
    }
});

export default router;
