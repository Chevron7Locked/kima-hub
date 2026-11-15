// The add itself owns the refresh of the playlist pages: whatever way an add ends (done, refused, failed or cut off after
// a partial write), the playlist and the playlists list are marked stale once. The dialog sends no second signal.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const addTracksToPlaylist = vi.fn();
vi.mock("@/lib/api", () => ({ api: { addTracksToPlaylist: (...a: unknown[]) => addTracksToPlaylist(...a) } }));

import { useAddToPlaylistMutation, queryKeys } from "@/hooks/useQueries";

let root: Root | null = null;
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
});

async function addOnce() {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    let add!: ReturnType<typeof useAddToPlaylistMutation>["mutateAsync"];
    function Probe() {
        add = useAddToPlaylistMutation().mutateAsync;
        return null;
    }
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
        root!.render(
            <QueryClientProvider client={client}>
                <Probe />
            </QueryClientProvider>,
        ),
    );
    const outcome = await act(async () => add({ playlistId: "pl-1", trackIds: ["a"] }).then(() => "added", () => "failed"));
    return { outcome, keys: invalidate.mock.calls.map(([filter]) => JSON.stringify(filter?.queryKey)) };
}

describe("useAddToPlaylistMutation refreshes the playlist pages", () => {
    it("once each, after an add that succeeded", async () => {
        addTracksToPlaylist.mockResolvedValue({ added: 1, duplicates: 0, rejected: [] });
        const { outcome, keys } = await addOnce();

        expect(outcome).toBe("added");
        expect(keys.filter((k) => k === JSON.stringify(queryKeys.playlists()))).toHaveLength(1);
        expect(keys.filter((k) => k === JSON.stringify(queryKeys.playlist("pl-1")))).toHaveLength(1);
    });

    it("once each, after an add that failed partway", async () => {
        addTracksToPlaylist.mockRejectedValue(new Error("cut off"));
        const { outcome, keys } = await addOnce();

        expect(outcome).toBe("failed");
        expect(keys.filter((k) => k === JSON.stringify(queryKeys.playlists()))).toHaveLength(1);
        expect(keys.filter((k) => k === JSON.stringify(queryKeys.playlist("pl-1")))).toHaveLength(1);
    });
});
