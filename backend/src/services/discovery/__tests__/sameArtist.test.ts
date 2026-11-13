/**
 * The one rule for whether two Discover records name the same artist: by MusicBrainz id when both have a real one, by
 * name only when either's id is missing or a `temp-` placeholder.
 */
import { hasRealArtistId, sameArtist } from "../discoverEvidence";

const A = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const B = "9c9f1380-2016-4671-bd33-fe2d94d1ed44";

describe("hasRealArtistId", () => {
    it.each([[null], [undefined], [""], ["temp-1793617784650-0.5"]])("says no for %p", (id) => {
        expect(hasRealArtistId(id)).toBe(false);
    });

    it("says yes for a MusicBrainz id", () => {
        expect(hasRealArtistId(A)).toBe(true);
    });
});

describe("sameArtist", () => {
    it("matches two real ids that are equal, whatever the names", () => {
        expect(sameArtist({ artistMbid: A, artistName: "Ed O'Brien" }, { artistMbid: A, artistName: "EOB" })).toBe(true);
    });

    it("does not match two different real ids, even under the same name", () => {
        expect(sameArtist({ artistMbid: A, artistName: "Interpol" }, { artistMbid: B, artistName: "Interpol" })).toBe(false);
    });

    it.each([[null], [undefined], ["temp-1"]])("matches by name when one side's id is %p", (id) => {
        expect(sameArtist({ artistMbid: A, artistName: "Ed O’Brien" }, { artistMbid: id, artistName: "ed o'brien" })).toBe(true);
        expect(sameArtist({ artistMbid: id, artistName: "ed o'brien" }, { artistMbid: A, artistName: "Ed O’Brien" })).toBe(true);
        expect(sameArtist({ artistMbid: A, artistName: "Ed O'Brien" }, { artistMbid: id, artistName: "Someone Else" })).toBe(false);
    });

    it("matches by name when both ids are missing", () => {
        expect(sameArtist({ artistMbid: null, artistName: "Interpol" }, { artistMbid: "temp-2", artistName: "INTERPOL" })).toBe(true);
    });

    it("does not match by name when a name is missing", () => {
        expect(sameArtist({ artistMbid: null, artistName: null }, { artistMbid: null, artistName: null })).toBe(false);
        expect(sameArtist({ artistMbid: null }, { artistMbid: null, artistName: "Interpol" })).toBe(false);
    });
});
