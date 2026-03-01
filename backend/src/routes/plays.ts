import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";

const router = Router();

router.use(requireAuth);

const playSchema = z.object({
    trackId: z.string(),
});

// POST /plays
router.post("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { trackId } = playSchema.parse(req.body);

        // Verify track exists
        const track = await prisma.track.findUnique({
            where: { id: trackId },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        const play = await prisma.play.create({
            data: {
                userId,
                trackId,
            },
        });

        res.json(play);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Create play error:", error);
        res.status(500).json({ error: "Failed to log play" });
    }
});

// GET /plays (recent plays for user)
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { limit = "50" } = req.query;

        const plays = await prisma.play.findMany({
            where: { userId },
            orderBy: { playedAt: "desc" },
            take: Math.min(Math.max(parseInt(limit as string, 10) || 50, 1), 200),
            include: {
                track: {
                    include: {
                        album: {
                            include: {
                                artist: {
                                    select: {
                                        id: true,
                                        name: true,
                                        mbid: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        res.json(plays);
    } catch (error) {
        logger.error("Get plays error:", error);
        res.status(500).json({ error: "Failed to get plays" });
    }
});

export default router;
