/**
 * WebhookEventStore Tests
 *
 * Tests event storage, deduplication, and retrieval.
 * Run with: npx jest webhookEventStore.test.ts
 */

import { webhookEventStore } from "../webhookEventStore";
import { prisma } from "../../utils/db";

describe("WebhookEventStore", () => {
    beforeEach(async () => {
        await prisma.webhookEvent.deleteMany({});
    });

    afterAll(async () => {
        await prisma.webhookEvent.deleteMany({});
        await prisma.$disconnect();
    });

    describe("storeEvent", () => {
        it("should store a new webhook event", async () => {
            const event = await webhookEventStore.storeEvent(
                "test",
                "TestEvent",
                {
                    eventType: "TestEvent",
                    data: "test-data",
                }
            );

            expect(event.id).toBeDefined();
            expect(event.source).toBe("test");
            expect(event.eventType).toBe("TestEvent");
            expect(event.processed).toBe(false);
            expect(event.retryCount).toBe(0);
        });

        it("should deduplicate events with same eventId", async () => {
            const payload = {
                eventType: "Grab",
                downloadId: "test-download-123",
            };

            const event1 = await webhookEventStore.storeEvent(
                "lidarr",
                "Grab",
                payload,
                "lidarr-Grab-test-download-123"
            );

            const event2 = await webhookEventStore.storeEvent(
                "lidarr",
                "Grab",
                payload,
                "lidarr-Grab-test-download-123"
            );

            expect(event1.id).toBe(event2.id);

            const allEvents = await prisma.webhookEvent.findMany({
                where: { eventId: "lidarr-Grab-test-download-123" },
            });
            expect(allEvents).toHaveLength(1);
        });

        it("should auto-generate eventId from downloadId for lidarr events", async () => {
            const event = await webhookEventStore.storeEvent(
                "lidarr",
                "Grab",
                {
                    eventType: "Grab",
                    downloadId: "test-download-456",
                }
            );

            expect(event.eventId).toBe("lidarr-Grab-test-download-456");
        });
    });

    describe("markProcessed", () => {
        it("should mark event as processed with correlation ID", async () => {
            const event = await webhookEventStore.storeEvent(
                "test",
                "TestEvent",
                {
                    eventType: "TestEvent",
                    data: "test",
                }
            );

            await webhookEventStore.markProcessed(event.id, "job-123");

            const updated = await prisma.webhookEvent.findUnique({
                where: { id: event.id },
            });

            expect(updated?.processed).toBe(true);
            expect(updated?.processedAt).toBeDefined();
            expect(updated?.correlationId).toBe("job-123");
        });
    });

    describe("markFailed", () => {
        it("should increment retry count and store error", async () => {
            const event = await webhookEventStore.storeEvent(
                "test",
                "TestEvent",
                {
                    eventType: "TestEvent",
                    data: "test",
                }
            );

            await webhookEventStore.markFailed(event.id, "Test error");

            const updated = await prisma.webhookEvent.findUnique({
                where: { id: event.id },
            });

            expect(updated?.error).toBe("Test error");
            expect(updated?.retryCount).toBe(1);

            await webhookEventStore.markFailed(event.id, "Second error");

            const updated2 = await prisma.webhookEvent.findUnique({
                where: { id: event.id },
            });

            expect(updated2?.retryCount).toBe(2);
        });
    });

    describe("getUnprocessedEvents", () => {
        it("should return only unprocessed events under retry limit", async () => {
            const event1 = await webhookEventStore.storeEvent(
                "test",
                "Event1",
                { eventType: "Event1" }
            );

            const event2 = await webhookEventStore.storeEvent(
                "test",
                "Event2",
                { eventType: "Event2" }
            );

            const event3 = await webhookEventStore.storeEvent(
                "test",
                "Event3",
                { eventType: "Event3" }
            );

            await webhookEventStore.markProcessed(event1.id);

            await webhookEventStore.markFailed(event3.id, "Error 1");
            await webhookEventStore.markFailed(event3.id, "Error 2");
            await webhookEventStore.markFailed(event3.id, "Error 3");

            const unprocessed = await webhookEventStore.getUnprocessedEvents("test");

            expect(unprocessed).toHaveLength(1);
            expect(unprocessed[0].id).toBe(event2.id);
        });

        it("should filter by source", async () => {
            await webhookEventStore.storeEvent(
                "lidarr",
                "Grab",
                { eventType: "Grab", downloadId: "1" }
            );

            await webhookEventStore.storeEvent(
                "test",
                "TestEvent",
                { eventType: "TestEvent" }
            );

            const lidarrEvents = await webhookEventStore.getUnprocessedEvents("lidarr");
            expect(lidarrEvents).toHaveLength(1);
            expect(lidarrEvents[0].source).toBe("lidarr");
        });
    });

    describe("getEventsByCorrelationId", () => {
        it("should return all events for a correlation ID", async () => {
            const event1 = await webhookEventStore.storeEvent(
                "test",
                "Grab",
                { eventType: "Grab" }
            );

            const event2 = await webhookEventStore.storeEvent(
                "test",
                "Download",
                { eventType: "Download" }
            );

            await webhookEventStore.markProcessed(event1.id, "job-123");
            await webhookEventStore.markProcessed(event2.id, "job-123");

            const events = await webhookEventStore.getEventsByCorrelationId("job-123");

            expect(events).toHaveLength(2);
            expect(events[0].correlationId).toBe("job-123");
            expect(events[1].correlationId).toBe("job-123");
        });
    });

    describe("cleanupOldEvents", () => {
        it("should delete old processed events", async () => {
            const event = await webhookEventStore.storeEvent(
                "test",
                "OldEvent",
                { eventType: "OldEvent" }
            );

            await webhookEventStore.markProcessed(event.id);

            await prisma.webhookEvent.update({
                where: { id: event.id },
                data: {
                    createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
                },
            });

            const deleted = await webhookEventStore.cleanupOldEvents(30);
            expect(deleted).toBe(1);

            const found = await prisma.webhookEvent.findUnique({
                where: { id: event.id },
            });
            expect(found).toBeNull();
        });

        it("should not delete unprocessed events", async () => {
            const event = await webhookEventStore.storeEvent(
                "test",
                "OldEvent",
                { eventType: "OldEvent" }
            );

            await prisma.webhookEvent.update({
                where: { id: event.id },
                data: {
                    createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
                },
            });

            const deleted = await webhookEventStore.cleanupOldEvents(30);
            expect(deleted).toBe(0);
        });
    });
});
