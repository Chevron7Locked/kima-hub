/**
 * Making a playlist from a form: a retry of a create whose answer was lost carries the same key, so the server returns
 * the playlist the first try made; an edited name or visibility is a new create and gets a new key; a create that went
 * through is over, so the next one is a new playlist.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";

const createPlaylist = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { createPlaylist } }));

import { usePlaylistCreate } from "@/lib/playlist-create";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const probe = {} as { current: ReturnType<typeof usePlaylistCreate> };
function Probe() {
    const made = usePlaylistCreate();
    useEffect(() => {
        probe.current = made;
    });
    return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
    createPlaylist.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Probe />));
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

const keyOf = (call: number) => createPlaylist.mock.calls[call][2] as string;
const tryCreate = (name: string, isPublic?: boolean) => act(async () => probe.current.create(name, isPublic).catch(() => undefined));

describe("usePlaylistCreate", () => {
    it("sends a random key with the create, and a private playlist when none is asked for", async () => {
        createPlaylist.mockResolvedValue({ id: "p1" });
        await tryCreate("late night");
        expect(createPlaylist).toHaveBeenCalledWith("late night", false, expect.stringMatching(/^[0-9a-f]{32}$/));
    });

    it("returns what the server answered", async () => {
        createPlaylist.mockResolvedValue({ id: "p1" });
        await expect(probe.current.create("late night")).resolves.toEqual({ id: "p1" });
    });

    it("sends the same key on the retry of a create that failed", async () => {
        createPlaylist.mockRejectedValueOnce(new Error("timed out")).mockResolvedValueOnce({ id: "p1" });
        await tryCreate("late night");
        await tryCreate("late night");
        expect(keyOf(1)).toBe(keyOf(0));
    });

    it("sends a new key once the name was edited after the failed try", async () => {
        createPlaylist.mockRejectedValueOnce(new Error("timed out")).mockResolvedValueOnce({ id: "p1" });
        await tryCreate("late night");
        await tryCreate("early");
        expect(keyOf(1)).not.toBe(keyOf(0));
    });

    it("sends a new key once the visibility was flipped after the failed try", async () => {
        createPlaylist.mockRejectedValueOnce(new Error("timed out")).mockResolvedValueOnce({ id: "p1" });
        await tryCreate("late night", false);
        await tryCreate("late night", true);
        expect(keyOf(1)).not.toBe(keyOf(0));
    });

    it("sends a new key for the next create once one went through", async () => {
        createPlaylist.mockResolvedValue({ id: "p1" });
        await tryCreate("late night");
        await tryCreate("late night");
        expect(keyOf(1)).not.toBe(keyOf(0));
    });

    it("sends a new key after forget, whatever failed before", async () => {
        createPlaylist.mockRejectedValueOnce(new Error("timed out")).mockResolvedValueOnce({ id: "p1" });
        await tryCreate("late night");
        probe.current.forget();
        await tryCreate("late night");
        expect(keyOf(1)).not.toBe(keyOf(0));
    });

    it("keeps its key across renders", async () => {
        createPlaylist.mockRejectedValueOnce(new Error("timed out")).mockResolvedValueOnce({ id: "p1" });
        await tryCreate("late night");
        await act(async () => root.render(<Probe />));
        await tryCreate("late night");
        expect(keyOf(1)).toBe(keyOf(0));
    });
});
