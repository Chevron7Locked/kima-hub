/**
 * Stopping the reconciliation job while a cycle is running: the cycle starts no further events, and no next cycle is
 * scheduled. Shutdown relies on this, because it drains the events being processed and anything started after that
 * is cut off by the database closing.
 */

import { webhookReconciliation } from "../webhookReconciliation";
import { webhookEventStore } from "../../services/webhookEventStore";
import * as webhookHandlers from "../../services/webhookHandlers";
import * as lidarrHistoryRecovery from "../../services/lidarrHistoryRecovery";
import * as systemSettings from "../../utils/systemSettings";

const event = (id: string) => ({ id, eventType: "Test", payload: { eventType: "Test" } }) as never;

afterEach(() => {
    webhookReconciliation.stop();
    jest.restoreAllMocks();
});

it("starts no further event once it is stopped mid-cycle, and schedules no next cycle", async () => {
    jest.spyOn(systemSettings, "getSystemSettings").mockResolvedValue({ lidarrEnabled: true, lidarrUrl: "http://lidarr.invalid", lidarrApiKey: "key" } as never);
    jest.spyOn(lidarrHistoryRecovery, "recoverMissedEvents").mockResolvedValue(0);
    jest.spyOn(webhookEventStore, "getUnprocessedEvents").mockResolvedValue([event("a"), event("b"), event("c")]);
    const started: string[] = [];
    jest.spyOn(webhookHandlers, "processStoredEvent").mockImplementation(async (id: string) => {
        started.push(id);
        // Shutdown arrives while the first event is being processed.
        webhookReconciliation.stop();
    });
    const timers = jest.spyOn(global, "setTimeout");

    webhookReconciliation.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(started).toEqual(["a"]);
    expect(timers.mock.calls.filter(([, ms]) => ms === 2 * 60 * 1000)).toHaveLength(0);
});
