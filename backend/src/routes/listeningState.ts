import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";

const router = Router();

router.use(requireAuth);

const listeningStateSchema = z.object({
    kind: z.enum(["music", "book"]),
    entityId: z.string(),
    trackId: z.string().optional(),
    positionMs: z.number().int().min(0),
});

// POST /listening-state
router.post("/", async (req, res) => {
    try {
        const userId = req.session.userId!;
        const data = listeningStateSchema.parse(req.body);

        const state = await prisma.listeningState.upsert({
            where: {
                userId_kind_entityId: {
                    userId,
                    kind: data.kind,
                    entityId: data.entityId,
                },
            },
            create: {
                userId,
                ...data,
            },
            update: {
                trackId: data.trackId,
                positionMs: data.positionMs,
                updatedAt: new Date(),
            },
        });

        res.json(state);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Update listening state error:", error);
        res.status(500).json({ error: "Failed to update listening state" });
    }
});

// GET /listening-state
router.get("/", async (req, res) => {
    try {
        const userId = req.session.userId!;
        const { kind, entityId } = req.query;

        if (!kind || !entityId) {
            return res
                .status(400)
                .json({ error: "kind and entityId required" });
        }

        const state = await prisma.listeningState.findUnique({
            where: {
                userId_kind_entityId: {
                    userId,
                    kind: kind as string,
                    entityId: entityId as string,
                },
            },
        });

        if (!state) {
            return res.status(404).json({ error: "No listening state found" });
        }

        res.json(state);
    } catch (error) {
        logger.error("Get listening state error:", error);
        res.status(500).json({ error: "Failed to get listening state" });
    }
});

// GET /listening-state/recent (for "Continue Listening")
router.get("/recent", async (req, res) => {
    try {
        const userId = req.session.userId!;
        const { limit = "10" } = req.query;

        const states = await prisma.listeningState.findMany({
            where: { userId },
            orderBy: { updatedAt: "desc" },
            take: parseInt(limit as string, 10),
        });

        res.json(states);
    } catch (error) {
        logger.error("Get recent listening states error:", error);
        res.status(500).json({
            error: "Failed to get recent listening states",
        });
    }
});

export default router;
