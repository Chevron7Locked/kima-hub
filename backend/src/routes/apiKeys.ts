import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import crypto from "crypto";

const router = Router();

// All API key routes require authentication (session-based)
router.use(requireAuth);

/**
 * @openapi
 * /api-keys:
 *   post:
 *     summary: Create a new API key for mobile/external authentication
 *     tags: [API Keys]
 *     security:
 *       - sessionAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - deviceName
 *             properties:
 *               deviceName:
 *                 type: string
 *                 description: Name of the device (e.g., "iPhone 14", "Android Tablet")
 *                 example: "iPhone 14"
 *     responses:
 *       201:
 *         description: API key created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 apiKey:
 *                   type: string
 *                   description: The generated API key (64-character hex string)
 *                   example: "a1b2c3d4e5f6..."
 *                 name:
 *                   type: string
 *                   example: "iPhone 14"
 *                 createdAt:
 *                   type: string
 *                   format: date-time
 *                 message:
 *                   type: string
 *                   example: "API key created successfully. Save this key - you won't see it again!"
 *       400:
 *         description: Invalid request
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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

        // Generate a secure random API key (32 bytes = 64 hex chars)
        const apiKeyValue = crypto.randomBytes(32).toString("hex");

        const apiKey = await prisma.apiKey.create({
            data: {
                userId,
                name: deviceName.trim(),
                key: apiKeyValue,
            },
        });

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

/**
 * @openapi
 * /api-keys:
 *   get:
 *     summary: List all API keys for the current user
 *     tags: [API Keys]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: List of API keys (without the actual key values for security)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 apiKeys:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ApiKey'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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

/**
 * @openapi
 * /api-keys/{id}:
 *   delete:
 *     summary: Revoke an API key
 *     tags: [API Keys]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The API key ID
 *     responses:
 *       200:
 *         description: API key revoked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "API key revoked successfully"
 *       404:
 *         description: API key not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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
