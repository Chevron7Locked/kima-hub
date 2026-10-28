import { normalizeTrackTitleForSearch, prepareArtistForSearch, titleFileScore, titleMatchKey } from "../soulseek-search-strategies";

describe("normalizeTrackTitleForSearch - Classical Music", () => {
    it("should strip movement numbers from classical music titles", () => {
        const input = "I. Allegro con brio";
        const result = normalizeTrackTitleForSearch(input, "aggressive");
        expect(result).not.toContain("I.");
        expect(result).toContain("Allegro con brio");
    });

    it("should strip opus and catalog numbers", () => {
        const input = "Piano Concerto No. 21 in C Major, K. 467: II. Andante";
        const result = normalizeTrackTitleForSearch(input, "aggressive");
        expect(result).not.toContain("K. 467");
        expect(result).not.toContain("in C Major");
        expect(result).toContain("Piano Concerto");
        expect(result).toContain("Andante");
    });

    it("should strip featuring artists from track titles", () => {
        const input = "Song Name (feat. Other Artist)";
        const result = normalizeTrackTitleForSearch(input, "aggressive");
        expect(result).not.toContain("feat.");
        expect(result).not.toContain("Other Artist");
        expect(result).toBe("Song Name");
    });

    it("should handle ft. and featuring variations", () => {
        const testCases = [
            { input: "Track Name ft. Someone", expected: "Track Name" },
            { input: "Track Name featuring Someone", expected: "Track Name" },
            { input: "Track Name (Ft. Someone)", expected: "Track Name" },
            { input: "Track Name [feat. Someone]", expected: "Track Name" },
        ];

        testCases.forEach(({ input, expected }) => {
            const result = normalizeTrackTitleForSearch(input, "aggressive");
            expect(result).toBe(expected);
        });
    });

    it("should keep minimal metadata at minimal level", () => {
        const input = "Song Name (feat. Artist) - Live Version";
        const result = normalizeTrackTitleForSearch(input, "minimal");
        // At minimal level, only unicode normalization happens
        expect(result).toContain("feat.");
        expect(result).toContain("Live");
    });
});

describe("prepareArtistForSearch", () => {
    it('should preserve "The The" band name', () => {
        expect(prepareArtistForSearch("The The")).toBe("The The");
    });

    it('should remove "The" prefix from normal artist names', () => {
        expect(prepareArtistForSearch("The Beatles")).toBe("Beatles");
        expect(prepareArtistForSearch("The Rolling Stones")).toBe("Rolling Stones");
    });

    it('should preserve single "The"', () => {
        expect(prepareArtistForSearch("The")).toBe("The");
    });

    it('should normalize ampersands to "and"', () => {
        expect(prepareArtistForSearch("Artist & Band")).toBe("Artist and Band");
    });

    it('should normalize unicode quotes', () => {
        expect(prepareArtistForSearch("Artist\u2019s Name")).toBe("Artist's Name");
        expect(prepareArtistForSearch("\u201CArtist\u201D")).toBe('"Artist"');
    });
});

describe("titleFileScore: how well a file name matches a track title in an album folder", () => {
    const score = (title: string, file: string) => titleFileScore(titleMatchKey(title), titleMatchKey(file));

    it("scores an exact title as a full match, accents and case aside", () => {
        expect(score("Sigur Rós", "sigur ros")).toBe(1);
    });

    it("scores the right Japanese file fully and a different Japanese title not at all", () => {
        expect(score("道", "道")).toBe(1);
        expect(score("道", "花束を君に")).toBe(0);
    });

    it("scores a Russian title against its own file, not another", () => {
        expect(score("Группа крови", "Группа крови")).toBe(1);
        expect(score("Группа крови", "Звезда по имени Солнце")).toBe(0);
    });

    it("gives no score when either side has no letters or digits", () => {
        expect(score("!!!", "???")).toBe(0);
        expect(score("Song", "!!!")).toBe(0);
    });

    it("matches a title stored decomposed (as macOS names files) against its usual form", () => {
        expect(score("한국", "한국".normalize("NFD"))).toBe(1);
    });
});
