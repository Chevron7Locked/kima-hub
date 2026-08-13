import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { createApiKey } from "../services/users/apiKeyStore";

const router = Router();

// All API key routes require authentication (session-based)
router.use(requireAuth);

router.post("/", async (req, res) => {
    try {
        const { deviceName } = req.body;

        if (!deviceName || deviceName.trim().length === 0) {
            return res.status(400).json({ error: "Device name is required" });
        }

        // Use req.user.id (set by requireAuth middleware) - supports both session and JWT auth
        const userId = req.user?.id || req.session?.userId;
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        // The plaintext key is returned once, in the response below, and is
        // never stored -- the row keeps only a SHA-256 digest. createApiKey owns
        // both halves so the hashing cannot be forgotten at a call site.
        const apiKey = await createApiKey(userId, deviceName.trim());

        logger.debug(`API key created for user ${userId}: ${deviceName}`);

        res.status(201).json({
            apiKey: apiKey.key,
            name: apiKey.name,
            createdAt: apiKey.createdAt,
            message:
                "API key created successfully. Save this key - you won't see it again!",
        });
    } catch (error) {
        logger.error("Create API key error:", error);
        res.status(500).json({ error: "Failed to create API key" });
    }
});

router.get("/", async (req, res) => {
    try {
        // Use req.user.id (set by requireAuth middleware) - supports both session and JWT auth
        const userId = req.user?.id || req.session?.userId;
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        const keys = await prisma.apiKey.findMany({
            where: { userId },
            select: {
                id: true,
                name: true,
                lastUsed: true,
                createdAt: true,
                // Don't return the actual key for security!
            },
            orderBy: { createdAt: "desc" },
        });

        res.json({ apiKeys: keys });
    } catch (error) {
        logger.error("List API keys error:", error);
        res.status(500).json({ error: "Failed to list API keys" });
    }
});

router.delete("/:id", async (req, res) => {
    try {
        // Use req.user.id (set by requireAuth middleware) - supports both session and JWT auth
        const userId = req.user?.id || req.session?.userId;
        if (!userId) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        const keyId = req.params.id;

        // Only allow users to delete their own keys
        const deleted = await prisma.apiKey.deleteMany({
            where: {
                id: keyId,
                userId,
            },
        });

        if (deleted.count === 0) {
            return res
                .status(404)
                .json({ error: "API key not found or already deleted" });
        }

        logger.debug(`API key ${keyId} revoked by user ${userId}`);

        res.json({ message: "API key revoked successfully" });
    } catch (error) {
        logger.error("Delete API key error:", error);
        res.status(500).json({ error: "Failed to revoke API key" });
    }
});

export default router;
