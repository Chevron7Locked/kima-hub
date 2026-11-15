import { describe, it, expect } from "vitest";
import { playablePlaylist, playingItemId, type PlaylistEntry } from "@/lib/playlist-track";

// A playlist keeps listing a song that stopped playing, marked unavailable; playback skips it.
const entry = (id: string, unavailable = false): PlaylistEntry => ({
    id: `item-${id}`,
    unavailable,
    track: { id, title: id, duration: 100, album: { title: "a", artist: { name: "b" } } },
});
const ids = (queue: ReturnType<typeof playablePlaylist>) => queue?.tracks.map((t) => t.id);

describe("playablePlaylist", () => {
    it("queues the playable songs only, in the order listed", () => {
        const queue = playablePlaylist([entry("a"), entry("b", true), entry("c"), entry("d", true), entry("e")]);
        expect(ids(queue)).toEqual(["a", "c", "e"]);
        expect(queue?.start).toBe(0);
    });

    it("starts at the song asked for, by its place among the playable ones", () => {
        const list = [entry("a"), entry("b", true), entry("c"), entry("d")];
        expect(playablePlaylist(list, 2)).toMatchObject({ start: 1 });
        expect(ids(playablePlaylist(list, 2))?.[1]).toBe("c");
        expect(playablePlaylist(list, 3)).toMatchObject({ start: 2 });
    });

    it("plays nothing when the song asked for is unavailable", () => {
        expect(playablePlaylist([entry("a"), entry("b", true)], 1)).toBeNull();
    });

    it("plays nothing when no song is playable, or the list is empty", () => {
        expect(playablePlaylist([entry("a", true)])).toBeNull();
        expect(playablePlaylist([])).toBeNull();
    });

    it("treats a song with no mark as playable", () => {
        const plain: PlaylistEntry = { id: "i", track: { id: "x", title: "x", duration: 1 } };
        expect(ids(playablePlaylist([plain]))).toEqual(["x"]);
    });
});

describe("playablePlaylist keys", () => {
    it("keys each queued song by its item's id, so a repeated song has two keys", () => {
        const first = entry("a");
        const second = { ...entry("a"), id: "item-a-again" };
        const queue = playablePlaylist([first, entry("b"), second]);
        expect(queue?.tracks.map((t) => t.queueKey)).toEqual(["item-a", "item-b", "item-a-again"]);
    });
});

describe("playingItemId", () => {
    const list = [
        { id: "i1", track: { id: "A", title: "A", duration: 1 } },
        { id: "i2", track: { id: "B", title: "B", duration: 1 } },
        { id: "i3", track: { id: "A", title: "A", duration: 1 } },
    ];

    it("is the item whose id is the playing entry's key, so the second A is not the first", () => {
        expect(playingItemId(list, "i3", "A")).toBe("i3");
        expect(playingItemId(list, "i1", "A")).toBe("i1");
    });

    it("falls back to the song's first row when the playing entry did not come from this list", () => {
        expect(playingItemId(list, "q-xyz-1", "A")).toBe("i1");
        expect(playingItemId(list, null, "B")).toBe("i2");
    });

    it("is null when nothing from the list is playing", () => {
        expect(playingItemId(list, "q-xyz-1", "C")).toBeNull();
        expect(playingItemId(list, null, undefined)).toBeNull();
        expect(playingItemId(undefined, "i1", "A")).toBeNull();
    });

    it("never marks an unavailable item", () => {
        const gone = [{ ...list[0], unavailable: true }, list[2]];
        expect(playingItemId(gone, "i3", "A")).toBe("i3");
        expect(playingItemId(gone, "q-xyz-1", "A")).toBe("i3");
    });

    it("marks no other copy when the playing item's own entry has left the list", () => {
        const removed = [list[1], list[2]];
        expect(playingItemId(removed, "i1", "A")).toBeNull();
        const unavailable = [{ ...list[0], unavailable: true }, list[2]];
        expect(playingItemId(unavailable, "i1", "A")).toBeNull();
    });
});
