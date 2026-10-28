/**
 * getMergedGenres (utils/metadataOverrides.ts): the genres the functional surfaces (mixes,
 * discovery, genre filters, the genre list) read for an entity. A person's non-empty genre list
 * REPLACES the enriched one — the artist editor saves the whole edited list, so a genre the
 * person removed must not come back from the enriched column. Anything that is not a list of
 * strings (null, a bare string, an object, JSON null) is no list, and no list means the enriched
 * genres are read.
 */

import { getMergedGenres } from "../metadataOverrides";

describe("getMergedGenres — a person's genres replace the enriched ones", () => {
    it("returns the person's list, deduplicated in the person's order, when it is non-empty", () => {
        expect(getMergedGenres({ genres: ["jazz", "blues"], userGenres: ["rock", "rock", "punk"] }))
            .toEqual(["rock", "punk"]);
    });

    it("drops the enriched genres the person's list replaced", () => {
        // The editor saved ["rock"] after the person removed "jazz": "jazz" must be gone.
        const merged = getMergedGenres({ genres: ["jazz"], userGenres: ["rock"] });
        expect(merged).toEqual(["rock"]);
        expect(merged).not.toContain("jazz");
    });

    it("falls back to the enriched genres when the person's list is empty", () => {
        expect(getMergedGenres({ genres: ["jazz", "blues"], userGenres: [] })).toEqual(["jazz", "blues"]);
        expect(getMergedGenres({ genres: ["jazz"], userGenres: null })).toEqual(["jazz"]);
        expect(getMergedGenres({ genres: ["jazz"] })).toEqual(["jazz"]);
        // A JSON array that parses to empty is an empty list, not a non-list.
        expect(getMergedGenres({ genres: ["jazz"], userGenres: "[]" })).toEqual(["jazz"]);
    });

    it("counts a non-list person value as empty, reading the enriched genres", () => {
        for (const notAList of ["rock", "not json", { rock: true }, JSON.parse("null"), 42]) {
            expect(getMergedGenres({ genres: ["jazz"], userGenres: notAList })).toEqual(["jazz"]);
        }
    });

    it("keeps the enriched genres as read when neither column holds a list", () => {
        expect(getMergedGenres({ genres: ["jazz"], userGenres: "rock" })).toEqual(["jazz"]);
        expect(getMergedGenres({ genres: "jazz", userGenres: "rock" })).toEqual([]);
        expect(getMergedGenres({})).toEqual([]);
    });
});
