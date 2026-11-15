/**
 * stripTrackSuffix cuts an edition note after a dash ("Song - Remastered 2011") and nothing else. An edition note is a
 * whole word: a title that merely begins like one ("Stereotype", "Singles Going Steady") keeps it. A plural is not the
 * word ("Singles" begins with "single"), so "- Remixes" is kept too; only "remaster" and "remastered" are both words.
 */
import { stripTrackSuffix } from "../normalization";

describe("stripTrackSuffix after a dash", () => {
    it.each([
        ["Song - Remastered 2011", "Song"],
        ["Song - 2009 Remaster", "Song"],
        ["Song - Radio Edit", "Song"],
        ["Song - Live", "Song"],
        ["Song - Live at Wembley", "Song"],
        ["Song - Mono", "Song"],
        ["Song - Single Version", "Song"],
        ["Song - Deluxe Edition", "Song"],
        ["Song - Bonus Track", "Song"],
        ["Song - Acoustic", "Song"],
    ])("cuts the edition note of %s", (title, expected) => {
        expect(stripTrackSuffix(title)).toBe(expected);
    });

    it.each([
        ["Song - Stereotype", "Song - Stereotype"],
        ["Song - Singles Going Steady", "Song - Singles Going Steady"],
        ["Song - Livewire", "Song - Livewire"],
        ["Song - Monologue", "Song - Monologue"],
        ["Song - Mixtape", "Song - Mixtape"],
        ["Song - Versions of Me", "Song - Versions of Me"],
        ["Song - Remixes", "Song - Remixes"],
    ])("keeps %s, whose word only begins like an edition note", (title, expected) => {
        expect(stripTrackSuffix(title)).toBe(expected);
    });
});
