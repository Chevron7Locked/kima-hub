/**
 * Processing a stored webhook event on the real test database: it never throws, even when the metrics do, and the
 * module's idle hook waits for events being processed, but only up to the bound it is given.
 */

import { prisma } from "../../utils/db";
import { webhookEventStore } from "../webhookEventStore";
import { processStoredEvent, whenWebhooksIdle } from "../webhookHandlers";
import { webhookEventsTotal, webhookProcessingDuration } from "../../utils/metrics";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { queues } from "../../workers/queues";
import { closeQueue } from "../../__tests__/helpers/closeQueue";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { expectLog } from "../../__tests__/helpers/expectedLogs";

const SOURCE = "webhook-processing-test";

async function storedTest(note: string) {
    const { event } = await webhookEventStore.storeEvent(SOURCE, "Test", { eventType: "Test", note });
    return event;
}

/** AlbumDelete reaches one handler call on the download manager, which a test can count. */
async function storedAlbumDelete(note: string) {
    const payload = { eventType: "AlbumDelete", album: { id: 987654 }, note };
    const { event } = await webhookEventStore.storeEvent(SOURCE, "AlbumDelete", payload);
    return { event, payload };
}

const clean = () => prisma.webhookEvent.deleteMany({ where: { source: SOURCE } });

beforeEach(clean);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
    await clean();
    await Promise.all(queues.map(closeQueue));
    await closeEngineConnections();
});

describe("processStoredEvent", () => {
    it("records the outcome and resolves when the events counter throws", async () => {
        const event = await storedTest("counter-throws");
        jest.spyOn(webhookEventsTotal, "inc").mockImplementation(() => {
            throw new Error("counter broke");
        });
        const logged = expectLog("warn");

        await expect(processStoredEvent(event.id, "Test", { eventType: "Test" })).resolves.toBeUndefined();

        expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ processed: true, error: null });
        expect(logged).toHaveBeenCalled();
    });

    it("records the outcome and resolves when the duration histogram throws", async () => {
        const event = await storedTest("histogram-throws");
        jest.spyOn(webhookProcessingDuration, "observe").mockImplementation(() => {
            throw new Error("histogram broke");
        });
        const logged = expectLog("warn");

        await expect(processStoredEvent(event.id, "Test", { eventType: "Test" })).resolves.toBeUndefined();

        expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ processed: true, error: null });
        expect(logged).toHaveBeenCalled();
    });

    it("still records a failed event and resolves when the metrics throw as well", async () => {
        const { event, payload } = await storedAlbumDelete("fails-and-metrics-throw");
        jest.spyOn(simpleDownloadManager, "onAlbumDeleted").mockRejectedValue(new Error("handler broke"));
        jest.spyOn(webhookEventsTotal, "inc").mockImplementation(() => {
            throw new Error("counter broke");
        });
        expectLog("error");
        expectLog("warn");

        await expect(processStoredEvent(event.id, "AlbumDelete", payload)).resolves.toBeUndefined();

        expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ processed: false, error: "handler broke" });
    });
});

describe("an event whose handler ran but whose mark did not stick", () => {
    it("is marked processed by one retry of the mark, with its handler called once", async () => {
        const { event, payload } = await storedAlbumDelete("mark-throws-once");
        const handler = jest.spyOn(simpleDownloadManager, "onAlbumDeleted").mockResolvedValue(undefined);
        const realMark = webhookEventStore.markProcessed.bind(webhookEventStore);
        jest.spyOn(webhookEventStore, "markProcessed")
            .mockRejectedValueOnce(new Error("database blinked"))
            .mockImplementation(realMark);
        const markFailed = jest.spyOn(webhookEventStore, "markFailed");
        expectLog("warn");

        await processStoredEvent(event.id, "AlbumDelete", payload);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(markFailed).not.toHaveBeenCalled();
        expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
            processed: true,
            error: null,
            retryCount: 0,
        });
    });

    it("is left unmarked, not failed, when the mark throws twice, and says so", async () => {
        const { event, payload } = await storedAlbumDelete("mark-throws-twice");
        const handler = jest.spyOn(simpleDownloadManager, "onAlbumDeleted").mockResolvedValue(undefined);
        jest.spyOn(webhookEventStore, "markProcessed").mockRejectedValue(new Error("database is gone"));
        const markFailed = jest.spyOn(webhookEventStore, "markFailed");
        const logged = expectLog("error");
        expectLog("warn");

        await expect(processStoredEvent(event.id, "AlbumDelete", payload)).resolves.toBeUndefined();

        expect(handler).toHaveBeenCalledTimes(1);
        expect(markFailed).not.toHaveBeenCalled();
        expect(webhookEventStore.markProcessed).toHaveBeenCalledTimes(2);
        expect(logged).toHaveBeenCalled();
        expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
            processed: false,
            error: null,
            retryCount: 0,
        });
    });

    it("counts a dispatch that failed as failed, as before, without trying to mark it processed", async () => {
        const { event, payload } = await storedAlbumDelete("dispatch-throws");
        jest.spyOn(simpleDownloadManager, "onAlbumDeleted").mockRejectedValue(new Error("lidarr said no"));
        const markProcessed = jest.spyOn(webhookEventStore, "markProcessed");
        expectLog("error");

        await processStoredEvent(event.id, "AlbumDelete", payload);

        expect(markProcessed).not.toHaveBeenCalled();
        expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
            processed: false,
            error: "lidarr said no",
            retryCount: 1,
        });
    });
});

describe("whenWebhooksIdle", () => {
    it("holds no longer than its bound for an event that never finishes, and waits for it without one", async () => {
        const event = await storedTest("never-finishes");
        let finish!: () => void;
        const stuck = new Promise<void>((resolve) => (finish = resolve));
        jest.spyOn(webhookEventStore, "markProcessed").mockImplementation(() => stuck as never);

        const processing = processStoredEvent(event.id, "Test", { eventType: "Test" });

        const started = Date.now();
        await whenWebhooksIdle(80);
        expect(Date.now() - started).toBeLessThan(1000);

        let idle = false;
        const waiting = whenWebhooksIdle().then(() => (idle = true));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(idle).toBe(false);

        finish();
        await processing;
        await waiting;
        expect(idle).toBe(true);
    });

    it("resolves at once when nothing is being processed, with or without a bound", async () => {
        await whenWebhooksIdle();
        await whenWebhooksIdle(5000);
    });
});
