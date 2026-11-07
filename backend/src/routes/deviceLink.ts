import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import crypto from "crypto";
import { createApiKey, listApiKeys, revokeApiKey } from "../services/users/apiKeyStore";
import { approve, deny, waitForAnswer, waitingDevice } from "../services/users/deviceLinkApproval";

const router = Router();

const MAX_DEVICE_NAME = 100;

/** The device name comes from whoever sent the request, and the code's owner reads it on the link page. */
function cleanDeviceName(raw: unknown): string {
    return typeof raw === "string" && raw ? raw.slice(0, MAX_DEVICE_NAME) : "Mobile Device";
}

// Generate a random 6-character alphanumeric code
function generateLinkCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Exclude similar looking chars
    let code = "";
    for (let i = 0; i < 6; i++) {
        code += chars[crypto.randomInt(chars.length)];
    }
    return code;
}

router.post("/generate", requireAuthOrToken, async (req, res) => {
    try {
        const userId = req.user!.id;

        // Delete any existing unused codes for this user
        await prisma.deviceLinkCode.deleteMany({
            where: {
                userId,
                usedAt: null,
            },
        });

        // Generate a unique code
        let code: string;
        let attempts = 0;
        do {
            code = generateLinkCode();
            attempts++;
            if (attempts > 10) {
                return res.status(500).json({ error: "Failed to generate unique code" });
            }
        } while (
            await prisma.deviceLinkCode.findUnique({
                where: { code },
            })
        );

        // Create the code with 5-minute expiry
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
        const linkCode = await prisma.deviceLinkCode.create({
            data: {
                code,
                userId,
                expiresAt,
            },
        });

        res.json({
            code: linkCode.code,
            expiresAt: linkCode.expiresAt,
            expiresIn: 300, // 5 minutes in seconds
        });
    } catch (error) {
        logger.error("Generate device link code error:", error);
        res.status(500).json({ error: "Failed to generate device link code" });
    }
});

// POST /device-link/verify - Verify a code and get API key (no auth required)
router.post("/verify", async (req, res) => {
    try {
        const { code } = req.body;
        const deviceName = cleanDeviceName(req.body.deviceName);

        if (!code || typeof code !== "string") {
            return res.status(400).json({ error: "Code is required" });
        }

        // Find the code
        const linkCode = await prisma.deviceLinkCode.findUnique({
            where: { code: code.toUpperCase() },
            include: { user: true },
        });

        if (!linkCode) {
            return res.status(404).json({ error: "Invalid code" });
        }

        if (linkCode.usedAt) {
            return res.status(400).json({ error: "Code already used" });
        }

        if (new Date() > linkCode.expiresAt) {
            return res.status(400).json({ error: "Code expired" });
        }

        const appLeft = new AbortController();
        res.on("close", () => {
            if (!res.writableFinished) appLeft.abort();
        });
        const outcome = await waitForAnswer(linkCode.id, deviceName, appLeft.signal);
        if (outcome === "gone" || appLeft.signal.aborted) return;
        if (outcome === "already-waiting") {
            return res.status(409).json({ error: "A device is already waiting on this code" });
        }
        if (outcome === "no-answer") {
            return res.status(408).json({ error: "Nobody approved the link in time, try again" });
        }
        if (outcome === "denied") {
            return res.status(403).json({ error: "The owner of this code denied the link" });
        }

        // Claim the code atomically so two concurrent /verify requests cannot both
        // mint a key. Codes are single-use: consumed even if minting then fails.
        const claimed = await prisma.deviceLinkCode.updateMany({
            where: { id: linkCode.id, usedAt: null, expiresAt: { gt: new Date(Date.now()) } },
            data: {
                usedAt: new Date(),
                deviceName,
            },
        });
        if (claimed.count !== 1) {
            // The owner may have approved after the code ran out while the request waited.
            const error = Date.now() >= linkCode.expiresAt.getTime() ? "Code expired" : "Code already used";
            return res.status(400).json({ error });
        }

        // Generate an API key for this device. The plaintext value goes back to
        // the device in the response below and is never stored -- the row keeps
        // only a SHA-256 digest.
        const createdApiKey = await createApiKey(linkCode.userId, deviceName);
        const apiKey = createdApiKey.key;

        await prisma.deviceLinkCode.update({
            where: { id: linkCode.id },
            data: { apiKeyId: createdApiKey.id },
        });

        res.json({
            success: true,
            apiKey,
            userId: linkCode.userId,
            username: linkCode.user.username,
        });
    } catch (error) {
        logger.error("Verify device link code error:", error);
        res.status(500).json({ error: "Failed to verify device link code" });
    }
});

// POST /device-link/approve/:code - The code's owner lets the waiting device link (requires auth)
router.post("/approve/:code", requireAuthOrToken, async (req, res) => {
    try {
        const linkCode = await prisma.deviceLinkCode.findFirst({
            where: { code: req.params.code.toUpperCase(), userId: req.user!.id },
        });
        if (!linkCode || !approve(linkCode.id)) {
            return res.status(404).json({ error: "No device is waiting" });
        }
        res.json({ success: true });
    } catch (error) {
        logger.error("Approve device link error:", error);
        res.status(500).json({ error: "Failed to approve device" });
    }
});

// POST /device-link/deny/:code - The code's owner refuses the waiting device; the code is gone (requires auth)
router.post("/deny/:code", requireAuthOrToken, async (req, res) => {
    try {
        const linkCode = await prisma.deviceLinkCode.findFirst({
            where: { code: req.params.code.toUpperCase(), userId: req.user!.id },
        });
        if (!linkCode || !deny(linkCode.id)) {
            return res.status(404).json({ error: "No device is waiting" });
        }
        await prisma.deviceLinkCode.deleteMany({ where: { id: linkCode.id } });
        res.json({ success: true });
    } catch (error) {
        logger.error("Deny device link error:", error);
        res.status(500).json({ error: "Failed to deny device" });
    }
});

// GET /device-link/status/:code - Poll for code usage status (requires auth; only the code's owner)
router.get("/status/:code", requireAuthOrToken, async (req, res) => {
    try {
        const { code } = req.params;

        const linkCode = await prisma.deviceLinkCode.findFirst({
            where: { code: code.toUpperCase(), userId: req.user!.id },
        });

        if (!linkCode) {
            return res.status(404).json({ error: "Invalid code" });
        }

        if (new Date() > linkCode.expiresAt && !linkCode.usedAt) {
            return res.json({
                status: "expired",
                expiresAt: linkCode.expiresAt,
            });
        }

        if (linkCode.usedAt) {
            return res.json({
                status: "used",
                usedAt: linkCode.usedAt,
                deviceName: linkCode.deviceName,
            });
        }

        const deviceName = waitingDevice(linkCode.id);
        if (deviceName) {
            return res.json({ status: "waiting", expiresAt: linkCode.expiresAt, deviceName });
        }

        res.json({
            status: "pending",
            expiresAt: linkCode.expiresAt,
        });
    } catch (error) {
        logger.error("Check device link status error:", error);
        res.status(500).json({ error: "Failed to check status" });
    }
});

// GET /device-link/devices - List linked devices (requires auth)
router.get("/devices", requireAuthOrToken, async (req, res) => {
    try {
        const userId = req.user!.id;

        res.json(await listApiKeys(userId, "lastUsed"));
    } catch (error) {
        logger.error("Get devices error:", error);
        res.status(500).json({ error: "Failed to get devices" });
    }
});

// DELETE /device-link/devices/:id - Revoke a device (requires auth)
router.delete("/devices/:id", requireAuthOrToken, async (req, res) => {
    try {
        const userId = req.user!.id;
        const { id } = req.params;

        if (!(await revokeApiKey(userId, id))) {
            return res.status(404).json({ error: "Device not found" });
        }

        res.json({ success: true });
    } catch (error) {
        logger.error("Revoke device error:", error);
        res.status(500).json({ error: "Failed to revoke device" });
    }
});

export default router;
