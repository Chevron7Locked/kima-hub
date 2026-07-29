/**
 * Album identity.
 *
 * Regressions locked down here:
 *  - Album lookup matched `title` raw, so "Abbey Road", "abbey road" and
 *    "Abbey Road (2019 Remaster)" became three rows under one artist. Album
 *    models a MusicBrainz RELEASE GROUP; those are three releases of ONE group.
 *  - A cross-artist fallback matched title+year across EVERY artist, guarded
 *    only against the literal strings "Unknown Album"/"Unknown", so one
 *    artist's 1995 "Greatest Hits" absorbed another's.
 */

import { albumIdentityKey, isGenericAlbumTitle } from "../albumIdentity";

describe("albumIdentityKey — editions collapse to one release group", () => {
    it("unifies the pressings of one album", () => {
        const forms = [
            "Abbey Road",
            "abbey road",
            "ABBEY ROAD",
            "Abbey Road (2019 Remaster)",
            "Abbey Road [Remastered]",
            "Abbey Road (Deluxe Edition)",
            "Abbey Road (Super Deluxe)",
        ];
        const keys = forms.map(albumIdentityKey);
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toBe("abbeyroad");
    });

    it.each([
        ["Nocturnal (Deluxe)", "nocturnal"],
        ["In A Time Lapse (Deluxe Edition)", "inatimelapse"],
        ["Dark Side of the Moon [Remastered]", "darksideofthemoon"],
        ["4x4=12", "4x412"],
        ["Sigur Rós - Ágætis Byrjun", "sigurrosagaetisbyrjun"],
        ["Mötley Crüe", "motleycrue"],
    ])("%s -> %s", (title, expected) => {
        expect(albumIdentityKey(title)).toBe(expected);
    });

    it("keeps genuinely different albums apart", () => {
        expect(albumIdentityKey("Leather Teeth")).not.toBe(
            albumIdentityKey("Leather Temple")
        );
        expect(albumIdentityKey("Abbey Road")).not.toBe(
            albumIdentityKey("Abbey Road Sessions")
        );
    });

    it("folds ligatures the same way Postgres unaccent() does", () => {
        // The SQL backfill and this function must agree, or a backfilled key is
        // unreachable at scan time and the duplicate comes straight back.
        expect(albumIdentityKey("Ágætis Byrjun")).toBe("agaetisbyrjun");
        expect(albumIdentityKey("Trøndelag")).toBe("trondelag");
        expect(albumIdentityKey("Straße")).toBe("strasse");
    });

    it("collapses a punctuation-only title to empty so the caller can fall back", () => {
        expect(albumIdentityKey("( )")).toBe("");
        expect(albumIdentityKey("...")).toBe("");
    });

    it("survives non-Latin titles", () => {
        expect(albumIdentityKey("初恋")).toBe("初恋");
    });

    it("handles null/undefined without throwing", () => {
        expect(albumIdentityKey(null)).toBe("");
        expect(albumIdentityKey(undefined)).toBe("");
    });
});

describe("isGenericAlbumTitle — gates cross-artist matching", () => {
    it.each([
        "Greatest Hits",
        "greatest hits",
        "The Greatest Hits",
        "Best Of",
        "Unknown Album",
        "Unknown",
        "Untitled",
        "Live",
        "Singles",
        "( )",
        "",
    ])("%s is too generic to match across artists", (title) => {
        expect(isGenericAlbumTitle(title)).toBe(true);
    });

    it("catches a generic title wearing an edition suffix", () => {
        expect(isGenericAlbumTitle("Greatest Hits (Deluxe Edition)")).toBe(true);
        expect(isGenericAlbumTitle("The Best Of [Remastered]")).toBe(true);
    });

    it.each([
        "Abbey Road",
        "Leather Teeth",
        "Ágætis Byrjun",
        "4x4=12",
    ])("%s is specific enough", (title) => {
        expect(isGenericAlbumTitle(title)).toBe(false);
    });

    it("treats null as generic rather than throwing", () => {
        expect(isGenericAlbumTitle(null)).toBe(true);
    });
});
