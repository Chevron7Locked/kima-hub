/**
 * WebhookEventStore Tests
 *
 * Tests event storage, deduplication, ID generation, and state transitions.
 * Prisma is mocked -- this verifies service logic, not DB persistence.
 */

jest.mock('../../utils/db', () => ({
    prisma: {
        webhookEvent: {
            create: jest.fn(),
            findUnique: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
            deleteMany: jest.fn(),
        },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { webhookEventStore } from "../webhookEventStore";
import { prisma } from "../../utils/db";

const BASE_EVENT = {
    id: "event-abc-123",
    eventId: "test-abc123456789abcd",
    source: "test",
    eventType: "TestEvent",
    payload: { eventType: "TestEvent" },
    processed: false,
    processedAt: null,
    correlationId: null,
    error: null,
    retryCount: 0,
    createdAt: new Date(),
};

describe("WebhookEventStore", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("storeEvent", () => {
        it("stores a new event and returns it", async () => {
            (prisma.webhookEvent.create as jest.Mock).mockResolvedValue(BASE_EVENT);

            const result = await webhookEventStore.storeEvent("test", "TestEvent", {
                eventType: "TestEvent",
            });

            expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
            expect(result.id).toBe(BASE_EVENT.id);
            expect(result.source).toBe("test");
            expect(result.processed).toBe(false);
            expect(result.retryCount).toBe(0);
        });

        it("returns existing event on P2002 duplicate -- dedup without crashing", async () => {
            const dupError = Object.assign(new Error("Unique constraint"), {
                code: "P2002",
                meta: { target: ["eventId"] },
            });
            (prisma.webhookEvent.create as jest.Mock).mockRejectedValue(dupError);
            (prisma.webhookEvent.findUnique as jest.Mock).mockResolvedValue(BASE_EVENT);

            const result = await webhookEventStore.storeEvent(
                "lidarr",
                "Grab",
                { eventType: "Grab", downloadId: "123" },
                "lidarr-Grab-123"
            );

            // Must NOT throw -- must return the existing event
            expect(result.id).toBe(BASE_EVENT.id);
            expect(prisma.webhookEvent.findUnique).toHaveBeenCalledWith({
                where: { eventId: "lidarr-Grab-123" },
            });
        });

        it("throws on non-dedup Prisma errors -- does not swallow failures", async () => {
            (prisma.webhookEvent.create as jest.Mock).mockRejectedValue(
                new Error("DB connection lost")
            );

            await expect(
                webhookEventStore.storeEvent("test", "TestEvent", { eventType: "TestEvent" })
            ).rejects.toThrow("DB connection lost");
        });

        it("auto-generates lidarr eventId as source-eventType-downloadId", async () => {
            (prisma.webhookEvent.create as jest.Mock).mockResolvedValue({
                ...BASE_EVENT,
                eventId: "lidarr-Grab-dl-456",
                source: "lidarr",
                eventType: "Grab",
            });

            await webhookEventStore.storeEvent("lidarr", "Grab", {
                eventType: "Grab",
                downloadId: "dl-456",
            });

            const callArg = (prisma.webhookEvent.create as jest.Mock).mock.calls[0][0];
            expect(callArg.data.eventId).toBe("lidarr-Grab-dl-456");
        });

        it("generates a hash-based eventId for non-lidarr events (no downloadId)", async () => {
            (prisma.webhookEvent.create as jest.Mock).mockResolvedValue(BASE_EVENT);

            await webhookEventStore.storeEvent("test", "TestEvent", {
                eventType: "TestEvent",
            });

            const callArg = (prisma.webhookEvent.create as jest.Mock).mock.calls[0][0];
            // ID must be "test-<16 hex chars>"
            expect(callArg.data.eventId).toMatch(/^test-[0-9a-f]{16}$/);
        });
    });

    describe("markProcessed", () => {
        it("sets processed=true and processedAt, stores correlationId", async () => {
            (prisma.webhookEvent.update as jest.Mock).mockResolvedValue({});

            await webhookEventStore.markProcessed("event-abc-123", "job-xyz");

            expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
                where: { id: "event-abc-123" },
                data: expect.objectContaining({
                    processed: true,
                    correlationId: "job-xyz",
                }),
            });
            // processedAt must be a Date
            const data = (prisma.webhookEvent.update as jest.Mock).mock.calls[0][0].data;
            expect(data.processedAt).toBeInstanceOf(Date);
        });
    });

    describe("markFailed", () => {
        it("increments retryCount and stores error message", async () => {
            (prisma.webhookEvent.update as jest.Mock).mockResolvedValue({});

            await webhookEventStore.markFailed("event-abc-123", "connection timeout");

            expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
                where: { id: "event-abc-123" },
                data: {
                    error: "connection timeout",
                    retryCount: { increment: 1 },
                },
            });
        });
    });

    describe("getUnprocessedEvents", () => {
        it("queries for unprocessed events below retry limit, filtered by source", async () => {
            (prisma.webhookEvent.findMany as jest.Mock).mockResolvedValue([]);

            await webhookEventStore.getUnprocessedEvents("lidarr");

            expect(prisma.webhookEvent.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        processed: false,
                        retryCount: { lt: 3 },
                        source: "lidarr",
                    }),
                })
            );
        });

        it("queries without source filter when source is not provided", async () => {
            (prisma.webhookEvent.findMany as jest.Mock).mockResolvedValue([]);

            await webhookEventStore.getUnprocessedEvents();

            const call = (prisma.webhookEvent.findMany as jest.Mock).mock.calls[0][0];
            // source should NOT be in the where clause
            expect(call.where.source).toBeUndefined();
        });
    });

    describe("cleanupOldEvents", () => {
        it("deletes only processed events older than the cutoff date", async () => {
            (prisma.webhookEvent.deleteMany as jest.Mock).mockResolvedValue({ count: 5 });

            const deleted = await webhookEventStore.cleanupOldEvents(30);

            expect(deleted).toBe(5);
            const call = (prisma.webhookEvent.deleteMany as jest.Mock).mock.calls[0][0];
            expect(call.where.processed).toBe(true);
            expect(call.where.createdAt.lt).toBeInstanceOf(Date);
            // Cutoff must be approximately 30 days ago
            const cutoff = call.where.createdAt.lt as Date;
            const daysAgo = (Date.now() - cutoff.getTime()) / (1000 * 60 * 60 * 24);
            expect(daysAgo).toBeCloseTo(30, 0);
        });
    });
});
