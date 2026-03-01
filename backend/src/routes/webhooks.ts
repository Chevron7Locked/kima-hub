/**
 * Lidarr Webhook Handler (Event Sourcing)
 *
 * Handles Lidarr webhooks using event sourcing pattern:
 * 1. Store webhook event in database (with deduplication)
 * 2. Respond immediately with 200 OK
 * 3. Process event asynchronously
 *
 * This ensures:
 * - No webhook events are lost
 * - Can replay missed events
 * - Survives server restarts
 */

import { Router } from "express";
import { scanQueue } from "../workers/queues";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { queueCleaner } from "../jobs/queueCleaner";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import crypto from "crypto";
import { webhookEventStore } from "../services/webhookEventStore";
import { webhookEventsTotal, webhookProcessingDuration } from "../utils/metrics";

const router = Router();

// GET /webhooks/lidarr/verify - Webhook verification endpoint
router.get("/lidarr/verify", (req, res) => {
    logger.debug("[WEBHOOK] Verification request received");
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        service: "kima",
        version: process.env.npm_package_version || "unknown",
    });
});

// POST /webhooks/lidarr - Handle Lidarr webhooks
router.post("/lidarr", async (req, res) => {
    try {
        // Check if Lidarr is enabled before processing any webhooks
        const settings = await getSystemSettings();
        if (
            !settings?.lidarrEnabled ||
            !settings?.lidarrUrl ||
            !settings?.lidarrApiKey
        ) {
            logger.debug(
                `[WEBHOOK] Lidarr webhook received but Lidarr is disabled. Ignoring.`
            );
            return res.status(202).json({
                success: true,
                ignored: true,
                reason: "lidarr-disabled",
            });
        }

        // Verify webhook secret if configured
        if (!settings.lidarrWebhookSecret) {
            logger.warn(
                "[WEBHOOK] No webhook secret configured. Set lidarrWebhookSecret in settings for security."
            );
        }

        if (settings.lidarrWebhookSecret) {
            const providedSecret = req.headers["x-webhook-secret"] as string;

            if (
                !providedSecret ||
                providedSecret.length !== settings.lidarrWebhookSecret.length ||
                !crypto.timingSafeEqual(
                    Buffer.from(providedSecret),
                    Buffer.from(settings.lidarrWebhookSecret)
                )
            ) {
                logger.debug(
                    `[WEBHOOK] Lidarr webhook received with invalid or missing secret`
                );
                return res.status(401).json({
                    error: "Unauthorized - Invalid webhook secret",
                });
            }
        }

        const eventType = req.body.eventType;
        logger.debug(`[WEBHOOK] Lidarr event: ${eventType}`);

        // Log payload in debug mode only
        if (process.env.DEBUG_WEBHOOKS === "true") {
            logger.debug(`   Payload:`, JSON.stringify(req.body, null, 2));
        }

        // STEP 1: Store webhook event immediately (with deduplication)
        const storedEvent = await webhookEventStore.storeEvent(
            "lidarr",
            eventType,
            req.body
        );

        // STEP 2: Respond immediately (don't wait for processing)
        res.json({ success: true, eventId: storedEvent.id });

        // STEP 3: Process event asynchronously
        processWebhookEvent(storedEvent.id, eventType, req.body).catch((error) => {
            logger.error(`[WEBHOOK] Failed to process event ${storedEvent.id}:`, error.message);
        });
    } catch (error: any) {
        logger.error("Webhook error:", error.message);
        res.status(500).json({ error: "Webhook processing failed" });
    }
});

/**
 * Process webhook event asynchronously
 */
async function processWebhookEvent(
    eventId: string,
    eventType: string,
    payload: any
): Promise<void> {
    const startTime = Date.now();
    let status = 'success';

    try {
        let correlationId: string | undefined;

        switch (eventType) {
            case "Grab":
                correlationId = await handleGrab(payload);
                break;

            case "Download":
            case "AlbumDownload":
            case "TrackRetag":
            case "Rename":
                correlationId = await handleDownload(payload);
                break;

            case "ImportFailure":
            case "DownloadFailed":
            case "DownloadFailure":
                correlationId = await handleImportFailure(payload);
                break;

            case "Health":
            case "HealthIssue":
            case "HealthRestored":
            case "Test":
                break;

            default:
                logger.debug(`   Unhandled event: ${eventType}`);
        }

        await webhookEventStore.markProcessed(eventId, correlationId);
    } catch (error: any) {
        status = 'failed';
        logger.error(`[WEBHOOK] Event processing failed:`, error.message);
        await webhookEventStore.markFailed(eventId, error.message);
    } finally {
        const duration = (Date.now() - startTime) / 1000;
        webhookEventsTotal.inc({ event_type: eventType, status });
        webhookProcessingDuration.observe({ event_type: eventType }, duration);
    }
}

/**
 * Handle Grab event (download started by Lidarr)
 * Returns correlation ID (download job ID) if matched
 */
async function handleGrab(payload: any): Promise<string | undefined> {
    const downloadId = payload.downloadId;
    const albumMbid =
        payload.albums?.[0]?.foreignAlbumId || payload.albums?.[0]?.mbId;
    const albumTitle = payload.albums?.[0]?.title;
    const artistName = payload.artist?.name;
    const lidarrAlbumId = payload.albums?.[0]?.id;

    logger.debug(`   Album: ${artistName} - ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   MBID: ${albumMbid}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return undefined;
    }

    const result = await simpleDownloadManager.onDownloadGrabbed(
        downloadId,
        albumMbid || "",
        albumTitle || "",
        artistName || "",
        lidarrAlbumId || 0
    );

    if (result.matched) {
        queueCleaner.start();
        return result.jobId;
    }

    return undefined;
}

/**
 * Handle Download event (download complete + imported)
 * Returns correlation ID (download job ID) if matched
 */
async function handleDownload(payload: any): Promise<string | undefined> {
    const downloadId = payload.downloadId;
    const albumTitle = payload.album?.title || payload.albums?.[0]?.title;
    const artistName = payload.artist?.name;
    const albumMbid =
        payload.album?.foreignAlbumId || payload.albums?.[0]?.foreignAlbumId;
    const lidarrAlbumId = payload.album?.id || payload.albums?.[0]?.id;

    logger.debug(`   Album: ${artistName} - ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   Album MBID: ${albumMbid}`);
    logger.debug(`   Lidarr Album ID: ${lidarrAlbumId}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return undefined;
    }

    const result = await simpleDownloadManager.onDownloadComplete(
        downloadId,
        albumMbid,
        artistName,
        albumTitle,
        lidarrAlbumId
    );

    if (result.jobId) {
        const downloadJob = await prisma.downloadJob.findUnique({
            where: { id: result.jobId },
            select: { userId: true, id: true },
        });

        logger.debug(
            `   Triggering incremental scan for: ${artistName} - ${albumTitle}`
        );
        await scanQueue.add("scan", {
            userId: downloadJob?.userId || null,
            source: "lidarr-webhook",
            artistName: artistName,
            albumMbid: albumMbid,
            downloadId: result.jobId,
        });

        return result.jobId;
    } else {
        logger.debug(`   No matching job, triggering scan anyway...`);
        await scanQueue.add("scan", {
            type: "full",
            source: "lidarr-import-external",
        });
        return undefined;
    }
}

/**
 * Handle import failure with automatic retry
 * Returns correlation ID (download job ID) if job found
 */
async function handleImportFailure(payload: any): Promise<string | undefined> {
    const downloadId = payload.downloadId;
    const albumMbid =
        payload.album?.foreignAlbumId || payload.albums?.[0]?.foreignAlbumId;
    const albumTitle = payload.album?.title || payload.release?.title;
    const reason = payload.message || "Import failed";

    logger.debug(`   Album: ${albumTitle}`);
    logger.debug(`   Download ID: ${downloadId}`);
    logger.debug(`   Reason: ${reason}`);

    if (!downloadId) {
        logger.debug(`   Missing downloadId, skipping`);
        return undefined;
    }

    const result = await simpleDownloadManager.onImportFailed(downloadId, reason, albumMbid);
    return result.jobId;
}

export default router;
