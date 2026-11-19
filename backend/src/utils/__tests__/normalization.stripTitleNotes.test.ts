/**
 * stripTitleNotes makes a title comparable to a release-group title: brackets and edition notes after a dash are
 * gone (the shared rule, stripEditionNote), a real subtitle stays.
 */
import { stripTitleNotes } from "../normalization";

describe("stripTitleNotes", () => {
    it.each([
        ["Discovery (Deluxe Edition)", "Discovery"],
        ["Discovery - Deluxe Edition", "Discovery"],
        ["Discovery - 2011 Remaster", "Discovery"],
        ["Discovery – Remastered", "Discovery"],
        ["Discovery [Explicit] - 2011", "Discovery"],
    ])("cuts the markers of %s", (title, expected) => {
        expect(stripTitleNotes(title)).toBe(expected);
    });

    it("keeps a subtitle that only begins like a marker", () => {
        expect(stripTitleNotes("Songs - Live and Let Die")).toBe("Songs - Live and Let Die");
    });
});
