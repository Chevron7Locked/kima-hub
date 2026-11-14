/**
 * Every 2 minutes: recovers Lidarr events whose webhook never arrived, then
 * retries stored events that are still unprocessed. Each cycle reschedules
 * after it finishes, so cycles never overlap.
 */

import { logger } from "../utils/logger";
import { webhookEventStore } from "../services/webhookEventStore";
import { processStoredEvent } from "../services/webhookHandlers";
import { recoverMissedEvents } from "../services/lidarrHistoryRecovery";
import { getSystemSettings } from "../utils/systemSettings";
import { isLidarrConfigured } from "../services/lidarrClient";

class WebhookReconciliationService {
    private isRunning = false;
    private cycleRunning = false;
    private timeoutId?: NodeJS.Timeout;
    private readonly RECONCILE_INTERVAL_MS = 2 * 60 * 1000;
    private readonly MAX_RETRIES = 3;
    // The webhook route is still processing events younger than this.
    private readonly IN_FLIGHT_MS = 60 * 1000;

    /** Safe to call more than once: a second call does not start another loop. */
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
    }

    stop() {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = undefined;
        }
        this.isRunning = false;
        logger.info("[WEBHOOK-RECONCILE] Stopped");
    }

    async runReconciliation() {
        // A slow cycle must not overlap the next one.
        if (!this.isRunning || this.cycleRunning) return;
        this.cycleRunning = true;

        try {
            const settings = await getSystemSettings();

            if (!isLidarrConfigured(settings)) {
                logger.debug("[WEBHOOK-RECONCILE] Lidarr not configured, skipping");
                return;
            }

            logger.debug("[WEBHOOK-RECONCILE] Starting reconciliation cycle");

            const recovered = await recoverMissedEvents(settings.lidarrUrl, settings.lidarrApiKey);
            if (recovered > 0) {
                logger.info(`[WEBHOOK-RECONCILE] Recovered ${recovered} event(s) from Lidarr history`);
            }

            const unprocessedEvents = await webhookEventStore.getUnprocessedEvents(
                "lidarr",
                this.MAX_RETRIES,
                this.IN_FLIGHT_MS
            );
            for (const event of unprocessedEvents) {
                // Stopped (shutdown) mid-cycle: start no further event.
                if (!this.isRunning) break;
                await processStoredEvent(event.id, event.eventType, event.payload);
            }
        } catch (error: any) {
            logger.error("[WEBHOOK-RECONCILE] Reconciliation cycle failed:", error.message);
        } finally {
            this.cycleRunning = false;
            if (this.isRunning) {
                this.timeoutId = setTimeout(() => {
                    this.runReconciliation();
                }, this.RECONCILE_INTERVAL_MS);
            }
        }
    }
}

export const webhookReconciliation = new WebhookReconciliationService();
