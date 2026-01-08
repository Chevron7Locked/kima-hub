import { logger } from "../utils/logger";

/**
 * Soulseek routes - Direct connection via slsk-client
 * Simplified API for status and manual search/download
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { soulseekService } from "../services/soulseek";
import { getSystemSettings } from "../utils/systemSettings";

const router = Router();

// Middleware to check if Soulseek credentials are configured
async function requireSoulseekConfigured(req: any, res: any, next: any) {
    try {
        const available = await soulseekService.isAvailable();

        if (!available) {
            return res.status(403).json({
                error: "Soulseek credentials not configured. Add username/password in System Settings.",
            });
        }

        next();
    } catch (error) {
        logger.error("Error checking Soulseek settings:", error);
        res.status(500).json({ error: "Failed to check settings" });
    }
}

/**
 * GET /soulseek/status
 * Check connection status
 */
router.get("/status", requireAuth, async (req, res) => {
    try {
        const available = await soulseekService.isAvailable();

        if (!available) {
            return res.json({
                enabled: false,
                connected: false,
                message: "Soulseek credentials not configured",
            });
        }

        const status = await soulseekService.getStatus();

        res.json({
            enabled: true,
            connected: status.connected,
            username: status.username,
        });
    } catch (error: any) {
        logger.error("Soulseek status error:", error.message);
        res.status(500).json({
            error: "Failed to get Soulseek status",
            details: error.message,
        });
    }
});

/**
 * POST /soulseek/connect
 * Manually trigger connection to Soulseek network
 */
router.post("/connect", requireAuth, requireSoulseekConfigured, async (req, res) => {
    try {
        await soulseekService.connect();

        res.json({
            success: true,
            message: "Connected to Soulseek network",
        });
    } catch (error: any) {
        logger.error("Soulseek connect error:", error.message);
        res.status(500).json({
            error: "Failed to connect to Soulseek",
            details: error.message,
        });
    }
});

/**
 * POST /soulseek/search
 * Search for a track
 */
router.post("/search", requireAuth, requireSoulseekConfigured, async (req, res) => {
    try {
        const { artist, title } = req.body;

        if (!artist || !title) {
            return res.status(400).json({
                error: "Artist and title are required",
            });
        }

        logger.debug(`[Soulseek] Searching: "${artist} - ${title}"`);

        const result = await soulseekService.searchTrack(artist, title);

        if (result.found && result.bestMatch) {
            res.json({
                found: true,
                match: {
                    user: result.bestMatch.username,
                    filename: result.bestMatch.filename,
                    size: result.bestMatch.size,
                    quality: result.bestMatch.quality,
                    score: result.bestMatch.score,
                },
            });
        } else {
            res.json({
                found: false,
                message: "No suitable matches found",
            });
        }
    } catch (error: any) {
        logger.error("Soulseek search error:", error.message);
        res.status(500).json({
            error: "Search failed",
            details: error.message,
        });
    }
});

/**
 * POST /soulseek/download
 * Download a track directly
 */
router.post("/download", requireAuth, requireSoulseekConfigured, async (req, res) => {
    try {
        const { artist, title, album } = req.body;

        if (!artist || !title) {
            return res.status(400).json({
                error: "Artist and title are required",
            });
        }

        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath;

        if (!musicPath) {
            return res.status(400).json({
                error: "Music path not configured",
            });
        }

        logger.debug(`[Soulseek] Downloading: "${artist} - ${title}"`);

        const result = await soulseekService.searchAndDownload(
            artist,
            title,
            album || "Unknown Album",
            musicPath
        );

        if (result.success) {
            res.json({
                success: true,
                filePath: result.filePath,
            });
        } else {
            res.status(404).json({
                success: false,
                error: result.error || "Download failed",
            });
        }
    } catch (error: any) {
        logger.error("Soulseek download error:", error.message);
        res.status(500).json({
            error: "Download failed",
            details: error.message,
        });
    }
});

/**
 * POST /soulseek/disconnect
 * Disconnect from Soulseek network
 */
router.post("/disconnect", requireAuth, async (req, res) => {
    try {
        soulseekService.disconnect();
        res.json({ success: true, message: "Disconnected" });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
