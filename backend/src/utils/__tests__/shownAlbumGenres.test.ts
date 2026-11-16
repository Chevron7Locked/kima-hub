import { shownAlbumGenres, shownSongGenres } from "../genreSql";

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
