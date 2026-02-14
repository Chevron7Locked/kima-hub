/**
 * Webhook Reconciliation Job
 *
 * Runs every 5 minutes to:
 * 1. Process unprocessed webhook events (failed/missed webhooks)
 * 2. Reconcile DownloadJobs with Lidarr's queue (update statuses)
 *
 * This ensures:
 * - Failed webhook processing gets retried
 * - Download job statuses stay in sync with Lidarr
 * - No events are permanently lost
 */

import { logger } from "../utils/logger";
import { webhookEventStore } from "../services/webhookEventStore";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { getSystemSettings } from "../utils/systemSettings";

class WebhookReconciliationService {
    private isRunning = false;
    private intervalId?: NodeJS.Timeout;
    private readonly RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    private readonly MAX_RETRIES = 3;

    /**
     * Start the reconciliation loop
     * Safe to call multiple times - won't create duplicate loops
     */
    start() {
        if (this.isRunning) {
            logger.debug("[WEBHOOK-RECONCILE] Already running");
            return;
        }

        this.isRunning = true;
        logger.info(
            `[WEBHOOK-RECONCILE] Started (runs every ${this.RECONCILE_INTERVAL_MS / 1000}s)`
        );

        this.runReconciliation();

        this.intervalId = setInterval(() => {
            this.runReconciliation();
        }, this.RECONCILE_INTERVAL_MS);
    }

    /**
     * Stop the reconciliation loop
     */
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        this.isRunning = false;
        logger.info("[WEBHOOK-RECONCILE] Stopped");
    }

    /**
     * Run a single reconciliation cycle
     */
    async runReconciliation() {
        if (!this.isRunning) return;

        try {
            const settings = await getSystemSettings();

            if (!settings?.lidarrEnabled || !settings?.lidarrUrl || !settings?.lidarrApiKey) {
                logger.debug("[WEBHOOK-RECONCILE] Lidarr not configured, skipping");
                return;
            }

            logger.debug("[WEBHOOK-RECONCILE] Starting reconciliation cycle");

            const startTime = Date.now();
            let processedCount = 0;
            let failedCount = 0;

            const unprocessedEvents = await webhookEventStore.getUnprocessedEvents(
                "lidarr",
                this.MAX_RETRIES
            );

            if (unprocessedEvents.length === 0) {
                logger.debug("[WEBHOOK-RECONCILE] No unprocessed events");
            } else {
                logger.debug(
                    `[WEBHOOK-RECONCILE] Found ${unprocessedEvents.length} unprocessed events`
                );

                for (const event of unprocessedEvents) {
                    try {
                        const correlationId = await this.processEvent(event);
                        await webhookEventStore.markProcessed(event.id, correlationId);
                        processedCount++;
                    } catch (error: any) {
                        logger.error(
                            `[WEBHOOK-RECONCILE] Failed to process event ${event.id}:`,
                            error.message
                        );
                        await webhookEventStore.markFailed(event.id, error.message);
                        failedCount++;
                    }
                }
            }

            const lidarrResult = await simpleDownloadManager.reconcileWithLidarr();

            const duration = Date.now() - startTime;
            logger.debug(
                `[WEBHOOK-RECONCILE] Cycle complete in ${duration}ms: ` +
                `${processedCount} events processed, ${failedCount} failed, ` +
                `${lidarrResult.reconciled} jobs reconciled from Lidarr`
            );
        } catch (error: any) {
            logger.error("[WEBHOOK-RECONCILE] Reconciliation cycle failed:", error.message);
        }
    }

    /**
     * Process a single webhook event
     */
    private async processEvent(event: any): Promise<string | undefined> {
        const payload = event.payload;
        const eventType = event.eventType;

        logger.debug(
            `[WEBHOOK-RECONCILE] Processing ${eventType} event (retry ${event.retryCount})`
        );

        switch (eventType) {
            case "Grab":
                return await this.handleGrab(payload);

            case "Download":
            case "AlbumDownload":
            case "TrackRetag":
            case "Rename":
                return await this.handleDownload(payload);

            case "ImportFailure":
            case "DownloadFailed":
            case "DownloadFailure":
                return await this.handleImportFailure(payload);

            default:
                logger.debug(`[WEBHOOK-RECONCILE] Skipping ${eventType} event`);
                return undefined;
        }
    }

    /**
     * Handle Grab event
     */
    private async handleGrab(payload: any): Promise<string | undefined> {
        const downloadId = payload.downloadId;
        const albumMbid = payload.albums?.[0]?.foreignAlbumId || payload.albums?.[0]?.mbId;
        const albumTitle = payload.albums?.[0]?.title;
        const artistName = payload.artist?.name;
        const lidarrAlbumId = payload.albums?.[0]?.id;

        if (!downloadId) {
            return undefined;
        }

        const result = await simpleDownloadManager.onDownloadGrabbed(
            downloadId,
            albumMbid || "",
            albumTitle || "",
            artistName || "",
            lidarrAlbumId || 0
        );

        return result.matched ? result.jobId : undefined;
    }

    /**
     * Handle Download complete event
     */
    private async handleDownload(payload: any): Promise<string | undefined> {
        const downloadId = payload.downloadId;
        const albumTitle = payload.album?.title || payload.albums?.[0]?.title;
        const artistName = payload.artist?.name;
        const albumMbid = payload.album?.foreignAlbumId || payload.albums?.[0]?.foreignAlbumId;
        const lidarrAlbumId = payload.album?.id || payload.albums?.[0]?.id;

        if (!downloadId) {
            return undefined;
        }

        const result = await simpleDownloadManager.onDownloadComplete(
            downloadId,
            albumMbid,
            artistName,
            albumTitle,
            lidarrAlbumId
        );

        return result.jobId;
    }

    /**
     * Handle Import failure event
     */
    private async handleImportFailure(payload: any): Promise<string | undefined> {
        const downloadId = payload.downloadId;
        const albumMbid = payload.album?.foreignAlbumId || payload.albums?.[0]?.foreignAlbumId;
        const reason = payload.message || "Import failed";

        if (!downloadId) {
            return undefined;
        }

        const result = await simpleDownloadManager.onImportFailed(
            downloadId,
            reason,
            albumMbid
        );

        return result.jobId;
    }

    /**
     * Manually trigger reconciliation (for testing)
     */
    async triggerReconciliation(): Promise<void> {
        await this.runReconciliation();
    }
}

export const webhookReconciliation = new WebhookReconciliationService();
