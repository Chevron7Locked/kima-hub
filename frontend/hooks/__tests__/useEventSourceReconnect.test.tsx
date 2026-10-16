/**
 * Events sent while the stream is down are not replayed, so a reconnect refreshes every cache the stream keeps fresh:
 * whatever any event would have refreshed during the gap. The first connect refreshes nothing (pages just loaded).
 * Real QueryClient; the browser's EventSource is a stand-in that delivers messages and drops on request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { readFileSync } from "fs";
import path from "path";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock("@/lib/api", () => ({
    api: {
        getSSETicket: async () => "ticket-1",
        getDiscoverBatchStatus: async () => ({ active: false, status: null, batchId: null }),
    },
    getApiBaseUrl: () => "",
}));

import { useEventSource } from "@/hooks/useEventSource";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Stands in for the browser's EventSource: the test hands it messages, or drops it. */
class FakeEventSource {
    static opened: FakeEventSource[] = [];
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;
    constructor(readonly url: string) {
        FakeEventSource.opened.push(this);
    }
    close() {}
}
const current = () => FakeEventSource.opened[FakeEventSource.opened.length - 1];

/** One of every event that refreshes a cache, as the server sends them. */
const EVERY_REFRESHING_EVENT = [
    { type: "notification", notificationType: "playlist_ready" },
    { type: "download:complete", albumId: "a-1" },
    { type: "download:failed" },
    { type: "scan:complete", jobId: "j-1", result: {} },
    { type: "enrichment:progress" },
    { type: "import:progress", jobId: "i-1", status: "completed" },
    { type: "playlist:updated", playlistId: "p-1", deleted: false },
];

/** Events that refresh no cache: they set job status the page polls, hand search results over, or open the stream. */
const REFRESHES_NOTHING = [
    "search:result",
    "search:complete",
    "scan:progress",
    "discover:progress",
    "discover:complete",
    "preview:progress",
    "preview:complete",
    "connected",
];

let client: QueryClient;
let root: Root;

function Listener() {
    useEventSource();
    return null;
}

const deliver = (event: Record<string, unknown>) =>
    act(async () => current().onmessage!({ data: JSON.stringify(event) }));

/** What one batch of events asks to refresh, as the keys handed to invalidateQueries. */
async function keysRefreshedBy(events: Record<string, unknown>[]): Promise<QueryKey[]> {
    const spy = vi.spyOn(client, "invalidateQueries");
    for (const event of events) await deliver(event);
    const keys = spy.mock.calls.map(([filters]) => filters?.queryKey).filter((k): k is QueryKey => !!k);
    spy.mockRestore();
    return keys;
}

const covers = (refreshed: QueryKey[], key: QueryKey) =>
    refreshed.some((prefix) => prefix.every((part, i) => part === key[i]));

beforeEach(async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.opened = [];
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<QueryClientProvider client={client}><Listener /></QueryClientProvider>));
    await act(async () => {});
});

afterEach(() => {
    act(() => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
});

describe("the event stream reconnecting", () => {
    it("knows every event the stream handles: each one either refreshes caches (listed above) or refreshes none", () => {
        const source = readFileSync(path.resolve(__dirname, "../useEventSource.ts"), "utf8");
        const handled = [...source.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
        const classified = new Set([...EVERY_REFRESHING_EVENT.map((e) => e.type), ...REFRESHES_NOTHING]);
        // Several notification types share one handler; the first of them stands for the group.
        const unclassified = handled.filter((type) => !classified.has(type) && !type.startsWith("notification:"));
        expect(unclassified, "an event the stream handles that this test does not cover").toEqual([]);
    });

    it("refreshes nothing on the first connect", async () => {
        expect(await keysRefreshedBy([{ type: "connected" }])).toEqual([]);
    });

    it("refreshes, on a reconnect, every cache any event would have refreshed during the gap", async () => {
        const fedByEvents = await keysRefreshedBy(EVERY_REFRESHING_EVENT);
        expect(fedByEvents.length).toBeGreaterThan(0);

        // The stream drops; the hook opens a new one after its backoff (1 s on the first retry).
        await act(async () => {
            current().onerror!();
            await new Promise((resolve) => setTimeout(resolve, 1_100));
        });
        expect(FakeEventSource.opened).toHaveLength(2);
        const refreshedOnReconnect = await keysRefreshedBy([{ type: "connected" }]);

        const missed = fedByEvents.filter((key) => !covers(refreshedOnReconnect, key));
        expect(missed, "caches an event refreshes that a reconnect leaves stale").toEqual([]);
    });
});
