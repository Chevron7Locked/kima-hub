import { describe, expect, it } from "vitest";
import { toPlaybackTrack, toPlaybackTracks } from "../playback-track";

/**
 * The queue mapper is the only place rows become player tracks. These fixtures
 * mirror the real API shapes at the door (nested album for library/album/playlist
 * rows, flat strings for discover, flat+nested mix for search, flat with strings
 * for radio and stats). If a field the player uses goes missing here, every
 * surface loses it at once — so it is tested here, once, for every shape.
 */

describe("toPlaybackTrack", () => {
    it("carries loudness from a nested library row", () => {
        const t = toPlaybackTrack({
            id: "t1",
            title: "Song",
            duration: 200,
            loudness: -9.5,
            artist: { id: "a1", name: "Artist" },
            album: { id: "al1", title: "Album", coverArt: "/c.jpg" },
        });
        expect(t.loudness).toBe(-9.5);
        expect(t.artist.name).toBe("Artist");
        expect(t.album.id).toBe("al1");
    });

    it("carries loudness through the flat discover shape", () => {
        const t = toPlaybackTrack({
            id: "t2",
            title: "Song",
            duration: 180,
            loudness: -13.2,
            artist: "Solo Pianist",
            albumId: "al2",
            album: "Piano Album",
            coverUrl: "/c2.jpg",
        });
        expect(t.loudness).toBe(-13.2);
        expect(t.artist.name).toBe("Solo Pianist");
        expect(t.album.id).toBe("al2");
        expect(t.album.coverArt).toBe("/c2.jpg");
    });

    it("carries loudness through the flat radio/stats shape", () => {
        const t = toPlaybackTrack({
            id: "t3",
            title: "Radio Song",
            duration: 150,
            loudness: -7.7,
            artist: { id: "a3", name: "Radio Artist" },
            albumId: "al3",
            albumTitle: "Radio Album",
            coverUrl: null,
        });
        expect(t.loudness).toBe(-7.7);
        expect(t.album.coverArt).toBeUndefined();
    });

    it("keeps an unmeasured track unmeasured instead of inventing a number", () => {
        const t = toPlaybackTrack({ id: "t4", title: "No gain", duration: 100, loudness: null });
        expect(t.loudness).toBeNull();
    });

    it("falls back like the surfaces did when refs are missing", () => {
        const t = toPlaybackTrack({ id: "t5", title: "Loose", duration: 90 });
        expect(t.artist).toEqual({ id: undefined, name: "Unknown Artist" });
        // The player's album id is a required string; "" is the sentinel the old whitelists used.
        expect(t.album).toEqual({ id: "", title: "Unknown Album", coverArt: undefined });
    });

    it("keeps a missing album without inventing an id", () => {
        const t = toPlaybackTrack({ id: "t6", title: "Mix", duration: 60, album: null });
        expect(t.album.id).toBe("");
        expect(t.album.title).toBe("Unknown Album");
    });

    it("maps a batch", () => {
        const ts = toPlaybackTracks([
            { id: "a", title: "A", duration: 1, loudness: -1 },
            { id: "b", title: "B", duration: 2, loudness: -2 },
        ]);
        expect(ts.map((t) => t.loudness)).toEqual([-1, -2]);
    });
});
