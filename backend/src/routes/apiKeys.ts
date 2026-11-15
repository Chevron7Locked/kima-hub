import { Router } from "express";
import { logger } from "../utils/logger";
import { refuseRequest } from "../utils/errors";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/users/apiKeyStore";

const router = Router();

router.post("/", async (req, res) => {
    try {
        const { deviceName } = req.body;

        if (typeof deviceName !== "string" || deviceName.trim().length === 0) {
            return refuseRequest(req, res, "deviceName: a non-empty string required");
        }

        const userId = req.user!.id;

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
        const userId = req.user!.id;

        res.json({ apiKeys: await listApiKeys(userId) });
    } catch (error) {
        logger.error("List API keys error:", error);
        res.status(500).json({ error: "Failed to list API keys" });
    }
});

router.delete("/:id", async (req, res) => {
    try {
        const userId = req.user!.id;
        const keyId = req.params.id;

        if (!(await revokeApiKey(userId, keyId))) {
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
