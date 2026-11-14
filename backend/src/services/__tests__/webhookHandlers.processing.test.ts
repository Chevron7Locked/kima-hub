/**
 * Processing a stored webhook event on the real test database: it never throws, even when the metrics do, and the
 * module's idle hook waits for events being processed, but only up to the bound it is given.
 */

import { prisma } from "../../utils/db";
import { webhookEventStore } from "../webhookEventStore";
import { processStoredEvent, whenWebhooksIdle } from "../webhookHandlers";
import { webhookEventsTotal, webhookProcessingDuration } from "../../utils/metrics";
import { queues } from "../../workers/queues";
import { closeQueue } from "../../__tests__/helpers/closeQueue";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { expectLog } from "../../__tests__/helpers/expectedLogs";

const SOURCE = "webhook-processing-test";

async function storedTest(note: string) {
    const { event } = await webhookEventStore.storeEvent(SOURCE, "Test", { eventType: "Test", note });
    return event;
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
        const event = await storedTest("fails-and-metrics-throw");
        jest.spyOn(webhookEventStore, "markProcessed").mockRejectedValue(new Error("handler broke"));
        jest.spyOn(webhookEventsTotal, "inc").mockImplementation(() => {
            throw new Error("counter broke");
        });
        expectLog("error");
        expectLog("warn");

        await expect(processStoredEvent(event.id, "Test", { eventType: "Test" })).resolves.toBeUndefined();

        expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ processed: false, error: "handler broke" });
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
