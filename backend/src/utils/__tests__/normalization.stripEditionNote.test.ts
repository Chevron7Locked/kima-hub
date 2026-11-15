/**
 * stripEditionNote is the one rule for an edition note after a dash, shared by title and album matching, the MusicBrainz
 * release-group search, artist-name correction and the Soulseek search strings. The dash needs a space on each side, and
 * what follows the keyword may only be years and known note words, so a real subtitle is kept.
 */
import { stripEditionNote } from "../normalization";

describe("stripEditionNote", () => {
    it.each([
        ["Song - Remastered 2011", "Song"],
        ["Song - 2009 Remaster", "Song"],
        ["Song - Remastered Version", "Song"],
        ["Song - Deluxe Edition", "Song"],
        ["Song - 2015 Deluxe Edition 2015", "Song"],
        ["Song - Radio Edit", "Song"],
        ["Song - Single Version", "Song"],
        ["Song - Mono", "Song"],
        ["Song - Demo", "Song"],
        ["Song - Remastered and Expanded", "Song"],
        ["Song - Live 1985", "Song"],
        ["Song - Remastered 2011 (Mono)", "Song"],
    ])("cuts the note of %s", (text, expected) => {
        expect(stripEditionNote(text)).toBe(expected);
    });

    it.each([
        ["Song – Remastered 2011", "Song"],
        ["Song — Radio Edit", "Song"],
    ])("treats an en or em dash as a dash: %s", (text, expected) => {
        expect(stripEditionNote(text)).toBe(expected);
    });

    it("cuts a live note that names a place", () => {
        expect(stripEditionNote("Song - Live at Wembley")).toBe("Song");
        expect(stripEditionNote("Song - Live in Concert 1986")).toBe("Song");
        expect(stripEditionNote("Song - Live from the Apollo")).toBe("Song");
    });

    it("cuts a bare year", () => {
        expect(stripEditionNote("Song - 2011")).toBe("Song");
    });

    it("cuts several notes, last first", () => {
        expect(stripEditionNote("Song - Live - Remastered 2011")).toBe("Song");
    });

    it.each([
        ["Song - Live and Let Die"],
        ["Song - Live Forever"],
        ["Song - Remastered Beyond Recognition"],
        ["Song - Mix Tape Two"],
        ["Song - Stereotype"],
        ["Song - Versions of Me"],
        ["Song - Remixes"],
    ])("keeps the subtitle of %s", (text) => {
        expect(stripEditionNote(text)).toBe(text);
    });

    it.each([
        ["Jay-Z"],
        ["Song-Live"],
        ["Anti-Mix"],
        ["Song -Remastered"],
        ["Song- Remastered"],
        ["Blink-182"],
    ])("keeps %s, whose dash has no space on both sides", (text) => {
        expect(stripEditionNote(text)).toBe(text);
    });

    it("keeps a note that is not at the end", () => {
        expect(stripEditionNote("Song - Live and Other Stories")).toBe("Song - Live and Other Stories");
    });

    it("is not case sensitive", () => {
        expect(stripEditionNote("Song - REMASTERED 2011")).toBe("Song");
    });
});
