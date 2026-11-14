/**
 * After shutdown has stopped webhook processing, an event that arrives (from the route, the reconciliation cycle or the
 * history recovery) starts no handler. It stays unprocessed in the store, where the next start replays it. Its own
 * file: the stop is for the life of the process, so it cannot be undone for the other cases.
 */

import { prisma } from "../../utils/db";
import { webhookEventStore } from "../webhookEventStore";
import { processStoredEvent, stopWebhookProcessing, whenWebhooksIdle } from "../webhookHandlers";
import { simpleDownloadManager } from "../simpleDownloadManager";
import { queues } from "../../workers/queues";
import { closeQueue } from "../../__tests__/helpers/closeQueue";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const SOURCE = "webhook-stopped-test";
const clean = () => prisma.webhookEvent.deleteMany({ where: { source: SOURCE } });

beforeEach(clean);
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
    await clean();
    await Promise.all(queues.map(closeQueue));
    await closeEngineConnections();
});

it("runs no handler for an event that arrives after the stop, and leaves it unprocessed", async () => {
    const handler = jest.spyOn(simpleDownloadManager, "onAlbumDeleted").mockResolvedValue(undefined);
    const payload = { eventType: "AlbumDelete", album: { id: 987655 } };
    const { event } = await webhookEventStore.storeEvent(SOURCE, "AlbumDelete", payload);

    stopWebhookProcessing();
    await expect(processStoredEvent(event.id, "AlbumDelete", payload)).resolves.toBeUndefined();
    await whenWebhooksIdle();

    expect(handler).not.toHaveBeenCalled();
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
        processed: false,
        error: null,
        retryCount: 0,
    });
});
