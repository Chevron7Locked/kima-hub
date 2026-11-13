import { describe, it, expect } from "vitest";
import { playablePlaylist, type PlaylistEntry } from "@/lib/playlist-track";

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
