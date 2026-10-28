import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import { recordPlay } from "../services/playRecording";

const router = Router();

router.use(requireAuth);

const playSchema = z.object({
    trackId: z.string(),
    // Seconds actually heard. Clients that do not send it record no play, since
    // they cannot know whether it counts.
    secondsListened: z.number().min(0).max(24 * 60 * 60).default(0),
});

// POST /plays
router.post("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { trackId, secondsListened } = playSchema.parse(req.body);

        const outcome = await recordPlay({ userId, trackId, secondsListened });

        if (!outcome.recorded && outcome.reason === "unknown-track") {
            return res.status(404).json({ error: "Track not found" });
        }

        // Not qualifying is a normal outcome, not a failure: the client reports
        // progress and the server decides. Say which way it went so a client can
        // stop asking.
        res.json(outcome);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.issues });
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
