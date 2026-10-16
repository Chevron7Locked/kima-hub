/**
 * Quick edits to one playlist, each shown at once: nothing asks the server for the playlist while another edit to it
 * is still on its way, or the reply (which lacks that edit) would briefly undo it on screen. The last edit to settle
 * fetches the server's truth. That holds for an edit settling, for this device hearing its own change back over the
 * live stream, and for an edit that fails (its undo would also wipe the edit still on its way).
 * Real QueryClient and hooks; the server is a stand-in whose replies the test releases one at a time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Item = { id: string; track: { id: string } };
let server: { items: Item[]; name: string };
/** No reply comes back: requests fail, as on a phone that lost its connection. */
let offline = false;
/** Playlist fetches wait for the test to release them (labelled "fetch"), so what is shown meanwhile can be read. */
let holdFetches = false;
const held: Array<{ label: string; release: () => void; fail: () => void }> = [];
const fetches = vi.fn();

/** A request the test answers later: it applies its change to the server when released. */
const later = (label: string, change: () => void) =>
    new Promise<void>((resolve, reject) =>
        held.push({ label, release: () => (change(), resolve()), fail: () => reject(new Error("refused")) }),
    );
/** The held request with this label (requests go out in their own order: an edit shown at once goes out later). */
const request = (label: string) => held.find((h) => h.label === label)!;

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock("@/lib/api", () => ({
    api: {
        getPlaylist: async () => {
            fetches();
            if (offline) throw new Error("offline");
            if (holdFetches) await later("fetch", () => undefined);
            return { id: "p-1", name: server.name, items: server.items.map((i) => ({ ...i })) };
        },
        removeTrackFromPlaylist: (_p: string, trackId: string) =>
            later(`remove ${trackId}`, () => (server.items = server.items.filter((i) => i.track.id !== trackId))),
        updatePlaylist: (_p: string, data: { name?: string }) =>
            later("rename", () => (server.name = data.name ?? server.name)),
        getSSETicket: async () => "ticket-1",
        getDiscoverBatchStatus: async () => ({ active: false, status: null, batchId: null }),
    },
    getApiBaseUrl: () => "",
}));

import { usePlaylistQuery, useRemoveFromPlaylistMutation, useUpdatePlaylistMutation } from "@/hooks/useQueries";
import { useEventSource } from "@/hooks/useEventSource";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
    static last: FakeEventSource | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
        FakeEventSource.last = this;
    }
    close() {}
}

let client: QueryClient;
let root: Root;
const probe = {} as { remove: (trackId: string) => Promise<unknown>; rename: (name: string) => Promise<unknown> };

function Page() {
    usePlaylistQuery("p-1");
    useEventSource();
    const { mutateAsync } = useRemoveFromPlaylistMutation();
    const { mutateAsync: update } = useUpdatePlaylistMutation();
    useEffect(() => {
        probe.remove = (trackId) => mutateAsync({ playlistId: "p-1", trackId }).catch(() => undefined);
        probe.rename = (name) => update({ playlistId: "p-1", data: { name } }).catch(() => undefined);
    });
    return null;
}

const item = (id: string): Item => ({ id: `i-${id}`, track: { id } });
const shown = () => (client.getQueryData(["playlist", "p-1"]) as { items: Item[] }).items.map((i) => i.track.id);
/** Let requests, replies and the query library's timers run. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    server = { items: [item("a"), item("b"), item("c")], name: "Mine" };
    offline = false;
    holdFetches = false;
    held.length = 0;
    fetches.mockClear();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<QueryClientProvider client={client}><Page /></QueryClientProvider>));
    await settle();
    expect(shown()).toEqual(["a", "b", "c"]);
    fetches.mockClear();
});

afterEach(() => {
    act(() => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
});

describe("two quick edits to one playlist", () => {
    it("the first settling leaves the second on screen; the last one fetches the server's truth", async () => {
        void probe.remove("a");
        void probe.remove("b");
        await settle();
        expect(shown()).toEqual(["c"]);

        await act(async () => request("remove a").release());
        await settle();
        expect(shown(), "the first edit's refetch undid the second on screen").toEqual(["c"]);
        expect(fetches).not.toHaveBeenCalled();

        await act(async () => request("remove b").release());
        await settle();
        expect(fetches).toHaveBeenCalledTimes(1);
        expect(shown()).toEqual(["c"]);
    });

    it("hearing its own change back while an edit is on its way asks nothing", async () => {
        void probe.remove("a");
        await settle();

        await act(async () => FakeEventSource.last!.onmessage!({ data: JSON.stringify({ type: "playlist:updated", playlistId: "p-1", deleted: false }) }));
        await settle();
        expect(fetches).not.toHaveBeenCalled();
        expect(shown()).toEqual(["b", "c"]);

        await act(async () => request("remove a").release());
        await settle();
        expect(fetches).toHaveBeenCalledTimes(1);
    });

    it("the first failing keeps the second on screen; the last one fetches the server's truth", async () => {
        void probe.remove("a");
        void probe.remove("b");
        await settle();

        await act(async () => request("remove a").fail());
        await settle();
        // Not undone yet: its snapshot would also undo the second edit. The failure is reported, and the second
        // edit's settling brings the server's truth.
        expect(shown(), "the failed edit's undo also wiped the edit still on its way").toEqual(["c"]);
        expect(fetches).not.toHaveBeenCalled();

        holdFetches = true;
        await act(async () => request("remove b").release());
        await settle();
        expect(fetches).toHaveBeenCalledTimes(1);
        expect(shown(), "an accepted edit was undone on screen while the server's truth was on its way").toEqual(["c"]);

        await act(async () => request("fetch").release());
        await settle();
        expect(shown()).toEqual(["a", "c"]);
    });

    it("a reconnect while an edit is on its way asks nothing for that playlist", async () => {
        void probe.remove("a");
        await settle();

        // The stream drops; the hook opens a new one after its backoff (1 s on the first retry) and says connected.
        await act(async () => {
            FakeEventSource.last!.onerror!();
            await new Promise((resolve) => setTimeout(resolve, 1_100));
        });
        await act(async () => FakeEventSource.last!.onmessage!({ data: JSON.stringify({ type: "connected" }) }));
        await settle();
        expect(fetches, "the reconnect fetched a playlist with an edit on its way").not.toHaveBeenCalled();
        expect(shown()).toEqual(["b", "c"]);

        await act(async () => request("remove a").release());
        await settle();
        expect(fetches).toHaveBeenCalledTimes(1);
    });

    it("a rename failing after a remove settled still fetches the server's truth", async () => {
        void probe.remove("a");
        void probe.rename("Renamed");
        await settle();

        await act(async () => request("remove a").release());
        await settle();
        expect(fetches, "the remove asked while the rename was on its way").not.toHaveBeenCalled();

        holdFetches = true;
        await act(async () => request("rename").fail());
        await settle();
        expect(fetches, "nobody fetched once the last edit failed").toHaveBeenCalledTimes(1);
        expect(shown(), "the accepted remove was undone on screen while the server's truth was on its way").toEqual(["b", "c"]);

        await act(async () => request("fetch").release());
        await settle();
        expect(shown()).toEqual(["b", "c"]);
    });

    it("two edits that both fail while offline leave the playlist as it was before either", async () => {
        void probe.remove("a");
        void probe.remove("b");
        await settle();
        offline = true;

        await act(async () => request("remove a").fail());
        await act(async () => request("remove b").fail());
        await settle();

        expect(shown(), "a failed edit is still shown").toEqual(["a", "b", "c"]);
    });

    it("a lone edit that fails is undone at once", async () => {
        void probe.remove("a");
        await settle();
        await act(async () => request("remove a").fail());
        await settle();
        expect(shown()).toEqual(["a", "b", "c"]);
    });
});
