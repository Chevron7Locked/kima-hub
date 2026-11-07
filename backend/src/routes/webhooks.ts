/**
 * Lidarr webhooks: each event is stored (deduplicated), answered 200 at once
 * and processed asynchronously, so events survive restarts and can be replayed.
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import { processStoredEvent } from "../services/webhookHandlers";
import { WEBHOOK_SECRET_HEADER } from "../services/lidarrWebhookSetup";
import { lidarrWebhookSecretHeld } from "../services/lidarrWebhookSecret";
import { webhookLimiter } from "../middleware/rateLimiter";
import { getSystemSettings } from "../utils/systemSettings";
import { isLidarrConfigured } from "../services/lidarrClient";
import { logger } from "../utils/logger";
import { APP_VERSION } from "../config";
import crypto from "crypto";
import { webhookEventStore } from "../services/webhookEventStore";

const router = Router();
let webhookSecretWarned = false;

/** Marks requests that carry the configured secret; the limiter lets those through. */
async function checkWebhookSecret(req: Request, res: Response, next: NextFunction) {
    res.locals.webhookVerified = false;
    try {
        const secret = (await getSystemSettings())?.lidarrWebhookSecret;
        const provided = req.get(WEBHOOK_SECRET_HEADER);
        if (secret && provided) {
            const a = Buffer.from(provided);
            const b = Buffer.from(secret);
            res.locals.webhookVerified = a.length === b.length && crypto.timingSafeEqual(a, b);
        }
    } catch (error: any) {
        logger.error("[WEBHOOK] Could not read the webhook secret:", error.message);
    }
    next();
}

router.use(checkWebhookSecret, webhookLimiter);

router.get("/lidarr/verify", (_req, res) => {
    logger.debug("[WEBHOOK] Verification request received");
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "kima",
        version: APP_VERSION,
    });
});

router.post("/lidarr", async (req, res) => {
    try {
        const settings = await getSystemSettings();
        if (!isLidarrConfigured(settings)) {
            logger.debug("[WEBHOOK] Lidarr webhook received but Lidarr is disabled. Ignoring.");
            return res.status(202).json({
                success: true,
                ignored: true,
                reason: "lidarr-disabled",
            });
        }

        // An unreadable secret is still a stored one: nothing can match it until Kima replaces it.
        if (lidarrWebhookSecretHeld(settings)) {
            if (!res.locals.webhookVerified) {
                logger.debug("[WEBHOOK] Lidarr webhook received with invalid or missing secret");
                return res.status(401).json({
                    error: "Unauthorized - Invalid webhook secret",
                });
            }
        } else if (!webhookSecretWarned) {
            logger.warn(
                "[WEBHOOK] Lidarr webhooks are accepted without a secret and rate-limited. Saving the Lidarr settings gives Lidarr one."
            );
            webhookSecretWarned = true;
        }

        const eventType = req.body.eventType;
        logger.debug(`[WEBHOOK] Lidarr event: ${eventType}`);

        const { event, created } = await webhookEventStore.storeEvent("lidarr", eventType, req.body);
        res.json({ success: true, eventId: event.id });

        if (created) {
            void processStoredEvent(event.id, eventType, req.body);
        }
    } catch (error: any) {
        logger.error("Webhook error:", error.message);
        res.status(500).json({ error: "Webhook processing failed" });
    }
});

export default router;
