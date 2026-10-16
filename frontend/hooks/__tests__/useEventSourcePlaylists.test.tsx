/**
 * A live `playlist:updated` event refreshes the playlist list and that playlist. A deleted playlist is never asked
 * for again: an open page reading it is left alone and told it is gone (the `playlist-deleted` signal), and a cached
 * copy nobody reads is dropped. Real QueryClient; the browser's EventSource is a stand-in that delivers messages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock("@/lib/api", () => ({ api: { getSSETicket: async () => "ticket-1" }, getApiBaseUrl: () => "" }));

import { useEventSource } from "@/hooks/useEventSource";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Stands in for the browser's EventSource: the test hands it messages. */
class FakeEventSource {
    static last: FakeEventSource | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;
    constructor(readonly url: string) {
        FakeEventSource.last = this;
    }
    close() {}
}

let client: QueryClient;
let root: Root;
const openPlaylistFetches = vi.fn(async () => ({ id: "p-open", name: "Open" }));

function Listener() {
    useEventSource();
    return null;
}
function OpenPlaylistPage() {
    useQuery({ queryKey: ["playlist", "p-open"], queryFn: openPlaylistFetches });
    return null;
}

async function render(children: React.ReactNode) {
    await act(async () => {
        root.render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
    });
    // The hook asks for a ticket before it opens the stream.
    await act(async () => {});
}

const deliver = (event: Record<string, unknown>) =>
    act(async () => FakeEventSource.last!.onmessage!({ data: JSON.stringify(event) }));

beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    FakeEventSource.last = null;
    openPlaylistFetches.mockClear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    root = createRoot(document.createElement("div"));
});

afterEach(() => {
    act(() => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
});

describe("live playlist events", () => {
    it("a change refreshes the playlist list and that playlist", async () => {
        client.setQueryData(["playlists"], []);
        client.setQueryData(["playlist", "p-1"], { id: "p-1" });
        await render(<Listener />);

        await deliver({ type: "playlist:updated", playlistId: "p-1", deleted: false });

        expect(client.getQueryState(["playlists"])?.isInvalidated).toBe(true);
        expect(client.getQueryState(["playlist", "p-1"])?.isInvalidated).toBe(true);
    });

    it("a deleted playlist a page is showing is not asked for again, and the page is told", async () => {
        await render(
            <>
                <Listener />
                <OpenPlaylistPage />
            </>,
        );
        expect(openPlaylistFetches).toHaveBeenCalledTimes(1);
        const told: string[] = [];
        const onDeleted = (e: Event) => told.push((e as CustomEvent<{ playlistId: string }>).detail.playlistId);
        window.addEventListener("playlist-deleted", onDeleted);

        await deliver({ type: "playlist:updated", playlistId: "p-open", deleted: true });
        await act(async () => {});
        window.removeEventListener("playlist-deleted", onDeleted);

        expect(openPlaylistFetches, "the deleted playlist was asked for again").toHaveBeenCalledTimes(1);
        expect(told).toEqual(["p-open"]);
    });

    it("a deleted playlist nobody is reading is dropped from the cache", async () => {
        client.setQueryData(["playlist", "p-gone"], { id: "p-gone" });
        await render(<Listener />);

        await deliver({ type: "playlist:updated", playlistId: "p-gone", deleted: true });

        expect(client.getQueryData(["playlist", "p-gone"])).toBeUndefined();
    });
});
