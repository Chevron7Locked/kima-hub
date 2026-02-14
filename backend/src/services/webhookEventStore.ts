/**
 * Webhook Event Store
 *
 * Event sourcing service for storing and processing webhook events.
 * Ensures all webhooks are persisted before processing, enabling:
 * - Replay of missed events
 * - Audit trail of all webhooks
 * - Resilience to server restarts
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import * as crypto from "crypto";

export interface WebhookEventPayload {
    eventType: string;
    [key: string]: any;
}

export interface StoredWebhookEvent {
    id: string;
    eventId: string;
    source: string;
    eventType: string;
    payload: WebhookEventPayload;
    processed: boolean;
    processedAt: Date | null;
    correlationId: string | null;
    error: string | null;
    retryCount: number;
    createdAt: Date;
}

class WebhookEventStore {
    /**
     * Store a webhook event before processing
     * Uses eventId for deduplication (same event won't be stored twice)
     */
    async storeEvent(
        source: string,
        eventType: string,
        payload: WebhookEventPayload,
        eventId?: string
    ): Promise<StoredWebhookEvent> {
        const generatedEventId = eventId || this.generateEventId(source, payload);

        try {
            const event = await prisma.webhookEvent.create({
                data: {
                    eventId: generatedEventId,
                    source,
                    eventType,
                    payload,
                },
            });

            logger.debug(`[WEBHOOK-STORE] Stored ${source} event: ${eventType} (${event.id})`);
            return event as StoredWebhookEvent;
        } catch (error: any) {
            if (error.code === 'P2002' && error.meta?.target?.includes('eventId')) {
                logger.debug(`[WEBHOOK-STORE] Duplicate event ignored: ${generatedEventId}`);
                const existing = await prisma.webhookEvent.findUnique({
                    where: { eventId: generatedEventId },
                });
                if (!existing) {
                    throw new Error('Duplicate event but not found in database');
                }
                return existing as StoredWebhookEvent;
            }
            throw error;
        }
    }

    /**
     * Mark an event as processed successfully
     */
    async markProcessed(
        eventId: string,
        correlationId?: string
    ): Promise<void> {
        await prisma.webhookEvent.update({
            where: { id: eventId },
            data: {
                processed: true,
                processedAt: new Date(),
                correlationId: correlationId || undefined,
            },
        });

        logger.debug(`[WEBHOOK-STORE] Marked processed: ${eventId}`);
    }

    /**
     * Mark an event as failed (stores error and increments retry count)
     */
    async markFailed(
        eventId: string,
        error: string
    ): Promise<void> {
        await prisma.webhookEvent.update({
            where: { id: eventId },
            data: {
                error,
                retryCount: {
                    increment: 1,
                },
            },
        });

        logger.debug(`[WEBHOOK-STORE] Marked failed: ${eventId} - ${error}`);
    }

    /**
     * Get unprocessed events for reconciliation
     * Excludes events that have exceeded max retries
     */
    async getUnprocessedEvents(
        source?: string,
        maxRetries: number = 3
    ): Promise<StoredWebhookEvent[]> {
        const events = await prisma.webhookEvent.findMany({
            where: {
                processed: false,
                retryCount: {
                    lt: maxRetries,
                },
                ...(source && { source }),
            },
            orderBy: {
                createdAt: 'asc',
            },
        });

        return events as StoredWebhookEvent[];
    }

    /**
     * Get events by correlation ID (find all events for a download job)
     */
    async getEventsByCorrelationId(
        correlationId: string
    ): Promise<StoredWebhookEvent[]> {
        const events = await prisma.webhookEvent.findMany({
            where: { correlationId },
            orderBy: {
                createdAt: 'asc',
            },
        });

        return events as StoredWebhookEvent[];
    }

    /**
     * Get event by Lidarr-provided eventId (for deduplication checking)
     */
    async getEventByEventId(eventId: string): Promise<StoredWebhookEvent | null> {
        const event = await prisma.webhookEvent.findUnique({
            where: { eventId },
        });

        return event as StoredWebhookEvent | null;
    }

    /**
     * Generate a unique event ID from payload
     * Uses downloadId + eventType for Lidarr events
     */
    private generateEventId(source: string, payload: WebhookEventPayload): string {
        if (source === 'lidarr' && payload.downloadId) {
            return `${source}-${payload.eventType}-${payload.downloadId}`;
        }

        const payloadStr = JSON.stringify(payload);
        const hash = crypto.createHash('sha256').update(payloadStr).digest('hex');
        return `${source}-${hash.substring(0, 16)}`;
    }

    /**
     * Clean up old processed events (older than N days)
     */
    async cleanupOldEvents(daysToKeep: number = 30): Promise<number> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

        const result = await prisma.webhookEvent.deleteMany({
            where: {
                processed: true,
                createdAt: {
                    lt: cutoffDate,
                },
            },
        });

        if (result.count > 0) {
            logger.info(`[WEBHOOK-STORE] Cleaned up ${result.count} old events`);
        }

        return result.count;
    }
}

export const webhookEventStore = new WebhookEventStore();
