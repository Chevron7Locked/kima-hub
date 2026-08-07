/**
 * Artist identity.
 *
 * The regression these lock down: `extractPrimaryArtist` split artist tags on
 * " & ", " and ", " with " and ", " to guess a "primary" artist, and truncated
 * real band names doing it. Executed against the shipped code it produced
 * "Dance With the Dead" -> "Dance", "Nick Cave & The Bad Seeds" -> "Nick Cave",
 * "Florence and the Machine" -> "Florence". Separately, "deadmau5" and
 * "dead mau5" resolved to two different artist rows because the dedupe pass
 * keyed its candidate lookup on the un-collapsed name and the fuzzy backstop
 * scored 94 against a threshold of 95.
 *
 * Every case below fails against that implementation.
 */

import {
    artistIdentityKey,
    artistSortName,
    normalizeArtistName,
    parseCredit,
} from "../artistIdentity";

describe("parseCredit — band names must survive intact", () => {
    // The exact inputs the old heuristic truncated.
    it.each([
        "Dance With the Dead",
        "Dancing With The Dead",
        "Nick Cave & The Bad Seeds",
        "Bob Marley & The Wailers",
        "Tom Petty and the Heartbreakers",
        "Echo & the Bunnymen",
        "Derek and the Dominos",
        "Florence and the Machine",
        "Earth, Wind & Fire",
        "Of Mice & Men",
        "Simon & Garfunkel",
        "Sleater-Kinney",
        "Emerson, Lake & Palmer",
        "Crosby, Stills, Nash & Young",
    ])("keeps %s whole", (name) => {
        expect(parseCredit(name).primary).toBe(name);
        expect(parseCredit(name).featured).toEqual([]);
    });

    it("does not split on ' x ' either", () => {
        expect(parseCredit("Cheat Codes x Kris Kross").primary).toBe(
            "Cheat Codes x Kris Kross"
        );
    });
});

describe("parseCredit — real multi-artist signals", () => {
    it("splits on the ID3v2.4 null separator", () => {
        const r = parseCredit("Justice\0Tame Impala");
        expect(r.primary).toBe("Justice");
        expect(r.featured).toEqual(["Tame Impala"]);
    });

    it("splits on semicolons", () => {
        const r = parseCredit("Justice;Tame Impala");
        expect(r.primary).toBe("Justice");
        expect(r.featured).toEqual(["Tame Impala"]);
    });

    it("prefers a structured multi-value tag over the joined string", () => {
        const r = parseCredit("ignored", ["Röyksopp", "Robyn"]);
        expect(r.primary).toBe("Röyksopp");
        expect(r.featured).toEqual(["Robyn"]);
    });

    it("treats feat./ft./featuring as annotation, keeping the primary whole", () => {
        for (const marker of ["feat.", "ft.", "featuring", "feat", "ft"]) {
            const r = parseCredit(`Dance With the Dead ${marker} Gunship`);
            expect(r.primary).toBe("Dance With the Dead");
            expect(r.featured).toEqual(["Gunship"]);
        }
    });

    it("canonicalises various-artists spellings", () => {
        for (const va of ["VA", "V.A.", "Various", "Various Artists"]) {
            expect(parseCredit(va).primary).toBe("Various Artists");
        }
    });

    it("returns empty rather than throwing on junk input", () => {
        expect(parseCredit("").primary).toBe("");
        expect(parseCredit(null).primary).toBe("");
        expect(parseCredit(undefined).featured).toEqual([]);
    });
});

describe("artistIdentityKey — the deadmau5 case", () => {
    it("collapses spacing so the DB can reject the duplicate", () => {
        const forms = ["deadmau5", "Dead Mau5", "dead mau5", "DEADMAU5"];
        const keys = forms.map(artistIdentityKey);
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toBe("deadmau5");
    });

    it.each([
        [["Sigur Rós", "Sigur Ros", "sigurros"], "sigurros"],
        [["AC/DC", "AC-DC", "ACDC", "ac dc"], "acdc"],
        [["Björk", "Bjork"], "bjork"],
        [["Mötley Crüe", "Motley Crue"], "motleycrue"],
        [["Of Mice & Men", "Of Mice and Men"], "ofmiceandmen"],
    ])("unifies %j", (forms, expected) => {
        const keys = (forms as string[]).map(artistIdentityKey);
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toBe(expected);
    });

    it("keeps genuinely different artists apart", () => {
        expect(artistIdentityKey("Dance With the Dead")).not.toBe(
            artistIdentityKey("Dance")
        );
        expect(artistIdentityKey("The Weeknd")).not.toBe(
            artistIdentityKey("The Weekend")
        );
        expect(artistIdentityKey("Marilyn Manson")).not.toBe(
            artistIdentityKey("Charles Manson")
        );
    });

    it("survives non-Latin scripts instead of collapsing them to empty", () => {
        expect(artistIdentityKey("宇多田ヒカル")).toBe("宇多田ヒカル");
        expect(artistIdentityKey("Кино")).toBe("кино");
    });
});

describe("artistSortName", () => {
    it.each([
        ["The Beatles", "beatles"],
        ["A Perfect Circle", "perfect circle"],
        ["An Horse", "horse"],
        ["Los Campesinos!", "campesinos!"],
        ["Die Antwoord", "antwoord"],
        ["Björk", "bjork"],
        ["Sigur Rós", "sigur ros"],
    ])("%s sorts under %s", (input, expected) => {
        expect(artistSortName(input)).toBe(expected);
    });

    it("does not strip an article that is the entire name", () => {
        expect(artistSortName("The The")).toBe("the");
    });

    it("does not strip a leading word that merely starts with an article", () => {
        expect(artistSortName("Theatre of Tragedy")).toBe("theatre of tragedy");
        expect(artistSortName("Andrew Bird")).toBe("andrew bird");
    });

    // A reviewer read the alternation in PG_LEADING_ARTICLE -- "the|a|an|..."
    // -- and reported that "a" preceding "an" must break "An Horse", since
    // regex alternation prefers the earlier branch. It does prefer it, but the
    // branch alone is not a match: the pattern demands whitespace after the
    // article, "An Horse" offers "n", so the engine backtracks into "an" and
    // succeeds. The behaviour is correct and the reasoning against it is
    // plausible, which is exactly why it is pinned here rather than argued
    // about. Reordering the array to put "an" first must keep these passing.
    it.each([
        ["An Horse", "horse"],
        ["An Emotional Fish", "emotional fish"],
        ["A Band", "band"],
        ["A Perfect Circle", "perfect circle"],
        ["Ash", "ash"],
        ["Anne Clark", "anne clark"],
        ["Association", "association"],
    ])("strips the article in %s only when a space follows it", (input, expected) => {
        expect(artistSortName(input)).toBe(expected);
    });

    // The six articles the parity fixture does not cover. These pin the TS
    // side only -- see the note on LEADING_ARTICLES about the SQL twin being
    // unguarded for exactly these.
    it.each([
        ["La Roux", "roux"],
        ["Le Tigre", "tigre"],
        ["Les Rita Mitsouko", "rita mitsouko"],
        ["Las Ketchup", "ketchup"],
        ["Der Weg einer Freiheit", "weg einer freiheit"],
        ["Das Racist", "racist"],
    ])("strips the non-English article in %s", (input, expected) => {
        expect(artistSortName(input)).toBe(expected);
    });
});

describe("normalizeArtistName", () => {
    it("keeps word boundaries that identityKey removes", () => {
        expect(normalizeArtistName("Dead Mau5")).toBe("dead mau5");
        expect(normalizeArtistName("deadmau5")).toBe("deadmau5");
        expect(normalizeArtistName("Dead Mau5")).not.toBe(
            normalizeArtistName("deadmau5")
        );
    });

    it("folds ampersands and accents", () => {
        expect(normalizeArtistName("Of Mice & Men")).toBe("of mice and men");
        expect(normalizeArtistName("Ólafur Arnalds")).toBe("olafur arnalds");
    });
});
