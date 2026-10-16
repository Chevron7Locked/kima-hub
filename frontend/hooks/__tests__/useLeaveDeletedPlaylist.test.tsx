/**
 * A playlist's page leaves for the playlist list when that playlist is gone: deleted here or on another device (the
 * `playlist-deleted` signal), or answered "not found" by the server after the page had shown it (deleted while this
 * device was not listening). It leaves once, and the playlist leaves the cache only once the page has closed: removed
 * while the page reads it, it would be asked for again. A link to a playlist that never loaded stays put, to say so.
 * Real QueryClient; the router is a stand-in that records where the page went.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

import { useLeaveDeletedPlaylist } from "@/hooks/useLeaveDeletedPlaylist";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let client: QueryClient;
let root: Root;
let open = false;
/** What the server holds: a playlist id that is not here answers 404, as GET /playlists/:id does. */
let onServer: Set<string>;
const fetches = vi.fn(async (id: string) => {
    if (!onServer.has(id)) throw Object.assign(new Error("Playlist not found"), { status: 404 });
    return { id };
});

/** The playlist page's use of the hook, as app/playlist/[id]/page.tsx wires it. */
function PlaylistPage({ id }: { id: string }) {
    const query = useQuery({ queryKey: ["playlist", id], queryFn: () => fetches(id) });
    useLeaveDeletedPlaylist(id, query);
    return null;
}

const show = async (id: string) => {
    open = true;
    await act(async () =>
        root.render(
            <QueryClientProvider client={client}>
                <PlaylistPage id={id} />
            </QueryClientProvider>,
        ),
    );
    await settle();
};

const close = () => {
    open = false;
    act(() => root.unmount());
};

/** The query library hands a finished request to the page on a timer: let that run, and the page react. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const deleted = (playlistId: string) =>
    act(async () => {
        window.dispatchEvent(new CustomEvent("playlist-deleted", { detail: { playlistId } }));
    });

beforeEach(() => {
    replace.mockClear();
    fetches.mockClear();
    onServer = new Set(["p-1", "p-2"]);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    root = createRoot(document.createElement("div"));
});

afterEach(() => {
    if (open) close();
});

describe("a playlist page whose playlist is deleted", () => {
    it("moves to the playlist list, and drops the playlist only once the page has closed", async () => {
        await show("p-1");
        await deleted("p-1");
        // The page renders again before it closes (its data arriving, a parent updating); the router it gets back
        // is a new object each time, as the stand-in's is.
        await show("p-1");

        expect(replace).toHaveBeenCalledWith("/playlists");
        expect(client.getQueryData(["playlist", "p-1"])).toEqual({ id: "p-1" });
        expect(fetches, "the deleted playlist was asked for again").toHaveBeenCalledTimes(1);

        close();
        expect(client.getQueryData(["playlist", "p-1"])).toBeUndefined();
    });

    it("leaves once when told twice (the deleting device hears its own delete back)", async () => {
        await show("p-1");
        await deleted("p-1");
        await deleted("p-1");

        expect(replace).toHaveBeenCalledTimes(1);
    });

    it("ignores another playlist being deleted, and keeps its own in the cache", async () => {
        await show("p-1");
        await deleted("p-2");

        expect(replace).not.toHaveBeenCalled();
        close();
        expect(client.getQueryData(["playlist", "p-1"])).toEqual({ id: "p-1" });
    });

    it("drops only the playlist that went, when the page moves on to another", async () => {
        await show("p-1");
        await deleted("p-1");
        await show("p-2");

        expect(client.getQueryData(["playlist", "p-1"])).toBeUndefined();
        expect(client.getQueryData(["playlist", "p-2"])).toEqual({ id: "p-2" });
        close();
        expect(client.getQueryData(["playlist", "p-2"]), "p-2 was never reported gone").toEqual({ id: "p-2" });
    });
});

describe("a playlist page whose playlist the server no longer has", () => {
    it("leaves when a refresh answers not found (deleted while this device was not listening)", async () => {
        await show("p-1");
        onServer.delete("p-1");
        await act(async () => client.invalidateQueries({ queryKey: ["playlist", "p-1"] }));
        await settle();

        expect(replace).toHaveBeenCalledWith("/playlists");
        close();
        expect(client.getQueryData(["playlist", "p-1"])).toBeUndefined();
    });

    it("stays on a link to a playlist that never loaded, so the page can say it was not found", async () => {
        onServer.delete("p-1");
        await show("p-1");

        expect(fetches).toHaveBeenCalledTimes(1);
        expect(replace).not.toHaveBeenCalled();
    });
});
