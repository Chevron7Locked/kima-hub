import { computeGenreTotals, shownAlbumGenres, shownSongGenres } from "../genreSql";

const artist = { name: "Jazz", normalizedName: "jazz", genres: ["rock", "_marker", "Jazz"] };

describe("shownAlbumGenres", () => {
    it("shows the album's own genres and ignores the artist's when it has any", () => {
        expect(shownAlbumGenres({ genres: ["soul"] }, artist)).toEqual(["soul"]);
    });

    it("shows a person's list in place of the enriched one", () => {
        expect(shownAlbumGenres({ genres: ["soul"], userGenres: ["funk"] }, artist)).toEqual(["funk"]);
    });

    it("falls back to the artist's genres when the album has none", () => {
        expect(shownAlbumGenres({ genres: null }, artist)).toEqual(["rock"]);
        expect(shownAlbumGenres({ genres: [] }, artist)).toEqual(["rock"]);
    });

    it("falls back to the artist when the album's only tags are markers or the artist's own name", () => {
        expect(shownAlbumGenres({ genres: ["_x", "jazz"] }, artist)).toEqual(["rock"]);
    });

    it("shows no genre when neither the album nor the artist has a usable one", () => {
        expect(shownAlbumGenres({ genres: null }, { name: "A", genres: ["_x"] })).toEqual([]);
    });
});

describe("shownSongGenres", () => {
    it("shows the song's own tags first, whatever the album shows", () => {
        expect(shownSongGenres(["funk", "soul"], { genres: ["blues"] }, artist)).toEqual(["funk", "soul"]);
    });

    it("falls back to what the album shows when the song has no tags", () => {
        expect(shownSongGenres(undefined, { genres: ["blues"] }, artist)).toEqual(["blues"]);
        expect(shownSongGenres([], { genres: null }, artist)).toEqual(["rock"]);
    });

    it("drops a marker, an empty tag and the artist's own name, and falls back when nothing is left", () => {
        expect(shownSongGenres(["_x", "", "jazz", "funk"], { genres: ["blues"] }, artist)).toEqual(["funk"]);
        expect(shownSongGenres(["_x", "Jazz"], { genres: ["blues"] }, artist)).toEqual(["blues"]);
    });
});

describe("computeGenreTotals with songs that carry tags of their own", () => {
    const band = { name: "The Band", normalizedName: "the band" };
    const albums = [
        { id: "a1", genres: ["rock"], artist: band, songs: 4 },
        { id: "a2", genres: ["jazz"], artist: band, songs: 2 },
    ];
    const byName = (totals: ReturnType<typeof computeGenreTotals>) =>
        Object.fromEntries(totals.map((g) => [g.name, [g.songs, g.albums]]));

    it("counts a song under its own tags instead of its album's, and an album once per genre it shows", () => {
        const totals = computeGenreTotals(albums, [
            { albumId: "a1", artist: band, tags: ["ska", "rock"] },
            { albumId: "a1", artist: band, tags: ["Ska"] },
        ]);
        // a1's two other songs keep the album's "rock"; one tagged song's own "rock" adds a third. Spellings tie, so the first by code unit names it.
        expect(byName(totals)).toEqual({ rock: [3, 1], Ska: [2, 0], jazz: [2, 1] });
    });

    it("counts a song once under spellings of one genre, and names the genre by its commonest spelling", () => {
        const totals = computeGenreTotals(albums, [
            { albumId: "a2", artist: band, tags: ["Hip-Hop", "hip hop"] },
            { albumId: "a2", artist: band, tags: ["Hip-Hop"] },
        ]);
        // Both of a2's songs show their own tags, so the album's jazz keeps its album and no songs.
        expect(byName(totals)).toEqual({ rock: [4, 1], jazz: [0, 1], "Hip-Hop": [2, 0] });
    });

    it("keeps a song whose only tags are no genre (a marker, the artist's name) under its album's genres", () => {
        const totals = computeGenreTotals(albums, [
            { albumId: "a1", artist: band, tags: ["_marker", "The Band"] },
        ]);
        expect(byName(totals)).toEqual({ rock: [4, 1], jazz: [2, 1] });
    });

    it("reads like the albums alone when no song has tags of its own", () => {
        expect(computeGenreTotals(albums, [])).toEqual(computeGenreTotals(albums));
    });

    it("lists a genre only songs carry, even when their album is not in the album list", () => {
        const totals = computeGenreTotals(albums, [{ albumId: "elsewhere", artist: band, tags: ["polka"] }]);
        expect(byName(totals).polka).toEqual([1, 0]);
    });
});
