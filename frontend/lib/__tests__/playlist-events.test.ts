import { it, expect, vi } from "vitest";
import { announcePlaylistEvent } from "../playlist-events";
import { newRequestKey } from "../request-key";

it("announces each playlist event on the window with its detail", () => {
    const heard = vi.fn();
    for (const name of ["playlist-created", "playlist-deleted"]) window.addEventListener(name, heard);

    announcePlaylistEvent("playlist-created", { id: "p1" });
    announcePlaylistEvent("playlist-created");
    announcePlaylistEvent("playlist-deleted", { playlistId: "p3" });

    const seen = heard.mock.calls.map(([e]) => [(e as CustomEvent).type, (e as CustomEvent).detail]);
    expect(seen).toEqual([
        ["playlist-created", { id: "p1" }],
        ["playlist-created", null],
        ["playlist-deleted", { playlistId: "p3" }],
    ]);
    for (const name of ["playlist-created", "playlist-deleted"]) window.removeEventListener(name, heard);
});

it("makes request keys the server accepts, that differ each time, without crypto.randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256)) });
    const keys = new Set(Array.from({ length: 50 }, newRequestKey));

    expect(keys.size).toBe(50);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{32}$/);
    vi.unstubAllGlobals();
});
