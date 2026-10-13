/**
 * The reverse-order toggle flips the cached playlist in place and persists
 * through PATCH /playlists/:id; a failed persist rolls the cache back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const updatePlaylistOrder = vi.fn();
vi.mock("@/lib/api", () => ({
    api: { updatePlaylistOrder: (...args: unknown[]) => updatePlaylistOrder(...args) },
}));

import { useSetPlaylistReverseMutation } from "@/hooks/useQueries";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PLAYLIST_ID = "pl-reverse";
const track = (id: string) => ({ id, track: { id } });

let client: QueryClient;
let root: Root;
let container: HTMLDivElement;
const probe = {} as {
    mutate: ReturnType<typeof useSetPlaylistReverseMutation>["mutateAsync"];
};

function Probe() {
    const { mutateAsync } = useSetPlaylistReverseMutation();
    useEffect(() => {
        probe.mutate = mutateAsync;
    });
    return null;
}

function seed() {
    client.setQueryData(["playlist", PLAYLIST_ID], {
        reverseOrder: false,
        items: [track("a"), track("b"), track("c")],
        mergedItems: [track("a"), track("b"), track("c")],
    });
}

function cached() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return client.getQueryData(["playlist", PLAYLIST_ID]) as any;
}

async function render() {
    await act(async () => {
        root.render(
            <QueryClientProvider client={client}>
                <Probe />
            </QueryClientProvider>
        );
    });
}

beforeEach(() => {
    container = document.createElement("div");
    root = createRoot(container);
    client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    updatePlaylistOrder.mockReset();
});

afterEach(() => {
    act(() => root.unmount());
});

describe("useSetPlaylistReverseMutation", () => {
    it("flips the cached order optimistically and patches the flag", async () => {
        updatePlaylistOrder.mockResolvedValue({});
        seed();
        await render();

        await act(async () => {
            await probe.mutate({ playlistId: PLAYLIST_ID, reverseOrder: true });
        });

        expect(updatePlaylistOrder).toHaveBeenCalledWith(PLAYLIST_ID, true);
        expect(cached().reverseOrder).toBe(true);
        expect(cached().items.map((t: { id: string }) => t.id)).toEqual(["c", "b", "a"]);
        expect(cached().mergedItems.map((t: { id: string }) => t.id)).toEqual(["c", "b", "a"]);
    });

    it("rolls the cache back when the persist fails", async () => {
        updatePlaylistOrder.mockRejectedValueOnce(new Error("network gone"));
        seed();
        await render();

        await act(async () => {
            await expect(
                probe.mutate({ playlistId: PLAYLIST_ID, reverseOrder: true })
            ).rejects.toThrow("network gone");
        });

        expect(cached().reverseOrder).toBe(false);
        expect(cached().items.map((t: { id: string }) => t.id)).toEqual(["a", "b", "c"]);
        expect(cached().mergedItems.map((t: { id: string }) => t.id)).toEqual(["a", "b", "c"]);
    });

    it("persists the flag off again through the same call", async () => {
        updatePlaylistOrder.mockResolvedValue({});
        seed();
        client.setQueryData(["playlist", PLAYLIST_ID], {
            ...cached(),
            reverseOrder: true,
            items: [track("c"), track("b"), track("a")],
            mergedItems: [track("c"), track("b"), track("a")],
        });
        await render();

        await act(async () => {
            await probe.mutate({ playlistId: PLAYLIST_ID, reverseOrder: false });
        });

        expect(updatePlaylistOrder).toHaveBeenCalledWith(PLAYLIST_ID, false);
        expect(cached().reverseOrder).toBe(false);
        expect(cached().items.map((t: { id: string }) => t.id)).toEqual(["a", "b", "c"]);
    });
});
