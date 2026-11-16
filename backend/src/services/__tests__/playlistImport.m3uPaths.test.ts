import { caseSpellings, libraryFileNames, libraryPathReadings, longestSuffixMatches, unicodeForms } from "../playlistImport/matching/m3uPaths";

describe("unicodeForms", () => {
    it("gives the other composed or decomposed form, and nothing for text with one form", () => {
        const nfc = "Caf\u00e9";
        const nfd = "Cafe\u0301";
        expect(unicodeForms(nfc)).toEqual([nfd]);
        expect(unicodeForms(nfd)).toEqual([nfc]);
        expect(unicodeForms("plain")).toEqual([]);
    });
});

describe("caseSpellings", () => {
    it("lower-cases ASCII and gives each accented letter in both cases", () => {
        expect(caseSpellings("Ab.flac")).toEqual(["ab.flac"]);
        expect(caseSpellings("CAFÉ").sort()).toEqual(["cafÉ", "café"]);
        expect(caseSpellings("café")).toEqual(["café", "cafÉ"]);
    });

    it("keeps to a few spellings for a name with many accented letters", () => {
        const spellings = caseSpellings("ÉÉÉÉÉÉÉÉ");
        expect(spellings.length).toBeLessThanOrEqual(8);
        expect(spellings).toEqual(expect.arrayContaining(["ÉÉÉÉÉÉÉÉ", "éééééééé"]));
    });
});

describe("libraryFileNames", () => {
    it("takes the file name of the path as typed first, then of each decoded reading, once each", () => {
        expect(libraryFileNames("/x/01%20S%C3%B3ng.flac", ["/x/01%20S%C3%B3ng.flac", "/x/01 Sóng.flac"])).toEqual(["01%20S%C3%B3ng.flac", "01 Sóng.flac"]);
    });

    it("finds the file name of a backslash path", () => {
        expect(libraryFileNames("C:\\Music\\a.flac", ["C:\\Music\\a.flac", "C:/Music/a.flac"])).toEqual(["C:\\Music\\a.flac", "a.flac"]);
    });
});

describe("libraryPathReadings and an encoded slash", () => {
    it("keeps %2F inside its file name: it is not a folder", () => {
        const readings = libraryPathReadings("Artist/AC%2FDC - Hells Bells.mp3", "/music");
        expect(readings).toContain("Artist/AC%2FDC - Hells Bells.mp3");
        expect(readings.some((r) => r.includes("AC/DC"))).toBe(false);
        expect(libraryFileNames("Artist/AC%2fDC - Hells Bells.mp3", libraryPathReadings("Artist/AC%2fDC - Hells Bells.mp3", "/music"))).toEqual(["AC%2fDC - Hells Bells.mp3"]);
    });

    it("still decodes every other escape", () => {
        expect(libraryPathReadings("A/S%C3%B3ng%20x.flac", "/music")).toContain("A/Sóng x.flac");
    });
});

describe("longestSuffixMatches", () => {
    const song = (filePath: string) => ({ filePath });

    it("keeps the songs sharing the most trailing path segments with a reading", () => {
        const songs = [song("A/Album/01.flac"), song("B/Album/01.flac"), song("A/Other/01.flac")];
        expect(longestSuffixMatches(songs, ["Album/01.flac"])).toEqual([songs[0], songs[1]]);
        expect(longestSuffixMatches(songs, ["A/Album/01.flac"])).toEqual([songs[0]]);
    });

    it("counts the file name alone as one segment, whatever the folders in front of it", () => {
        const songs = [song("A/Album/01.flac"), song("B/Album/01.flac")];
        expect(longestSuffixMatches(songs, ["/elsewhere/01.flac"])).toEqual(songs);
    });

    it("does not count a leading slash, ./ or ../ as a folder", () => {
        const songs = [song("A/01.flac"), song("B/01.flac")];
        expect(longestSuffixMatches(songs, ["/01.flac"])).toEqual(songs);
        expect(longestSuffixMatches(songs, ["./01.flac"])).toEqual(songs);
        expect(longestSuffixMatches(songs, ["../01.flac"])).toEqual(songs);
    });

    it("ignores letter case and Unicode form, and takes the best of several readings", () => {
        const songs = [song("Café/x.flac"), song("Other/x.flac")];
        expect(longestSuffixMatches(songs, ["CAFE\u0301/X.FLAC"])).toEqual([songs[0]]);
        expect(longestSuffixMatches(songs, ["nothing/x.flac", "Other/x.flac"])).toEqual([songs[1]]);
    });

    it("gives nothing for no songs", () => {
        expect(longestSuffixMatches([], ["a/b.flac"])).toEqual([]);
    });
});
