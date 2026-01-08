import express from "express";
import { logger } from "../utils/logger";
import { prisma, Prisma } from "../utils/db";
import { requireAuth } from "../middleware/auth";

const router = express.Router();

// Get current playback state for the authenticated user
router.get("/", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;

        const playbackState = await prisma.playbackState.findUnique({
            where: { userId },
        });

        if (!playbackState) {
            return res.json(null);
        }

        res.json(playbackState);
    } catch (error) {
        logger.error("Get playback state error:", error);
        res.status(500).json({ error: "Failed to get playback state" });
    }
});

// Update current playback state for the authenticated user
router.post("/", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;
        const {
            playbackType,
            trackId,
            audiobookId,
            podcastId,
            queue,
            currentIndex,
            isShuffle,
        } = req.body;

        // Validate required field
        if (!playbackType) {
            return res.status(400).json({ error: "playbackType is required" });
        }

        // Validate playback type
        const validPlaybackTypes = ["track", "audiobook", "podcast"];
        if (!validPlaybackTypes.includes(playbackType)) {
            logger.warn(`[PlaybackState] Invalid playbackType: ${playbackType}`);
            return res.status(400).json({ error: "Invalid playbackType" });
        }

        // Limit queue size and sanitize queue items to prevent database issues
        let safeQueue: any[] | null = null;
        if (Array.isArray(queue) && queue.length > 0) {
            // Only keep essential fields from each queue item to reduce JSON size
            // Filter out any invalid items first
            try {
                safeQueue = queue
                    .slice(0, 100)
                    .filter((item: any) => item && item.id) // Must have at least an ID
                    .map((item: any) => ({
                        id: String(item.id || ""),
                        title: String(item.title || "Unknown").substring(0, 500), // Limit title length
                        duration: Number(item.duration) || 0,
                        artist: item.artist ? {
                            id: String(item.artist.id || ""),
                            name: String(item.artist.name || "Unknown").substring(0, 200),
                        } : null,
                        album: item.album ? {
                            id: String(item.album.id || ""),
                            title: String(item.album.title || "Unknown").substring(0, 500),
                            coverArt: item.album.coverArt ? String(item.album.coverArt).substring(0, 1000) : null,
                        } : null,
                    }));
                
                // If sanitization removed all items, set to null
                if (safeQueue.length === 0) {
                    safeQueue = null;
                }
            } catch (sanitizeError: any) {
                logger.error("[PlaybackState] Queue sanitization failed:", sanitizeError?.message);
                safeQueue = null; // Fall back to null queue
            }
        }
        
        const safeCurrentIndex = Math.min(
            Math.max(0, currentIndex || 0),
            safeQueue?.length ? safeQueue.length - 1 : 0
        );

        const playbackState = await prisma.playbackState.upsert({
            where: { userId },
            update: {
                playbackType,
                trackId: trackId || null,
                audiobookId: audiobookId || null,
                podcastId: podcastId || null,
                queue: safeQueue === null ? Prisma.DbNull : safeQueue,
                currentIndex: safeCurrentIndex,
                isShuffle: isShuffle || false,
            },
            create: {
                userId,
                playbackType,
                trackId: trackId || null,
                audiobookId: audiobookId || null,
                podcastId: podcastId || null,
                queue: safeQueue === null ? Prisma.DbNull : safeQueue,
                currentIndex: safeCurrentIndex,
                isShuffle: isShuffle || false,
            },
        });

        res.json(playbackState);
    } catch (error: any) {
        logger.error("[PlaybackState] Error saving state:", error?.message || error);
        logger.error("[PlaybackState] Full error:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
        if (error?.code) {
            logger.error("[PlaybackState] Error code:", error.code);
        }
        if (error?.meta) {
            logger.error("[PlaybackState] Prisma meta:", error.meta);
        }
        // Return more specific error for debugging
        res.status(500).json({ 
            error: "Internal server error",
            details: error?.message || "Unknown error"
        });
    }
});

// Clear playback state (when user stops playback completely)
router.delete("/", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;

        await prisma.playbackState.delete({
            where: { userId },
        });

        res.json({ success: true });
    } catch (error) {
        logger.error("Delete playback state error:", error);
        res.status(500).json({ error: "Failed to delete playback state" });
    }
});

export default router;
